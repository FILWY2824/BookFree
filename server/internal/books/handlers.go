package books

import (
	"context"
	"database/sql"
	"net/http"

	"bookfree/internal/auth"
	"bookfree/internal/logger"
	"bookfree/internal/response"
	"bookfree/internal/storage"
)

// Handler 集中保存 books 这一组 HTTP 接口需要用到的依赖。
//
// 对初学者来说，可以把 Handler 理解成“后端接口处理器”：
// - 浏览器访问 /api/books、/api/books/{id} 等路由；
// - router.go 会把请求分发到这里的某个方法；
// - 方法内部再读取登录用户、查询数据库、调用存储层、返回 JSON。
//
// 这里不直接把依赖写成全局变量，而是放进结构体字段里，主要有三个好处：
// 1. 方便测试：测试时可以传入临时 SQLite、假的 storage；
// 2. 边界清晰：books 模块只知道自己需要 DB/Storage/配置，不关心 main.go 怎么创建它们；
// 3. 对未来 Android 友好：Android 复用的是同一套 HTTP API，这里的业务逻辑不和 Web 页面绑定。
type Handler struct {
	// DB 是 database/sql 提供的数据库连接池句柄。
	//
	// 注意：*sql.DB 不是“一个数据库连接”，而是 Go 管理的一组连接。
	// 在本项目中，连接池大小在 internal/db/db.go 里被限制得很小，
	// 这是为了满足服务端常驻内存尽量控制在 50MB 内的目标。
	DB *sql.DB

	// Storage 是文件存储抽象。
	//
	// 当前实现通常是本地文件系统，用来存放用户上传的原始书籍文件、
	// 封面、以及未来可能出现的派生文件。
	//
	// 这里使用 interface 而不是直接依赖某个本地目录，是为了以后可以替换成
	// 其他存储实现，例如对象存储；Handler 的业务代码不需要大改。
	Storage storage.Storage

	// IsProd 表示当前是否是生产环境。
	//
	// response.FailSafe 会根据这个值决定是否向前端隐藏真实错误细节。
	// 生产环境不应把 SQL 错误、文件路径等敏感信息直接暴露给用户。
	IsProd bool

	// MaxUploadMB 是最大上传大小，具体在 upload.go 的 maxUploadBytes 中使用。
	// 这个字段也放在 books.Handler 上，是因为“上传书籍”属于 books 模块的一部分。
	MaxUploadMB int
}

// HandleList 处理：GET /api/books
//
// 作用：返回当前登录用户自己的书籍列表。
//
// 请求链路大致是：
// 1. 前端 LibraryPage 加载书架时调用 GET /api/books；
// 2. 后端 auth.RequireUser 中间件先验证 session cookie；
// 3. 验证通过后，用户信息被放入 request context；
// 4. 本函数从 context 取出用户 ID；
// 5. 调用 store.go 里的 ListByUser 查询数据库；
// 6. 使用统一 JSON 信封返回给前端。
//
// 这里非常重要的一点是：查询必须按 user.ID 过滤。
// BookFree 是多用户系统，任何列表/详情/删除接口都不能只按 bookID 查询，
// 否则用户 A 可能看到用户 B 的书。
func (h *Handler) HandleList(w http.ResponseWriter, r *http.Request) {
	// UserFromContext 依赖认证中间件提前把用户信息写入 context。
	// 因此这个 handler 应该只挂在 RequireUser 保护过的路由下面。
	user := auth.UserFromContext(r.Context())

	// ListByUser 是 books 模块的数据访问函数。
	// 它只返回 user.ID 名下的书，并按创建时间倒序排列。
	books, err := ListByUser(r.Context(), h.DB, user.ID)
	if err != nil {
		// FailSafe 用于“内部错误但不要泄露敏感细节”的场景。
		// 在开发环境可能看到更具体错误；生产环境只返回通用错误。
		response.FailSafe(w, "books.list", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	// 所有 API 都尽量使用统一响应结构：
	// { "ok": true, "data": { "books": [...] }, "error": null }
	// 前端 lib/api.ts 正是按这个结构解析响应。
	response.OK(w, map[string]any{"books": books})
}

// HandleGet 处理：GET /api/books/{id}
//
// 作用：返回当前登录用户拥有的某一本书的元数据。
//
// 这个接口通常由 ReaderPage 使用：
// - 用户点击书架上的 BookCard；
// - 前端路由跳转到 /book/:id；
// - ReaderPage 调用 GET /api/books/{id} 获取标题、格式、状态等信息；
// - 再根据格式决定渲染 TxtReader/EpubReader/PdfReader/CbzReader。
func (h *Handler) HandleGet(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())

	// Go 1.22 的 ServeMux 支持在路由中写 {id}，
	// 然后在 handler 中通过 r.PathValue("id") 读取路径参数。
	id := r.PathValue("id")
	if id == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 id")
		return
	}

	// FindByID 内部会同时使用 bookID 和 userID 查询。
	// 这样即使有人猜到了别人的 bookID，也查不到不属于自己的书。
	book, err := FindByID(r.Context(), h.DB, user.ID, id)
	if err != nil {
		response.FailSafe(w, "books.get", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	if book == nil {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
		return
	}

	response.OK(w, map[string]any{"book": book})
}

// HandleDelete 处理：DELETE /api/books/{id}
//
// 作用：删除一本书，以及它关联的数据库记录和存储文件。
//
// 删除一本书不只是 DELETE books 这么简单。BookFree 至少有两类数据：
// 1. 数据库数据：books、book_assets、book_chapters、book_chunks、reading_progress、notes 等；
// 2. 文件数据：用户上传的原始文件、封面、未来可能生成的缓存文件。
//
// 本函数采用的顺序是：
// 1. 在数据库事务中找到这本书对应的 storage_key；
// 2. 删除 books 行，依靠数据库外键级联删除章节、chunks、进度、笔记等依赖行；
// 3. 提交事务；
// 4. 事务提交成功后，再异步删除磁盘/对象存储里的文件。
//
// 为什么不能先删文件再删数据库？
// - 如果先删文件，但后面数据库事务失败，数据库仍然显示书存在，文件却没了；
// - 用户会看到一条无法打开的“坏书籍记录”。
// 所以这里优先保证数据库状态正确，再做文件清理。
//
// 为什么文件删除放到后台 goroutine？
// - 大书、远程存储、慢磁盘都可能导致删除耗时；
// - 用户点击删除后，前端更关心“书架记录已经消失”；
// - 文件清理失败可以写日志，后续再排查，不应阻塞 HTTP 响应。
//
// 这也是一个低内存友好的设计：
// - 删除时不把文件读入内存；
// - 只传递 storage key 字符串；
// - 后台逐个删除文件。
func (h *Handler) HandleDelete(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	id := r.PathValue("id")
	if id == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 id")
		return
	}

	// Delete 位于 store.go：
	// - 负责数据库事务；
	// - 返回 ok=false 表示没有这本书；
	// - 返回 keys 表示这本书关联的存储文件路径，供后续清理文件使用。
	ok, keys, err := Delete(r.Context(), h.DB, user.ID, id)
	if err != nil {
		response.FailSafe(w, "books.delete", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	if !ok {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
		return
	}

	// 文件删除放在后台执行，避免磁盘 I/O 阻塞用户请求。
	//
	// 注意这里不直接使用 r.Context()：
	// - HTTP 响应写回后，请求 context 很快就会被取消；
	// - 如果用 r.Context() 删除文件，可能刚开始删就被取消；
	// - 因此 dropStorageKeys 内部使用 context.Background()。
	go h.dropStorageKeys(keys, user.ID, id)

	// assetCount 返回给前端或调试者，用来知道本次删除涉及多少个已记录文件。
	response.OK(w, map[string]any{"deleted": true, "assetCount": len(keys)})
}

// dropStorageKeys 删除一本书对应的存储文件和目录前缀。
//
// 这个函数只做“尽力而为”的清理：
// - 删除失败不会回滚数据库，因为数据库事务已经提交；
// - 失败会写入日志，便于管理员排查磁盘残留；
// - 不向用户返回错误，因为 HTTP 响应已经在 HandleDelete 中发出。
func (h *Handler) dropStorageKeys(keys []string, userID, bookID string) {
	// 使用独立 context，原因见 HandleDelete 中的说明。
	ctx := context.Background()

	// 第一轮：按数据库中记录的 storage_key 逐个删除。
	//
	// 即使后面还会调用 DeletePrefix，这里仍然逐个删有两个好处：
	// 1. 单个文件失败时可以记录具体 key，日志更容易定位问题；
	// 2. 未来如果 Storage 换成 S3 等对象存储，DeletePrefix 未必是一个真正原子操作。
	for _, k := range keys {
		if err := h.Storage.Delete(ctx, k); err != nil {
			logger.Warn("books.delete.storage", logger.Fields{
				"userId": userID,
				"bookId": bookID,
				"key":    k,
				"err":    err.Error(),
			})
		}
	}

	// 第二轮：删除整本书的目录前缀。
	//
	// storage.BookPrefix(userID, bookID) 通常类似：
	// users/<uid>/books/<bid>/
	//
	// 为什么还要 DeletePrefix？
	// - 有些文件可能没有进入 book_assets 表，例如临时封面、边车缓存；
	// - 如果只删已知 keys，目录空壳可能残留；
	// - 长期运行后会形成大量碎片目录，增加后续迁移和备份成本。
	prefix := storage.BookPrefix(userID, bookID)
	if err := h.Storage.DeletePrefix(ctx, prefix); err != nil {
		logger.Warn("books.delete.storage.prefix", logger.Fields{
			"userId": userID,
			"bookId": bookID,
			"prefix": prefix,
			"err":    err.Error(),
		})
	}
}
