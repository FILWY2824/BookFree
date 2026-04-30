// 中文导读：
// accounts.go 负责账号资料、用户设置或账号级别数据的后端逻辑。
// 它和 auth 包的区别是：
// - auth 更关注登录、注册、session、安全；
// - accounts 更关注登录后的账号资料管理。
// 如果你要增加用户昵称、头像、偏好设置、账号删除等功能，可能会涉及这个文件。
// 所有账号相关接口都要注意多用户隔离：用户只能看到和修改自己的数据，管理员能力要显式判断。

// Package accounts owns whole-account lifecycle operations — most
// importantly, "delete this user and leave NO residue behind".
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
// Order of operations for DeleteUser:
//
//  1. Begin a tx.
//  2. Snapshot every storage_key the user owns BEFORE any DELETE.
//     The snapshot uses `book_assets.user_id`, which migration 0014's
//     isolation triggers guarantee is set on every row. We need the
//     list before delete because ON DELETE CASCADE wipes the rows
//     our reference would otherwise come from.
//  3. DELETE FROM users — the cascade chain (users → books →
//     book_assets / chapters / chunks / progress / highlights /
//     notes / ai_provider_profiles / sessions / token rows /
//     embeddings) drops everything the user touched in one shot.
//  4. Commit.
//  5. Delete each tracked storage_key individually (so per-key
//     failures show up in the log).
//  6. Fire-and-forget Storage.DeletePrefix("users/<uid>/") to
//     mop up anything book_assets didn't track (covers stored
//     under cover_storage_key, sidecar caches, anything we add
//     later) AND to remove the now-empty directory shells. Without
//     this final pass the user's `users/<uid>/` directory persists
//     forever, accumulating fragmentation across many account
//     lifecycles.
//
// The ordering matters: DELETE FROM users → commit → file cleanup.
// If we deleted files first and the SQL failed we'd have orphan rows
// referencing missing files, which is worse than the inverse.
package accounts

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"bookfree/internal/logger"
	"bookfree/internal/storage"
)

// DeleteUser purges the user identified by `userID` and every byte
// of their data — database rows AND on-disk files — leaving no
// residue. Returns ErrNotFound if no such user exists.
//
// This is the only sanctioned path for a hard-delete; auth.Logout
// and friends only end the session.
var ErrNotFound = errors.New("accounts: user not found")

func DeleteUser(ctx context.Context, db *sql.DB, st storage.Storage, userID string) error {
	if userID == "" {
		return fmt.Errorf("accounts.DeleteUser: empty userID")
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	// Snapshot storage keys before the cascade wipes the rows.
	keys, err := snapshotStorageKeys(ctx, tx, userID)
	if err != nil {
		return fmt.Errorf("snapshot keys: %w", err)
	}

	res, err := tx.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, userID)
	if err != nil {
		return fmt.Errorf("delete users row: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	// File cleanup — best-effort, errors logged but not propagated
	// (the DB is already authoritative; files will be picked up by
	// the prefix sweep below regardless).
	for _, k := range keys {
		if err := st.Delete(ctx, k); err != nil {
			logger.Warn("accounts.delete.storage", logger.Fields{
				"userId": userID,
				"key":    k,
				"err":    err.Error(),
			})
		}
	}

	// Recursive sweep — catches book covers, sidecar caches, future
	// per-user state we may add, AND prunes the now-empty directory
	// shells. This is the step that fixes the "fragments left on
	// disk forever" complaint.
	if err := st.DeletePrefix(ctx, storage.UserPrefix(userID)); err != nil {
		logger.Warn("accounts.delete.storage.prefix", logger.Fields{
			"userId": userID,
			"prefix": storage.UserPrefix(userID),
			"err":    err.Error(),
		})
	}
	return nil
}

// snapshotStorageKeys collects every storage_key the user owns. We
// query book_assets (the mandatory tracker for every blob we write)
// AND books.cover_storage_key (which is denormalised — covers don't
// always live in book_assets). Other tables that might add file
// references in the future should be added here.
func snapshotStorageKeys(ctx context.Context, tx *sql.Tx, userID string) ([]string, error) {
	var keys []string

	rows, err := tx.QueryContext(ctx,
		`SELECT storage_key FROM book_assets WHERE user_id = ?`,
		userID)
	if err != nil {
		return nil, err
	}
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

	rows, err = tx.QueryContext(ctx,
		`SELECT cover_storage_key FROM books
		 WHERE user_id = ? AND cover_storage_key IS NOT NULL AND cover_storage_key <> ''`,
		userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		if k != "" {
			keys = append(keys, k)
		}
	}
	return keys, rows.Err()
}
