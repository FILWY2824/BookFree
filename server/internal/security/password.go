// 中文导读：
// password.go 负责用户密码的哈希与校验。
// 后端绝对不能把明文密码存进数据库，而是应该存不可逆的哈希结果。
// 用户登录时，后端会把用户输入的密码再按同样规则计算并比较。
// 如果你要调整密码策略，例如最低长度、复杂度要求、哈希参数，需要非常谨慎，并考虑旧用户密码如何兼容。
// 这里属于安全敏感代码，修改后必须跑 auth 相关测试。

package security

import "golang.org/x/crypto/bcrypt"

// bcrypt cost 10 — matches src/lib/auth/password.js#COST. Go's bcrypt
// emits and accepts $2a$ hashes which is the bcryptjs default, so a
// hash produced by the Node app verifies here and vice-versa.
const passwordCost = 10

func HashPassword(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	h, err := bcrypt.GenerateFromPassword([]byte(plain), passwordCost)
	if err != nil {
		return "", err
	}
	return string(h), nil
}

func VerifyPassword(plain, hash string) bool {
	if plain == "" || hash == "" {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}
