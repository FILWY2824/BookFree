// Package search holds the bigram tokenizer + FTS5 query builder.
//
// Why bigrams: SQLite's built-in unicode61 tokenizer treats each Han
// character as a separate token, which means searching for "量子纠缠"
// effectively searches for "量 AND 子 AND 纠 AND 缠" with no positional
// ordering — terrible recall AND precision. The legacy MiniSearch path
// in src/lib/search/tokenize.js worked around this by emitting overlapping
// 2-char tokens for CJK runs ("量子", "子纠", "纠缠"). FTS5 has no built-in
// way to do this either, so we reproduce the same behaviour at write
// time: the column we feed to FTS5 is bigram-tokenized text, and the
// query is bigram-tokenized too. unicode61 then "just works" for both.
//
// Latin/digit runs continue to be emitted as whole lowercased tokens
// because byte-bigrams of "neural" don't help anyone.
package search

import (
	"strings"
	"unicode"
)

// isCJK matches what the JS regex /[\u4e00-\u9fff\u3400-\u4dbf]/ saw.
// We extend slightly to include common kana ranges so Japanese text
// is also handled, since the legacy code treated katakana/hiragana
// the same way (see tokenize.js).
func isCJK(r rune) bool {
	switch {
	case r >= 0x3040 && r <= 0x309F: // hiragana
		return true
	case r >= 0x30A0 && r <= 0x30FF: // katakana
		return true
	case r >= 0x3400 && r <= 0x4DBF: // CJK Ext A
		return true
	case r >= 0x4E00 && r <= 0x9FFF: // CJK Unified
		return true
	case r >= 0xF900 && r <= 0xFAFF: // CJK Compat
		return true
	case r >= 0x20000 && r <= 0x2A6DF: // CJK Ext B
		return true
	}
	return false
}

func isLatinDigit(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r)
}

// Tokenize emits the FTS-friendly tokens for one piece of text.
//
//	Latin/digit runs   → one lowercased token per run
//	CJK runs (≥2)      → overlapping bigrams
//	CJK runs of len 1  → that single character
//	everything else    → discarded (whitespace, punctuation, …)
//
// This is the same contract the JS tokenizer exposes — see
// src/lib/search/tokenize.js. The only intentional simplification is
// that we no longer emit unigrams for long CJK runs; the migration
// document explicitly calls out unigram suppression as one of the
// memory wins to preserve.
func Tokenize(s string) []string {
	if s == "" {
		return nil
	}
	out := make([]string, 0, 16)
	runes := []rune(s)

	var i int
	for i < len(runes) {
		r := runes[i]
		switch {
		case isCJK(r):
			j := i
			for j < len(runes) && isCJK(runes[j]) {
				j++
			}
			run := runes[i:j]
			if len(run) == 1 {
				out = append(out, string(run))
			} else {
				for k := 0; k+1 < len(run); k++ {
					out = append(out, string(run[k:k+2]))
				}
			}
			i = j
		case isLatinDigit(r):
			j := i
			for j < len(runes) && isLatinDigit(runes[j]) {
				j++
			}
			out = append(out, strings.ToLower(string(runes[i:j])))
			i = j
		default:
			i++
		}
	}
	return out
}

// SearchText turns a piece of source text into the value we store in
// FTS5's indexed `search_text` column. Tokens are joined with a single
// space so unicode61 sees them as separate terms. This is the value
// that goes into book_chunks.search_text on insert.
func SearchText(s string) string {
	tokens := Tokenize(s)
	if len(tokens) == 0 {
		return ""
	}
	return strings.Join(tokens, " ")
}

// QueryString builds an FTS5 MATCH expression from a user's free-form
// query. We escape every token by wrapping it in double quotes — FTS5
// treats a quoted token as a literal phrase, so user-typed punctuation
// or operators (AND, NEAR, *) cannot break out and corrupt the query.
//
// Multiple tokens are AND-joined (the FTS5 default), which gives the
// user the "all words must match" behaviour they expect from the old
// MiniSearch code. We do not emit OR or NEAR; result quality is better
// served by a small candidate set + reranker per the migration plan.
func QueryString(q string) string {
	tokens := Tokenize(q)
	if len(tokens) == 0 {
		return ""
	}
	var b strings.Builder
	for i, t := range tokens {
		if i > 0 {
			b.WriteByte(' ')
		}
		b.WriteByte('"')
		// FTS5 escapes a literal quote by doubling it inside the quoted
		// token. This is rare in practice but defensive.
		b.WriteString(strings.ReplaceAll(t, `"`, `""`))
		b.WriteByte('"')
	}
	return b.String()
}
