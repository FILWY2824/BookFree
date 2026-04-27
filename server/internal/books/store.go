// Package books owns the /api/books/* surface, the DAL backing it,
// and the streaming upload pipeline. Per the migration plan §10.2,
// the upload path must NOT buffer the request body — it streams from
// req.Body straight to the storage driver.
package books

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"bookfree/internal/models"
)

func rowToBook(
	id, title, authorsJSON string,
	language, publisher, coverKey, errorMsg sql.NullString,
	format, status string,
	sizeBytes, createdAt, updatedAt int64,
) models.Book {
	var authors []string
	if authorsJSON != "" {
		if err := json.Unmarshal([]byte(authorsJSON), &authors); err != nil || authors == nil {
			authors = []string{authorsJSON}
		}
	}
	b := models.Book{
		ID:        id,
		Title:     title,
		Authors:   authors,
		Format:    format,
		SizeBytes: sizeBytes,
		Status:    status,
		CreatedAt: createdAt,
		UpdatedAt: updatedAt,
	}
	if language.Valid {
		b.Language = &language.String
	}
	if publisher.Valid {
		b.Publisher = &publisher.String
	}
	if coverKey.Valid {
		b.CoverStorageKey = &coverKey.String
	}
	if errorMsg.Valid {
		b.Error = &errorMsg.String
	}
	return b
}

// ListByUser returns the user's books ordered newest-first.
func ListByUser(ctx context.Context, db *sql.DB, userID string) ([]models.Book, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT id, title, authors, language, publisher, cover_storage_key,
		       format, size_bytes, status, error, created_at, updated_at
		FROM books
		WHERE user_id = ?
		ORDER BY created_at DESC
		LIMIT 1000
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]models.Book, 0, 32)
	for rows.Next() {
		var (
			id, title, authors, format, status string
			lang, pub, cover, errMsg           sql.NullString
			size, created, updated             int64
		)
		if err := rows.Scan(&id, &title, &authors, &lang, &pub, &cover,
			&format, &size, &status, &errMsg, &created, &updated); err != nil {
			return nil, err
		}
		out = append(out, rowToBook(id, title, authors, lang, pub, cover, errMsg,
			format, status, size, created, updated))
	}
	return out, rows.Err()
}

// FindByID returns one book scoped to the requesting user.
func FindByID(ctx context.Context, db *sql.DB, userID, bookID string) (*models.Book, error) {
	row := db.QueryRowContext(ctx, `
		SELECT id, title, authors, language, publisher, cover_storage_key,
		       format, size_bytes, status, error, created_at, updated_at
		FROM books
		WHERE id = ? AND user_id = ?
		LIMIT 1
	`, bookID, userID)

	var (
		id, title, authors, format, status string
		lang, pub, cover, errMsg           sql.NullString
		size, created, updated             int64
	)
	if err := row.Scan(&id, &title, &authors, &lang, &pub, &cover,
		&format, &size, &status, &errMsg, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	b := rowToBook(id, title, authors, lang, pub, cover, errMsg,
		format, status, size, created, updated)
	return &b, nil
}

// listAssetKeys returns every storage_key recorded against this book.
// We collect keys BEFORE the DELETE so that ON DELETE CASCADE doesn't
// erase our reference list.
func listAssetKeys(ctx context.Context, tx *sql.Tx, userID, bookID string) ([]string, error) {
	rows, err := tx.QueryContext(ctx,
		`SELECT storage_key FROM book_assets WHERE book_id = ? AND user_id = ?`,
		bookID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var keys []string
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

// Delete removes a book row + all dependent rows via cascade. Returns
// the list of storage keys that were attached so the caller can drop
// them from the storage driver. (Audit P1-04: previous version left
// the original file on disk forever.)
//
// `ok` is false when no row matched (404 condition); the keys slice is
// nil in that case.
func Delete(ctx context.Context, db *sql.DB, userID, bookID string) (ok bool, keys []string, err error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return false, nil, err
	}
	defer tx.Rollback() //nolint:errcheck — Commit() makes Rollback a no-op.

	keys, err = listAssetKeys(ctx, tx, userID, bookID)
	if err != nil {
		return false, nil, err
	}

	res, err := tx.ExecContext(ctx,
		`DELETE FROM books WHERE id = ? AND user_id = ?`,
		bookID, userID)
	if err != nil {
		return false, nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return false, nil, nil
	}
	if err := tx.Commit(); err != nil {
		return false, nil, err
	}
	return true, keys, nil
}
