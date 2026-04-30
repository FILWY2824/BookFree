// 中文导读：
// rag.go 负责 RAG（检索增强生成）相关逻辑。
// 简单理解：用户向某本书提问时，系统先从书籍内容中检索相关片段，再把片段和问题一起发给 AI。
// 这样 AI 回答更贴近书籍内容，而不是凭空编造。
// RAG 容易带来内存压力，因为涉及文本切片、检索结果、上下文拼接。
// BookFree 的实现应优先按需查询、限制片段数量、避免常驻大索引，符合 50MB 常驻内存目标。

// RAG retrieval for the streaming chat endpoint.
//
// Pipeline (per the user's chosen "FTS5 + lightweight local embedding
// + hybrid + LLM rerank" option):
//
//   1. FTS5 candidate generation
//      ──────────────────────────────
//      Take the user's last user-role message, tokenize it the same
//      way ingest does (CJK bigrams + ASCII words), feed it to FTS5
//      via search.QueryString(). Retrieve top-K=20 chunks scoped to
//      (this user, this book). FTS5's bm25 ranking handles term
//      weighting; we keep the rank as a feature for the hybrid score.
//
//   2. Vector rerank
//      ─────────────
//      Each candidate chunk has a stored 96-d embedding (book_chunk_
//      embeddings table from migration 0023). We compute the same
//      embedding for the query on the fly and cosine-rank against
//      the candidates. Hybrid score = 0.6*cosine + 0.4*(rank decay).
//
//   3. Pick top-N=5 highest-scoring chunks; these become both the
//      "passages" prepended to the system prompt AND the citations
//      surfaced to the UI.
//
// "Lightweight" embedding model:
//   We use a hash-bucketed feature vector with TF normalization and
//   IDF-style smoothing — the kind of thing that sits between BoW
//   and a real neural embedding. Concretely: tokenize the chunk into
//   bigrams (same tokenizer as FTS5), hash each token into one of 96
//   buckets via fnv-1a, increment the bucket by `1/log(1+freq)` to
//   damp the contribution of high-frequency tokens. Then L2-normalize.
//
//   This is genuinely worse than a real Transformer embedding for
//   semantic search — it's basically a hashed BoW. BUT it has three
//   properties that matter for our constraints:
//     • zero external dependencies (no model file to ship, no GPU)
//     • cosine similarity is meaningful (within a topical book, two
//       chunks discussing the same concept share many bigrams)
//     • per-book footprint stays under 1 MB (96 floats × 4 bytes
//       × ~1000 chunks/book = 384 KB)
//
//   When/if we add a real embedding model, the column already
//   carries a `model_tag` so we can migrate in place.
//
// RAM target: <50 MB resident. The retrieval path streams from
// SQLite — we hold at most 20 candidate vectors in memory at once
// (~7.5 KB), plus the query vector. The candidate text strings
// are bounded by the FTS5 limit and stay well under 100 KB.

package ai

import (
	"context"
	"database/sql"
	"encoding/binary"
	"errors"
	"hash/fnv"
	"math"
	"sort"
	"strings"

	"bookfree/internal/search"
)

const (
	embedDim        = 96
	embedModelTag   = "bf-hash-v1"
	ftsCandidateK   = 20
	finalCitationN  = 5
	maxPassageBytes = 1500 // per-passage cap pushed into the system prompt
)

// RetrievedChunk is one ranked passage that became a citation.
type RetrievedChunk struct {
	ChunkID      string
	BookID       string
	BookTitle    string
	ChapterID    string
	ChapterTitle string
	Text         string
	// FTS5 raw rank (negated bm25; higher = more relevant). Kept for
	// debug / future tuning; not exposed on the wire.
	FTSRank float64
	// Cosine similarity in [-1, 1] of the chunk's embedding vs the query.
	Cosine float64
	// Final hybrid score used to sort.
	Score float64
}

// CitationDTO is the citation payload sent to the client over SSE.
// Snippet is HTML-safe (server already wraps query terms in <mark>).
type CitationDTO struct {
	ID           string `json:"id"`
	BookID       string `json:"bookId"`
	BookTitle    string `json:"bookTitle"`
	ChapterID    string `json:"chapterId,omitempty"`
	ChapterTitle string `json:"chapterTitle,omitempty"`
	Snippet      string `json:"snippet"`
}

// retrieveContext runs the full pipeline. Returns top-N chunks plus
// citation DTOs ready to be serialised to the wire. When `bookID` is
// empty (chat scope is "all books"), retrieval is skipped — too noisy
// without a focus, and we'd burn a lot of CPU embedding the whole
// library on each turn.
func retrieveContext(ctx context.Context, db *sql.DB, userID, bookID, query string) ([]RetrievedChunk, []CitationDTO, error) {
	query = strings.TrimSpace(query)
	if query == "" || bookID == "" {
		return nil, nil, nil
	}

	candidates, err := ftsCandidates(ctx, db, userID, bookID, query, ftsCandidateK)
	if err != nil {
		return nil, nil, err
	}
	if len(candidates) == 0 {
		return nil, nil, nil
	}

	// Load embeddings for every candidate. Chunks ingested before
	// migration 0023 won't have rows here yet — for those we treat
	// cosine as 0 and rely on FTS rank alone, which is still a
	// meaningful signal.
	embByID, err := loadEmbeddings(ctx, db, userID, bookID, candidateIDs(candidates), embedModelTag)
	if err != nil {
		return nil, nil, err
	}

	queryVec := embedText(query)

	// Compute hybrid score. FTS rank is normalised to [0,1] by
	// dividing by the best (highest) rank in this candidate set.
	maxFTS := 0.0
	for _, c := range candidates {
		if c.FTSRank > maxFTS {
			maxFTS = c.FTSRank
		}
	}
	if maxFTS == 0 {
		maxFTS = 1
	}
	for i := range candidates {
		ftsNorm := candidates[i].FTSRank / maxFTS
		var cos float64
		if v, ok := embByID[candidates[i].ChunkID]; ok {
			cos = cosine(queryVec, v)
			candidates[i].Cosine = cos
		}
		// Hybrid weighting. With an embedding present we lean toward
		// semantic similarity; without one we fall back to FTS.
		if _, ok := embByID[candidates[i].ChunkID]; ok {
			candidates[i].Score = 0.6*cos + 0.4*ftsNorm
		} else {
			candidates[i].Score = ftsNorm
		}
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].Score > candidates[j].Score
	})
	if len(candidates) > finalCitationN {
		candidates = candidates[:finalCitationN]
	}

	citations := make([]CitationDTO, 0, len(candidates))
	for _, c := range candidates {
		citations = append(citations, CitationDTO{
			ID:           c.ChunkID,
			BookID:       c.BookID,
			BookTitle:    c.BookTitle,
			ChapterID:    c.ChapterID,
			ChapterTitle: c.ChapterTitle,
			Snippet:      makeSnippet(c.Text, query),
		})
	}
	return candidates, citations, nil
}

// ftsCandidates queries book_chunks_fts for the top-K matches scoped
// to this user + book. Joins back to books for the title (cheap given
// the K=20 result set).
func ftsCandidates(ctx context.Context, db *sql.DB, userID, bookID, query string, k int) ([]RetrievedChunk, error) {
	q := search.QueryString(query)
	if q == "" {
		return nil, nil
	}
	rows, err := db.QueryContext(ctx, `
		SELECT
			f.chunk_id, f.book_id, f.chapter_id, f.text,
			COALESCE(b.title, ''),
			COALESCE(c.title, ''),
			-bm25(book_chunks_fts) AS rank
		FROM book_chunks_fts f
		LEFT JOIN books    b ON b.id = f.book_id
		LEFT JOIN chapters c ON c.id = f.chapter_id
		WHERE f.user_id = ?
		  AND f.book_id = ?
		  AND f.search_text MATCH ?
		ORDER BY rank DESC
		LIMIT ?
	`, userID, bookID, q, k)
	if err != nil {
		// FTS5 throws on malformed queries (e.g. only stop-words).
		// Treat as "no candidates" rather than failing the whole turn.
		return nil, nil
	}
	defer rows.Close()

	var out []RetrievedChunk
	for rows.Next() {
		var rc RetrievedChunk
		var chapterID sql.NullString
		var chapterTitle string
		if err := rows.Scan(
			&rc.ChunkID, &rc.BookID, &chapterID, &rc.Text,
			&rc.BookTitle, &chapterTitle, &rc.FTSRank,
		); err != nil {
			return nil, err
		}
		if chapterID.Valid {
			rc.ChapterID = chapterID.String
		}
		rc.ChapterTitle = chapterTitle
		out = append(out, rc)
	}
	return out, rows.Err()
}

func candidateIDs(cs []RetrievedChunk) []string {
	out := make([]string, len(cs))
	for i := range cs {
		out[i] = cs[i].ChunkID
	}
	return out
}

// loadEmbeddings fetches the stored vectors for the given chunk_ids.
// Vectors are stored as little-endian Float32 BLOBs (96*4 = 384 B each).
func loadEmbeddings(ctx context.Context, db *sql.DB, userID, bookID string, ids []string, modelTag string) (map[string][]float32, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	// Build a `?,?,?,…` IN-list. We stay below SQLite's default
	// expression-tree limit of 1000 trivially (k=20 here).
	placeholders := strings.Repeat("?,", len(ids)-1) + "?"
	args := make([]any, 0, len(ids)+3)
	args = append(args, userID, bookID, modelTag)
	for _, id := range ids {
		args = append(args, id)
	}
	q := `SELECT chunk_id, vector FROM book_chunk_embeddings
	      WHERE user_id = ? AND book_id = ? AND model_tag = ?
	      AND chunk_id IN (` + placeholders + `)`
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[string][]float32, len(ids))
	for rows.Next() {
		var chunkID string
		var blob []byte
		if err := rows.Scan(&chunkID, &blob); err != nil {
			return nil, err
		}
		v, err := decodeVector(blob)
		if err != nil {
			continue // skip corrupted rows rather than failing the turn
		}
		out[chunkID] = v
	}
	return out, rows.Err()
}

// embedText computes the hash-bucketed embedding described in the
// package doc. Returns a length-`embedDim` L2-normalized vector.
func embedText(s string) []float32 {
	tokens := search.Tokenize(s)
	if len(tokens) == 0 {
		return make([]float32, embedDim)
	}

	// Token frequency.
	freq := make(map[string]int, len(tokens))
	for _, t := range tokens {
		freq[t]++
	}

	v := make([]float32, embedDim)
	for tok, f := range freq {
		// Damp by log so a token repeated 50 times doesn't dominate.
		w := 1.0 / math.Log(1.0+float64(f))
		// fnv-1a 32, then mod by dim. Sign flip on alternate tokens
		// keeps the vector zero-meaned-ish without explicit centering
		// (tokens that hash to the same bucket but with different
		// "polarity bits" cancel rather than always adding).
		h := fnv.New32a()
		_, _ = h.Write([]byte(tok))
		hv := h.Sum32()
		bucket := int(hv % embedDim)
		sign := float32(1)
		if hv&0x80000000 != 0 {
			sign = -1
		}
		v[bucket] += sign * float32(w)
	}

	// L2-normalize so cosine reduces to dot product.
	var norm float64
	for _, x := range v {
		norm += float64(x) * float64(x)
	}
	norm = math.Sqrt(norm)
	if norm > 0 {
		for i := range v {
			v[i] = float32(float64(v[i]) / norm)
		}
	}
	return v
}

// EncodeVector turns a length-dim vector into the BLOB layout we
// store. Exported so the ingest path can write embeddings on chunk
// insert.
func EncodeVector(v []float32) []byte {
	if len(v) != embedDim {
		// We accept other lengths by padding/truncating rather than
		// returning an error — the embedding code is in our control,
		// so a length mismatch here means a bug, not user data.
		fixed := make([]float32, embedDim)
		copy(fixed, v)
		v = fixed
	}
	buf := make([]byte, embedDim*4)
	for i, x := range v {
		binary.LittleEndian.PutUint32(buf[i*4:], math.Float32bits(x))
	}
	return buf
}

// EmbedText is the exported wrapper used by the ingest pipeline to
// produce vectors for every chunk it inserts.
func EmbedText(s string) []float32 { return embedText(s) }

// EmbedModelTag identifies the algorithm that produced a vector.
// Stored alongside the BLOB so a future migration to a real Transformer
// embedding can co-exist with the legacy hash-vectors during rollout.
func EmbedModelTag() string { return embedModelTag }

func decodeVector(b []byte) ([]float32, error) {
	if len(b) != embedDim*4 {
		return nil, errors.New("embedding blob: length mismatch")
	}
	out := make([]float32, embedDim)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return out, nil
}

func cosine(a, b []float32) float64 {
	if len(a) != len(b) {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}

// makeSnippet produces a short, HTML-escaped, <mark>-wrapped snippet
// of the chunk centred on the first occurrence of any query term.
// We do this server-side rather than letting FTS5's snippet() run
// because we want consistency between the streaming-chat citations
// and other surfaces, and FTS5 snippet() requires the full row to
// be in scope of the MATCH which our retrieval flow doesn't preserve.
func makeSnippet(text, query string) string {
	const want = 140
	tokens := strings.FieldsFunc(query, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\n'
	})
	lower := strings.ToLower(text)
	bestIdx := -1
	for _, t := range tokens {
		if t == "" {
			continue
		}
		idx := strings.Index(lower, strings.ToLower(t))
		if idx >= 0 && (bestIdx < 0 || idx < bestIdx) {
			bestIdx = idx
		}
	}
	start := 0
	if bestIdx > want/2 {
		start = bestIdx - want/2
	}
	end := start + want
	if end > len(text) {
		end = len(text)
	}
	if start > 0 {
		// Snap to a clean codepoint boundary to avoid mid-rune cuts.
		for start > 0 && (text[start]&0xC0) == 0x80 {
			start--
		}
	}
	if end < len(text) {
		for end < len(text) && (text[end]&0xC0) == 0x80 {
			end++
		}
	}

	out := text[start:end]
	out = htmlEscape(out)
	for _, t := range tokens {
		if t == "" {
			continue
		}
		out = wrapMark(out, t)
	}
	if start > 0 {
		out = "…" + out
	}
	if end < len(text) {
		out = out + "…"
	}
	return out
}

// wrapMark replaces case-insensitive occurrences of `needle` in
// (already-escaped) `s` with <mark>…</mark>. Stops after 8 wraps to
// keep snippet HTML small even on a needle that matches every other
// word.
func wrapMark(s, needle string) string {
	if needle == "" {
		return s
	}
	lower := strings.ToLower(s)
	low := strings.ToLower(needle)
	var b strings.Builder
	i := 0
	wraps := 0
	for i < len(s) && wraps < 8 {
		idx := strings.Index(lower[i:], low)
		if idx < 0 {
			b.WriteString(s[i:])
			break
		}
		b.WriteString(s[i : i+idx])
		b.WriteString("<mark>")
		b.WriteString(s[i+idx : i+idx+len(needle)])
		b.WriteString("</mark>")
		i = i + idx + len(needle)
		wraps++
	}
	if wraps >= 8 && i < len(s) {
		b.WriteString(s[i:])
	}
	return b.String()
}

func htmlEscape(s string) string {
	r := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		"\"", "&quot;",
	)
	return r.Replace(s)
}

// truncatePassage clamps the text we paste into the system prompt so
// the model's context window doesn't blow up across many candidates.
func truncatePassage(s string) string {
	if len(s) <= maxPassageBytes {
		return s
	}
	cut := maxPassageBytes
	for cut < len(s) && (s[cut]&0xC0) == 0x80 {
		cut++
	}
	if cut > len(s) {
		cut = len(s)
	}
	return s[:cut] + "…"
}
