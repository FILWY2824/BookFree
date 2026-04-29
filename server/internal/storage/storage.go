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
	ErrNotFound   = errors.New("storage: not found")
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
	// DeletePrefix removes everything stored under `prefix` (treated
	// as a directory: trailing "/" is added if missing). Used when a
	// book or a whole user is deleted and we need to leave nothing
	// behind on disk — neither the files nor the empty parent
	// directories. Implementations MUST refuse an empty prefix to
	// avoid a "delete everything" footgun, and MUST validate the
	// prefix the same way they validate keys (no traversal escapes).
	//
	// On the local driver this walks the subtree and removes both
	// files and empty directories bottom-up. Missing prefixes are not
	// an error — they're treated the same as "already deleted".
	DeletePrefix(ctx context.Context, prefix string) error
}

// BookKey returns the canonical storage key for a book asset. The
// `users/<user_id>/books/<book_id>/<basename>` pattern is enforced by
// the SQL trigger added in migration 0014, so getting it right here
// matters: a wrong prefix and the INSERT into book_assets aborts.
func BookKey(userID, bookID, name string) string {
	return "users/" + userID + "/books/" + bookID + "/" + name
}

// BookPrefix is the directory all of one book's assets live under.
// Used by the book-delete handler to recursively clean up so we
// don't leave empty `books/<bookID>/` shells behind. Pair with
// DeletePrefix on the Storage driver.
func BookPrefix(userID, bookID string) string {
	return "users/" + userID + "/books/" + bookID + "/"
}

// UserPrefix is everything one user owns under storage. Used by the
// user-delete path so a deleted account leaves no residue on disk.
func UserPrefix(userID string) string {
	return "users/" + userID + "/"
}
