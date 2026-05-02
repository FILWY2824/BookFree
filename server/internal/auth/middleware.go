// 中文导读：
// 本文件集中定义认证中间件与请求上下文中的用户传递方式。
// 认证链路分为两层：
//  1. 会话加载层：从请求携带的会话凭证中解析当前用户，并写入请求上下文。
//  2. 权限保护层：根据上下文中是否存在用户、用户是否具备管理员角色，决定是否放行请求。
// 这种拆分可以让公开接口和受保护接口共用同一套会话解析逻辑：
// 公开接口即使没有登录也可以继续执行；私有接口再通过强制登录或管理员校验拦截访问。
// 对书籍、笔记、阅读进度、搜索、人工智能配置等涉及用户私有数据的接口，通常应叠加登录校验。

package auth

import (
	"context"
	"net/http"

	"bookfree/internal/models"
	"bookfree/internal/response"
)

// ctxKey 是认证包内部专用的上下文键类型。
// 使用一个私有空结构体类型，而不是直接使用字符串，可以避免其他包使用相同字符串键时发生冲突。
// 空结构体本身不携带数据，作为键使用时几乎没有额外内存负担，适合在请求级上下文中保存轻量标记。
type ctxKey struct{}

// userCtxKey 是当前登录用户在请求上下文中的唯一键。
// 它只在本包内创建和使用，外部代码必须通过 WithUser 写入用户，通过 UserFromContext 读取用户。
// 这样可以把上下文存取细节封装起来，避免业务处理器直接依赖底层键值实现。
var userCtxKey = ctxKey{}

// WithUser 将已经解析出的用户对象写入请求上下文。
// 会话加载中间件在确认会话有效后调用它，后续的处理器或权限中间件再通过 UserFromContext 获取用户。
// 这里不会复制用户对象，只保存指针；用户对象生命周期由一次请求负责，避免在中间件中引入额外缓存或全局状态。
// parent 参数通常来自 r.Context()，返回的新上下文需要通过 r.WithContext 重新挂回请求。
func WithUser(parent context.Context, u *models.User) context.Context {
	return context.WithValue(parent, userCtxKey, u)
}

// UserFromContext 从请求上下文中读取当前用户。
// 如果请求没有携带有效会话，或者还没有经过 LoadSession 中间件处理，则返回 nil。
// 对必须登录的接口，不应只调用本函数后自行忽略 nil，而应在路由层叠加 RequireUser 或 RequireAdmin。
// 本函数主要用于两类场景：
//  1. 权限中间件读取用户并判断是否允许继续访问。
//  2. 可选登录接口在用户已登录时提供个性化数据，未登录时仍允许匿名访问。
func UserFromContext(ctx context.Context) *models.User {
	u, _ := ctx.Value(userCtxKey).(*models.User)
	return u
}

// LoadSession 返回一个会话加载中间件。
// 它负责从请求的会话凭证中查找当前用户，并在查找成功时把用户写入请求上下文。
// 这个中间件只做“识别用户”，不做“强制拦截”：
//  1. 没有会话凭证时，请求会继续以匿名身份进入后续处理。
//  2. 会话凭证无效或查不到用户时，请求也会继续以匿名身份进入后续处理。
//  3. 只有后续叠加 RequireUser 或 RequireAdmin 的接口，才会真正返回未登录或无权限错误。
//
// 这种设计让公开接口、健康检查接口和可选登录接口可以复用会话识别能力，而不必为登录态和匿名态维护两套路由。
// s 参数是认证会话存储，提供会话凭证名称和会话到用户的查询能力。
func LoadSession(s *Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			c, err := r.Cookie(s.CookieName())
			if err != nil || c.Value == "" {
				next.ServeHTTP(w, r)
				return
			}
			user, err := s.Lookup(r.Context(), c.Value)
			if err != nil {
				// 查询会话时发生存储层错误时，不直接把整个请求判定为服务端错误。
				// 原因是当前请求可能访问的是公开接口，例如健康检查或公开资源。
				// 此处选择降级为匿名请求继续执行，由后续权限中间件决定是否需要拒绝访问。
				// 这样可以减少一次会话存储短暂异常对公开接口可用性的影响。
				next.ServeHTTP(w, r)
				return
			}
			if user != nil {
				r = r.WithContext(WithUser(r.Context(), user))
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireUser 是强制登录中间件。
// 它要求请求上下文中必须已经存在当前用户，因此通常应放在 LoadSession 之后使用。
// 如果用户不存在，说明请求未登录、会话过期或会话无效，此时直接返回 401，并且不再调用后续处理器。
// 所有读取或修改用户私有数据的接口，都应使用它作为最小权限保护。
func RequireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if UserFromContext(r.Context()) == nil {
			response.Fail(w, http.StatusUnauthorized, response.CodeUnauthorized, "请先登录")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireAdmin 是管理员权限中间件。
// 它先复用 RequireUser 完成登录校验，再检查当前用户是否具备管理员角色。
// 如果未登录，会由 RequireUser 返回 401；如果已登录但不是管理员，则返回 403。
// 这种分层写法可以避免重复实现登录校验逻辑，并让普通登录接口和管理员接口的权限边界保持一致。
// 仅管理后台、系统配置、用户管理等需要更高权限的接口应使用它。
func RequireAdmin(next http.Handler) http.Handler {
	return RequireUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u := UserFromContext(r.Context())
		if !u.IsAdmin() {
			response.Fail(w, http.StatusForbidden, response.CodeForbidden, "需要管理员权限")
			return
		}
		next.ServeHTTP(w, r)
	}))
}
