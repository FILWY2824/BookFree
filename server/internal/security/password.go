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
