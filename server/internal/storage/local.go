package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Local is a filesystem-backed Storage rooted at a directory the
// operator owns. Keys are joined with the root using filepath.Join
// after a strict syntactic validation — the validation is the
// filesystem-traversal defence, NOT filepath.Clean alone (Clean
// happily resolves "users/foo/../../etc/passwd" to "etc/passwd",
// which we definitely do not want).
type Local struct {
	root string
}

func NewLocal(root string) (*Local, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, err
	}
	return &Local{root: abs}, nil
}

// resolve turns a logical key into an absolute filesystem path while
// rejecting anything that could escape the root.
func (l *Local) resolve(key string) (string, error) {
	if key == "" {
		return "", ErrInvalidKey
	}
	if strings.ContainsAny(key, "\\") {
		return "", ErrInvalidKey
	}
	for _, seg := range strings.Split(key, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return "", ErrInvalidKey
		}
	}
	full := filepath.Join(l.root, filepath.FromSlash(key))
	// Belt + braces: even after the segment check, ensure the resolved
	// path is still inside the root. This catches platform-specific
	// surprises (Windows drive letters, NUL bytes, etc.).
	rel, err := filepath.Rel(l.root, full)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", ErrInvalidKey
	}
	return full, nil
}

func (l *Local) Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error {
	full, err := l.resolve(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	// Write to a sibling .tmp file then rename, so a partial upload
	// never leaves a half-written object visible to readers.
	tmp := full + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	// We use the io.Copy buffer (32 KiB default) so peak per-upload
	// memory stays bounded regardless of file size — that's the whole
	// point of the streaming-upload contract in the migration plan.
	n, copyErr := io.Copy(f, r)
	closeErr := f.Close()
	if copyErr != nil {
		_ = os.Remove(tmp)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(tmp)
		return closeErr
	}
	if size > 0 && n != size {
		_ = os.Remove(tmp)
		return fmt.Errorf("storage.local: short write: got %d, want %d", n, size)
	}
	return os.Rename(tmp, full)
}

func (l *Local) Open(ctx context.Context, key string) (Reader, ObjectInfo, error) {
	full, err := l.resolve(key)
	if err != nil {
		return nil, ObjectInfo{}, err
	}
	f, err := os.Open(full)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ObjectInfo{}, ErrNotFound
		}
		return nil, ObjectInfo{}, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, ObjectInfo{}, err
	}
	etag := weakETag(info.ModTime().UnixNano(), info.Size())
	return f, ObjectInfo{
		Size:    info.Size(),
		ModTime: info.ModTime(),
		ETag:    etag,
	}, nil
}

func (l *Local) Stat(ctx context.Context, key string) (ObjectInfo, error) {
	full, err := l.resolve(key)
	if err != nil {
		return ObjectInfo{}, err
	}
	info, err := os.Stat(full)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ObjectInfo{}, ErrNotFound
		}
		return ObjectInfo{}, err
	}
	return ObjectInfo{
		Size:    info.Size(),
		ModTime: info.ModTime(),
		ETag:    weakETag(info.ModTime().UnixNano(), info.Size()),
	}, nil
}

func (l *Local) Delete(ctx context.Context, key string) error {
	full, err := l.resolve(key)
	if err != nil {
		return err
	}
	if err := os.Remove(full); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (l *Local) Exists(ctx context.Context, key string) (bool, error) {
	full, err := l.resolve(key)
	if err != nil {
		return false, err
	}
	_, err = os.Stat(full)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, err
}

func weakETag(modUnixNano, size int64) string {
	h := sha256.Sum256([]byte(fmt.Sprintf("%d:%d", modUnixNano, size)))
	return `W/"` + hex.EncodeToString(h[:8]) + `"`
}
