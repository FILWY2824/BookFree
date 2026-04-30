// 中文导读：
// accounts.go 负责“账号级生命周期”相关的后端逻辑，当前最核心的能力是：
// 彻底删除一个用户账号，并尽可能清理该用户在数据库和磁盘上的所有残留数据。
//
// 它和 auth 包的区别是：
//   - auth 更关注登录、注册、session、安全中间件等“认证流程”；
//   - accounts 更关注登录后的账号级操作，尤其是会影响整个用户数据生命周期的能力；
//   - 当一个操作需要跨 books、assets、notes、sessions、AI 配置等多个模块统一收口时，
//     放在 accounts 包中比散落在各业务包里更安全、更容易维护。
//
// 如果后续要增加用户昵称、头像、偏好设置、账号删除、账号导出等能力，可能会涉及这个文件。
// 所有账号相关接口都要注意多用户隔离：用户只能看到和修改自己的数据，管理员能力要显式判断。

// Package accounts owns whole-account lifecycle operations — most
// importantly, "delete this user and leave NO residue behind".
//
// 中文说明：accounts 包负责账号整体生命周期操作，尤其是“硬删除用户并清理残留数据”。
// 用户删除不是简单删除 users 表中的一行，因为 BookFree 中一个用户可能拥有：
//   - books 表中的书籍记录；
//   - book_assets 表中的原始文件、解析产物或其他二进制资源；
//   - chapters、chunks、embeddings 等阅读和检索数据；
//   - progress、highlights、notes 等阅读状态和用户沉淀；
//   - sessions、token、AI provider 配置等账号级数据；
//   - storage 中 users/<uid>/ 目录下的实际文件。
//
// 因此，这类跨模块清理逻辑集中在 accounts 包中，避免每个业务包各自删除一部分，
// 从而导致未来新增表或新增文件布局时遗漏清理路径。
//
// Why this lives in its own package instead of being scattered across
// auth/ and books/:
//
//	The user explicitly called out that prior deletions left fragments
//	on disk (per-book directory shells, the user's `users/<uid>/`
//	parent directory, the original-file blobs that books.Delete
//	missed when its `book_assets` query came up empty). When deletion
//	logic is split across multiple packages each handling "their"
//	tables, it's easy for one new piece of state (a new table, a new
//	storage layout) to ship without anyone updating the cleanup path.
//	Concentrating it here gives us ONE place to update next time we
//	add a per-user data sink.
//
// DeleteUser 的操作顺序：
//
//  1. 开启数据库事务。
//     这样可以保证数据库侧删除过程具备原子性：要么删除链条成功提交，要么失败回滚。
//
//  2. 在任何 DELETE 之前，先快照该用户拥有的所有 storage_key。
//     这些 key 来自 book_assets.user_id 以及 books.cover_storage_key。
//     必须先查再删，因为 users 删除后会触发 ON DELETE CASCADE，相关行会被级联删除，
//     如果等删除之后再查，就已经找不到这些文件引用了。
//
//  3. 执行 DELETE FROM users。
//     依赖数据库外键级联删除用户关联数据，例如：
//     books、book_assets、chapters、chunks、progress、highlights、notes、
//     ai_provider_profiles、sessions、token rows、embeddings 等。
//     这种方式比在 Go 代码中逐表删除更集中、更不容易漏表。
//
//  4. 提交事务。
//     只有数据库删除确认成功后，才开始清理磁盘文件。
//
//  5. 逐个删除前面快照到的 storage_key。
//     逐个删除的好处是：某个文件删除失败时，可以在日志里看到具体 key，方便定位。
//
//  6. 最后执行 Storage.DeletePrefix("users/<uid>/")。
//     这是兜底清理：用于删除未被 book_assets 追踪到的封面、副产物、未来新增缓存，
//     以及用户目录下可能留下的空目录壳。
//
// 顺序非常重要：先数据库删除并提交，再清理文件。
// 如果先删文件而 SQL 事务失败，就会留下“数据库记录指向不存在文件”的坏状态；
// 反过来，如果数据库已删除但文件清理失败，至少数据库作为权威状态是干净的，
// 后续可以通过日志或前缀清理再次补偿。
package accounts

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"bookfree/internal/logger"
	"bookfree/internal/storage"
)

// ErrNotFound 表示要删除的用户不存在。
//
// DeleteUser 在执行 DELETE FROM users 后会检查 RowsAffected：
//   - 如果影响行数为 0，说明数据库中没有该 userID；
//   - 此时返回 ErrNotFound，方便上层 handler 映射为 404 或合适的业务响应。
//
// 使用包级哨兵错误的好处是：调用方可以通过 errors.Is 或直接比较来识别该场景，
// 而不是依赖错误字符串。
var ErrNotFound = errors.New("accounts: user not found")

// DeleteUser 彻底删除指定用户及其数据。
//
// 参数说明：
//   - ctx：请求上下文，用于控制数据库查询、删除和存储清理的取消/超时；
//   - db：数据库连接池，用于开启事务并删除 users 行；
//   - st：抽象存储接口，用于删除磁盘或对象存储中的用户文件；
//   - userID：要删除的用户 ID。
//
// 删除范围：
//   - 数据库：通过 DELETE FROM users 触发外键级联删除用户关联记录；
//   - 文件：先删除已快照的 storage_key，再用 users/<uid>/ 前缀做兜底清理。
//
// 返回值：
//   - userID 为空：返回参数错误；
//   - 用户不存在：返回 ErrNotFound；
//   - 数据库快照、删除或提交失败：返回包装后的错误；
//   - 文件删除失败：只记录 warn 日志，不中断返回。
//
// 为什么文件删除失败不返回错误：
// 数据库事务提交后，用户在系统权威数据中已经不存在。
// 如果此时因为文件系统权限、短暂 IO 问题等导致个别文件删除失败，
// 再向上返回错误无法回滚数据库，反而容易让调用方误解账号仍然存在。
// 因此这里采用 best-effort 清理并记录日志，后续可通过运维或补偿任务处理。
//
// 内存与性能说明：
// 该函数不会把用户所有书籍内容读入内存，只收集文件 key 字符串列表。
// 对自托管轻量服务来说，这比加载大文档或建立常驻索引更符合低内存约束。
// 若未来单用户拥有极大量 assets，可考虑把 snapshot + delete 改为分页/流式处理。
// ctx context.Context：Go 里用来控制请求生命周期的上下文
func DeleteUser(ctx context.Context, db *sql.DB, st storage.Storage, userID string) error {
	// 空 userID 是调用方参数错误，直接拒绝，避免误删或执行无意义 SQL。
	if userID == "" {
		return fmt.Errorf("accounts.DeleteUser: empty userID")
	}

	// 开启事务，确保数据库层面的删除链条具备一致性。
	// 这里使用默认事务选项即可；具体隔离级别由 SQLite/驱动默认行为决定。
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}

	// 兜底回滚：
	// - 如果后续任何步骤在 Commit 前返回错误，事务会被回滚；
	// - 如果 Commit 已经成功，再调用 Rollback 会返回错误，这里显式忽略。
	defer tx.Rollback() //nolint:errcheck

	// 在级联删除发生之前先快照文件 key。
	// 一旦 DELETE FROM users 成功，book_assets 等关联行可能被级联删除，
	// 届时就无法再从数据库中恢复这些待删除文件的 storage_key。
	keys, err := snapshotStorageKeys(ctx, tx, userID)
	if err != nil {
		return fmt.Errorf("snapshot keys: %w", err)
	}

	// 删除 users 表中的用户行。
	// 数据库外键的 ON DELETE CASCADE 负责清理该用户关联的多张业务表。
	res, err := tx.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, userID)
	if err != nil {
		return fmt.Errorf("delete users row: %w", err)
	}

	// 检查实际删除行数，用于区分“删除成功”和“用户不存在”。
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}

	// 提交数据库事务。
	// 只有提交成功后才进入文件清理阶段，避免出现数据库回滚但文件已删除的状态。
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	// 文件清理采用 best-effort 策略：
	// 对快照阶段拿到的每个 storage_key 逐个删除。
	// 如果某个 key 删除失败，记录 warn 日志并继续处理下一个 key。
	for _, k := range keys {
		if err := st.Delete(ctx, k); err != nil {
			logger.Warn("accounts.delete.storage", logger.Fields{
				"userId": userID,
				"key":    k,
				"err":    err.Error(),
			})
		}
	}

	// 前缀兜底清理：
	// 删除 users/<uid>/ 下剩余的所有内容，包括：
	//   - book_assets 未追踪到的封面或副产物；
	//   - 未来新增的用户级缓存或 sidecar 文件；
	//   - 已经变空但仍残留的目录壳。
	//
	// 这一步是修复“删除账号后磁盘碎片长期残留”问题的关键。
	if err := st.DeletePrefix(ctx, storage.UserPrefix(userID)); err != nil {
		logger.Warn("accounts.delete.storage.prefix", logger.Fields{
			"userId": userID,
			"prefix": storage.UserPrefix(userID),
			"err":    err.Error(),
		})
	}

	return nil
}

// snapshotStorageKeys 收集指定用户拥有的所有文件 storage_key。
//
// 为什么需要单独函数：
//   - DeleteUser 的主流程更清晰：先快照、再删库、再删文件；
//   - 未来新增其他带文件引用的表时，只需要扩展这里；
//   - 便于后续单独为“文件引用收集逻辑”添加测试。
//
// 当前收集来源：
//  1. book_assets.storage_key
//     book_assets 是当前写入 blob 文件时的主要追踪表，按 user_id 过滤。
//  2. books.cover_storage_key
//     封面 key 是反规范化字段，不一定总能在 book_assets 中找到，
//     因此需要额外从 books 表中收集。
//
// 注意：
// 该函数必须在 users 删除之前、同一个事务中调用。
// 如果未来新增了其他直接保存文件 key 的表，也应在这里加入查询。
func snapshotStorageKeys(ctx context.Context, tx *sql.Tx, userID string) ([]string, error) {
	// keys 只保存文件定位字符串，不读取文件内容，因此内存占用通常很小。
	var keys []string

	// 第一类：从 book_assets 表收集用户拥有的所有资产文件 key。
	rows, err := tx.QueryContext(ctx,
		`SELECT storage_key FROM book_assets WHERE user_id = ?`,
		userID)
	if err != nil {
		return nil, err
	}

	// 遍历查询结果。这里不能 defer rows.Close 后立刻复用 rows 变量查询下一组数据，
	// 因此在遍历结束后显式 Close，并检查 Close 返回值。
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			rows.Close()
			return nil, err
		}
		if k != "" {
			keys = append(keys, k)
		}
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	// 第二类：从 books 表额外收集封面文件 key。
	// cover_storage_key 可能为空或 NULL，因此 SQL 中直接过滤无效值。
	rows, err = tx.QueryContext(ctx,
		`SELECT cover_storage_key FROM books
		 WHERE user_id = ? AND cover_storage_key IS NOT NULL AND cover_storage_key <> ''`,
		userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// 追加封面 key。这里不去重：
	// - 正常情况下 key 不应大量重复；
	// - 即使重复，Delete/DeletePrefix 的幂等或失败日志也比引入额外 map 更简单；
	// - 对低内存目标来说，避免不必要的常驻结构更合适。
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		if k != "" {
			keys = append(keys, k)
		}
	}

	// rows.Err 用于捕获遍历过程中发生的延迟错误。
	return keys, rows.Err()
}
