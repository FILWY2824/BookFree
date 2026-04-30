// Package response 负责统一后端 API 的 JSON 响应格式。
//
// 对 Go 和前端都不太熟悉时，这个包非常关键，因为它定义了
// “后端 handler 返回什么格式，前端 api.ts 又如何理解这个格式”。
//
// BookFree 后端所有普通 API 都尽量返回同一种 envelope（信封）结构：
//
//	成功：
//	{
//	  "ok": true,
//	  "data": { ... },
//	  "error": null
//	}
//
//	失败：
//	{
//	  "ok": false,
//	  "data": null,
//	  "error": {
//	    "code": "VALIDATION",
//	    "message": "请求参数不正确",
//	    "details": ...
//	  }
//	}
//
// 为什么要统一响应格式？
// 1. 前端不用为每个接口写不同的错误解析逻辑；
// 2. 登录过期、权限不足、参数错误、内部错误可以用统一 code 判断；
// 3. 未来 Android 客户端也可以复用同一套 API 契约；
// 4. handler 代码更简洁，只需要调用 response.OK / response.Fail。
//
// 这个形状与旧前端 src/lib/api/response.js 保持兼容。
// 迁移到 Go 后端时不重新发明响应格式，可以降低前端改造成本。
package response

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"

	"bookfree/internal/logger"
)

// errorBody 是失败响应中的 error 字段。
//
// 注意它是小写开头的类型名，表示只在 response 包内部使用，
// 其他包不直接构造它，而是通过 Fail / FailDetails / FailSafe 这些函数返回错误。
//
// JSON tag 解释：
//
//	Code string `json:"code"`
//
// 表示 Go 字段 Code 编码成 JSON 时叫 "code"。
// 前端拿到后会通过 error.code 读取。
type errorBody struct {
	// Code 是机器可读的错误码。
	//
	// 前端通常应该优先判断 code，而不是直接判断 message。
	// 因为 message 可能会改文案，但 code 更稳定。
	Code string `json:"code"`

	// Message 是给用户或开发者看的错误说明。
	//
	// 生产环境下，内部错误不应该直接暴露数据库错误、SQL、文件路径等敏感信息。
	Message string `json:"message"`

	// Details 是可选的错误详情。
	//
	// 常见用途：
	// - 表单校验错误；
	// - 哪些字段不合法；
	// - 上传失败的额外原因。
	//
	// any 是 Go 1.18 后的别名，等价于 interface{}，表示可以放任意类型。
	Details any `json:"details"`

	// ErrorID 是内部错误编号。
	//
	// 只有某些错误会带它。用户看到错误编号后，管理员可以到日志里搜索对应 errorId。
	// omitempty 表示为空时 JSON 中不输出这个字段。
	ErrorID string `json:"errorId,omitempty"`
}

// envelope 是 API 响应最外层的“信封”。
//
// 所有成功和失败响应都尽量包在这个结构里，前端 api.ts 会读取：
// - ok 判断成功/失败；
// - data 作为成功数据；
// - error 作为失败信息。
type envelope struct {
	// OK 表示请求在业务意义上是否成功。
	//
	// 注意：HTTP 状态码仍然会正确设置。
	// 例如参数错误通常是 HTTP 400，同时 ok=false。
	OK bool `json:"ok"`

	// Data 是成功时返回的数据。
	//
	// 失败时通常为空/null。
	Data any `json:"data"`

	// Error 是失败时返回的错误对象。
	//
	// 成功时通常为空/null。
	Error *errorBody `json:"error"`
}

// 通用错误码列表。
//
// 这些字符串是前后端之间的契约：
// - 后端 response.Fail 使用这些 code；
// - 前端 api.ts 把它们放进 ApiException；
// - 页面可以根据 code 做不同提示或跳转。
//
// 如果以后新增错误码，应同时检查前端是否需要识别它。
// 不建议随意修改已有字符串，否则可能破坏前端判断逻辑。
const (
	// CodeUnauthorized 表示用户未登录或登录态无效。
	//
	// 前端遇到这个错误时，通常可以跳转登录页或提示重新登录。
	CodeUnauthorized = "UNAUTHORIZED"

	// CodeForbidden 表示用户已登录，但没有权限执行该操作。
	//
	// 例如普通用户访问管理员接口。
	CodeForbidden = "FORBIDDEN"

	// CodeNotFound 表示资源不存在。
	//
	// 例如访问不存在的书籍 ID。
	CodeNotFound = "NOT_FOUND"

	// CodeValidation 表示请求参数不合法。
	//
	// 例如邮箱格式不对、缺少必填字段、上传文件名为空。
	CodeValidation = "VALIDATION"

	// CodeConflict 表示资源状态冲突。
	//
	// 例如注册时邮箱已存在。
	CodeConflict = "CONFLICT"

	// CodeUnsupportedFormat 表示上传或阅读的格式暂不支持。
	//
	// BookFree 当前主要支持 TXT、EPUB、PDF 阅读。
	CodeUnsupportedFormat = "UNSUPPORTED_FORMAT"

	// CodeDRMProtected 表示文档可能有 DRM/加密保护，无法解析。
	CodeDRMProtected = "DRM_PROTECTED"

	// CodeParseFailed 表示文件解析失败。
	//
	// 例如 EPUB/PDF 文件损坏，或者 TXT 编码无法识别。
	CodeParseFailed = "PARSE_FAILED"

	// CodeInternal 表示服务器内部错误。
	//
	// 这类错误通常不应该把底层细节直接暴露给生产环境用户。
	CodeInternal = "INTERNAL"

	// CodeCSRFRejected 表示 CSRF 校验失败。
	//
	// CSRF 是浏览器 Cookie 登录态场景下常见的安全防护点。
	CodeCSRFRejected = "CSRF_REJECTED"

	// CodeRateLimited 表示请求过于频繁，被限流中间件拒绝。
	CodeRateLimited = "RATE_LIMITED"
)

// OK 写入一个 HTTP 200 成功响应。
//
// handler 中常见用法：
//
//	response.OK(w, map[string]any{
//	    "books": books,
//	})
//
// 前端最终拿到的 JSON 会是：
//
//	{
//	  "ok": true,
//	  "data": { "books": [...] },
//	  "error": null
//	}
func OK(w http.ResponseWriter, data any) {
	writeJSON(w, http.StatusOK, envelope{OK: true, Data: data})
}

// Created 写入一个 HTTP 201 成功响应。
//
// 201 Created 通常用于“成功创建了一个新资源”的场景，例如：
// - 注册新用户；
// - 创建笔记；
// - 创建 AI 会话；
// - 上传书籍后创建书籍记录。
//
// 与 OK 的区别主要是 HTTP 状态码不同，JSON 信封结构相同。
func Created(w http.ResponseWriter, data any) {
	writeJSON(w, http.StatusCreated, envelope{OK: true, Data: data})
}

// Fail 写入一个确定的错误响应。
//
// 参数说明：
// - w：Go HTTP 响应写入器；
// - status：HTTP 状态码，例如 400/401/403/404/429；
// - code：机器可读错误码，例如 CodeValidation；
// - message：人类可读错误信息。
//
// handler 中常见用法：
//
//	response.Fail(w, http.StatusBadRequest, response.CodeValidation, "邮箱不能为空")
//
// 前端 api.ts 看到 ok=false 后，会把 error 转成 ApiException 抛出。
func Fail(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, envelope{OK: false, Error: &errorBody{
		Code: code, Message: message,
	}})
}

// FailDetails 是带 details 的 Fail。
//
// 当一个错误需要额外结构化信息时使用它。
// 例如表单校验时可以返回：
//
//	details: {
//	  "email": "邮箱格式不正确",
//	  "password": "密码至少 8 位"
//	}
//
// 前端可以根据 details 精准显示到对应输入框附近。
func FailDetails(w http.ResponseWriter, status int, code, message string, details any) {
	writeJSON(w, status, envelope{OK: false, Error: &errorBody{
		Code: code, Message: message, Details: details,
	}})
}

// FailSafe 用于处理“意料之外的内部错误”。
//
// 它和 Fail 的区别是：
// - Fail 通常用于业务上可预期的错误，例如参数错误、未登录、资源不存在；
// - FailSafe 用于数据库异常、文件系统异常、未知 panic 恢复后的错误等。
//
// 为什么叫 Safe？
// 因为生产环境不能把内部错误原文直接返回给用户。
// 例如 err 里可能包含：
// - SQL 语句；
// - 本地文件路径；
// - 第三方服务响应；
// - 敏感配置片段。
//
// 所以生产环境只返回通用错误文案 + errorId。
// 同时把真实错误写入日志，管理员可以用 errorId 关联排查。
func FailSafe(w http.ResponseWriter, where string, err error, status int, isProd bool) {
	id := randomErrorID()

	/*
	 * 记录服务端日志。
	 *
	 * where 用来标记错误发生位置，例如 "books.list"、"auth.login"。
	 * 如果调用方没传 where，就用 api.error 作为默认值。
	 */
	logger.Error(orDefault(where, "api.error"), logger.Fields{
		"errorId": id,
		"err":     err,
		"status":  status,
	})

	/*
	 * 生产环境：隐藏真实错误，只返回错误编号。
	 *
	 * 这样用户可以把错误编号发给管理员，管理员再查日志。
	 */
	msg := "服务器内部错误（错误编号：" + id + "，请联系管理员查询日志）"

	/*
	 * 开发环境：直接把 err.Error() 返回给前端。
	 *
	 * 本地开发时这样更方便定位问题。
	 * 但生产环境一定不能这么做，避免泄露内部细节。
	 */
	if !isProd && err != nil {
		msg = err.Error() + "（errorId=" + id + "）"
	}

	writeJSON(w, status, envelope{OK: false, Error: &errorBody{
		Code: CodeInternal, Message: msg, ErrorID: id,
	}})
}

// randomErrorID 生成一个短错误编号。
//
// crypto/rand 是密码学安全随机数，适合生成不可预测 ID。
// 这里生成 5 字节随机数，再转成十六进制字符串，最终长度约 10 个字符。
//
// 注意：这个 ID 不是安全令牌，只是日志关联编号。
// 它的作用是让用户反馈“错误编号 abc123”时，管理员能在日志中搜索。
func randomErrorID() string {
	b := make([]byte, 5)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// writeJSON 是所有响应函数最终调用的底层写入函数。
//
// 它统一做三件事：
// 1. 设置 Content-Type，告诉浏览器这是 UTF-8 JSON；
// 2. 设置 Cache-Control: no-store，避免 API 响应被浏览器/代理缓存；
// 3. 写入 HTTP 状态码和 JSON body。
//
// 注意调用顺序：
// - Header 必须在 WriteHeader 之前设置；
// - WriteHeader 必须在 Encode body 之前调用；
// - 一旦开始写 body，状态码通常就不能再改了。
func writeJSON(w http.ResponseWriter, status int, body envelope) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)

	/*
	 * 这里忽略 Encode 的错误。
	 *
	 * 原因：
	 * - 大多数 handler 返回的数据都应是可 JSON 编码的；
	 * - 如果连接中途断开，错误也很难再返回给客户端；
	 * - 此时 HTTP 状态码和部分响应可能已经写出。
	 *
	 * 如果未来要严格排查 JSON 编码问题，可以在这里增加日志。
	 */
	_ = json.NewEncoder(w).Encode(body)
}

// orDefault 返回 s；如果 s 为空，则返回 dflt。
//
// 这是一个很小的辅助函数，用来避免到处写：
//
//	if where == "" {
//	    where = "api.error"
//	}
//
// 在 FailSafe 中，它用于保证日志事件名始终有值。
func orDefault(s, dflt string) string {
	if s == "" {
		return dflt
	}
	return s
}
