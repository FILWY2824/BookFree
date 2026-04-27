// Package storage abstracts where book files live. The migration plan
// §7.5 requires Range support for the PDF reader and a key prefix of
// `users/<user_id>/books/<book_id>/...` enforced by trigger 0014.
//
// Right now only a local-filesystem driver exists. An S3 driver would
// satisfy the same interface; that's a Phase 12+ concern.
package storage

import (
	"context"
	"errors"
	"io"
	"time"
)

var (
	ErrNotFound  = errors.New("storage: not found")
	ErrInvalidKey = errors.New("storage: invalid key")
)

// ObjectInfo carries enough metadata for the file handler to set
// HTTP headers (Content-Length, Last-Modified, ETag) without a
// second filesystem stat round-trip.
type ObjectInfo struct {
	Size        int64
	ContentType string
	ModTime     time.Time
	ETag        string
}

// Reader extends io.ReadCloser with optional ReadSeeker so the HTTP
// Range handler can use http.ServeContent directly when the driver
// supports seeking. Local FS does; S3 with byte-range GETs technically
// does too but pretending it's an io.ReadSeeker is more trouble than
// it's worth — that driver will provide its own range fetcher.
type Reader interface {
	io.ReadSeekCloser
}

// Storage is the contract every driver must satisfy.
type Storage interface {
	Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error
	Open(ctx context.Context, key string) (Reader, ObjectInfo, error)
	Stat(ctx context.Context, key string) (ObjectInfo, error)
	Delete(ctx context.Context, key string) error
	Exists(ctx context.Context, key string) (bool, error)
}

// BookKey returns the canonical storage key for a book asset. The
// `users/<user_id>/books/<book_id>/<basename>` pattern is enforced by
// the SQL trigger added in migration 0014, so getting it right here
// matters: a wrong prefix and the INSERT into book_assets aborts.
func BookKey(userID, bookID, name string) string {
	return "users/" + userID + "/books/" + bookID + "/" + name
}
