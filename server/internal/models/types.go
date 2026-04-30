// 中文导读：
// models/types.go 放后端多个模块共享的数据结构。
// 这些结构体通常代表 Book、Chapter、Note、User 等业务对象，或者 API 响应中的公共类型。
// 共享模型要尽量稳定，因为 Web 前端和未来 Android 客户端都会依赖这些字段含义。
// 如果你想给书籍新增一个字段，例如 cover_url、language、author，通常要同时考虑：
// 1. 数据库迁移；
// 2. store/handler 查询和写入；
// 3. API JSON 字段；
// 4. 前端 TypeScript 类型与页面展示。

package models

// User mirrors what the legacy DAL's rowToUser() produced. JSON tags
// are the camelCase the existing frontend already consumes.
type User struct {
	ID             string  `json:"id"`
	Email          string  `json:"email"`
	Name           string  `json:"name"`
	AvatarURL      *string `json:"avatarUrl,omitempty"`
	Role           string  `json:"role"`
	Status         string  `json:"status"`
	OAuthProvider  *string `json:"oauthProvider,omitempty"`
	OAuthSub       *string `json:"oauthSub,omitempty"`
	CanUseSystemAI bool    `json:"canUseSystemAi"`
	CreatedAt      int64   `json:"createdAt"`
	UpdatedAt      int64   `json:"updatedAt"`
}

func (u *User) IsAdmin() bool { return u != nil && u.Role == "admin" }
func (u *User) IsActive() bool {
	return u != nil && (u.Status == "" || u.Status == "active")
}

// Book is the row shape /api/books returns. Mirrors the legacy DAL's
// listBooksByUser output, including the `authors` array and any
// progress fields the legacy code hydrated. The frontend reads these
// names today; do not rename without coordinating with the SPA layer.
type Book struct {
	ID              string   `json:"id"`
	Title           string   `json:"title"`
	Authors         []string `json:"authors"`
	Language        *string  `json:"language,omitempty"`
	Publisher       *string  `json:"publisher,omitempty"`
	CoverStorageKey *string  `json:"coverStorageKey,omitempty"`
	Format          string   `json:"format"`
	SizeBytes       int64    `json:"sizeBytes"`
	Status          string   `json:"status"`
	Error           *string  `json:"error,omitempty"`
	CreatedAt       int64    `json:"createdAt"`
	UpdatedAt       int64    `json:"updatedAt"`
}

// BookChapter is what /api/books/:id/chapters/list returns per chapter.
type BookChapter struct {
	ID    string  `json:"id"`
	Ord   int     `json:"ord"`
	Title *string `json:"title,omitempty"`
	Href  *string `json:"href,omitempty"`
}
