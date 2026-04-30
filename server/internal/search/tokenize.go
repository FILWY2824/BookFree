// Package search 负责 BookFree 的全文搜索能力。
//
// 本文件 tokenize.go 专注于“分词”和“构造 FTS5 查询表达式”。
//
// 你可以把全文搜索理解为两步：
//  1. 写入索引时：把原始文本转换成适合搜索引擎存储的 token；
//  2. 查询时：把用户输入的搜索词转换成同一套 token，再交给搜索引擎匹配。
//
// BookFree 当前使用 SQLite FTS5 做全文搜索。FTS5 很轻量，适合本项目的自托管和低内存目标，
// 但它内置的 unicode61 tokenizer 对中文并不理想：
//  1. 英文天然有空格，例如 "deep learning" 可以分成 deep 和 learning；
//  2. 中文没有天然空格，例如 “量子纠缠” 是连续汉字；
//  3. 如果简单按单个汉字搜索，会变成 “量 AND 子 AND 纠 AND 缠”，顺序和相邻关系都不可靠。
//
// 因此这里采用 CJK bigram（二字滑窗）方案：
//   - “量子纠缠” → “量子” “子纠” “纠缠”
//
// 这样搜索 “量子纠缠” 时，FTS5 必须同时匹配这些相邻二字片段，结果质量比单字 token 更好。
// 这个方案不需要引入大型中文分词库，常驻内存更低，也符合 BookFree 当前阶段的轻量架构。
package search

import "strings"

// isChineseHan 判断一个 rune 是否属于当前支持的汉字 Unicode 范围。
//
// 初学者提示：
//  1. Go 的 byte 表示一个字节；
//  2. Go 的 rune 表示一个 Unicode 码点；
//  3. 中文字符在 UTF-8 中通常占多个字节，用 rune 处理更安全。
//
// 为什么这里只支持这些 Han 范围？
// BookFree 当前主要面向中文 + 英文阅读场景。
// 如果要支持日文假名、韩文、阿拉伯文、俄文等语言，应当重新设计 tokenizer 或引入更专业的分词方案。
// 但引入复杂分词库可能增加二进制体积、内存占用和维护成本，所以当前先保持轻量。
func isChineseHan(r rune) bool {
	switch {
	case r >= 0x3400 && r <= 0x4DBF: // CJK Unified Ideographs Extension A：中日韩统一表意文字扩展 A
		return true
	case r >= 0x4E00 && r <= 0x9FFF: // CJK Unified Ideographs：最常见的中文汉字范围
		return true
	case r >= 0xF900 && r <= 0xFAFF: // CJK Compatibility Ideographs：兼容汉字
		return true
	case r >= 0x20000 && r <= 0x2A6DF: // CJK Unified Ideographs Extension B：扩展 B
		return true
	}
	return false
}

// isASCIILatinDigit 判断一个 rune 是否是 ASCII 英文字母或数字。
//
// 这里只处理 a-z、A-Z、0-9，是为了让英文标题、英文正文、数字页码/术语能被正常搜索。
// 例如：
//   - "AI Reader 2026" → "ai" "reader" "2026"
//
// 为什么不对英文也做 bigram？
//   - 英文单词天然由空格、标点分隔；
//   - “neural” 搜索成 "ne" "eu" "ur"... 反而会产生很多噪声；
//   - 保留完整小写单词更符合用户直觉，也减少索引 token 数量。
func isASCIILatinDigit(r rune) bool {
	return (r >= 'a' && r <= 'z') ||
		(r >= 'A' && r <= 'Z') ||
		(r >= '0' && r <= '9')
}

// Tokenize 把一段原始文本切成适合写入 SQLite FTS5 的 token 列表。
//
// 规则：
//  1. 连续英文/数字：合并为一个小写 token；
//     例如 "BookFree2026" → "bookfree2026"
//  2. 连续汉字长度为 1：保留单字 token；
//     例如 "书" → "书"
//  3. 连续汉字长度 >= 2：生成 overlapping bigrams（二字滑窗）；
//     例如 "量子纠缠" → "量子" "子纠" "纠缠"
//  4. 空白、标点、emoji、当前不支持的文字：跳过。
//
// 为什么忽略标点？
// 搜索时用户通常关心词本身，不关心中文逗号、句号、引号等标点。
// 忽略标点可以让 “量子，纠缠” 和 “量子纠缠” 在一定程度上更容易被相邻 token 匹配。
//
// 为什么返回 []string 而不是直接返回一个字符串？
// 因为 Tokenize 是底层能力：
//  1. SearchText 会把 tokens join 成写入 FTS5 的文本；
//  2. QueryString 会把 tokens quote 成 MATCH 表达式；
//  3. tokenize_test.go 可以直接断言 tokens 是否符合预期。
func Tokenize(s string) []string {
	if s == "" {
		return nil
	}

	// 预分配 16 个容量只是一个小优化。
	//
	// 大多数搜索词或短文本产生的 token 不会太多；
	// 如果超过 16，append 会自动扩容，不影响正确性。
	out := make([]string, 0, 16)

	// 把 string 转为 []rune，便于按 Unicode 码点扫描。
	//
	// 如果直接按字节遍历，中文会被拆成多个 UTF-8 字节，无法正确判断汉字范围。
	runes := []rune(s)

	// i 是当前扫描位置。
	//
	// 这个函数使用“双指针/滑动扫描”：
	//   - i 指向当前片段起点；
	//   - j 向后走，找到同类型连续片段的结束位置；
	//   - 然后处理 runes[i:j] 这段内容。
	var i int
	for i < len(runes) {
		r := runes[i]

		switch {
		case isChineseHan(r):
			// 找到一段连续汉字。
			//
			// 例如文本为 “量子纠缠 abc”，i 指向 “量”，
			// j 会一路走到 “缠” 后面，run 就是 “量子纠缠”。
			j := i
			for j < len(runes) && isChineseHan(runes[j]) {
				j++
			}
			run := runes[i:j]

			if len(run) == 1 {
				// 只有一个汉字时无法组成 bigram，只能保留单字。
				out = append(out, string(run))
			} else {
				// overlapping bigram：窗口大小为 2，每次向右移动 1 个字符。
				//
				// run = [量 子 纠 缠]
				// k=0 → [量 子]
				// k=1 → [子 纠]
				// k=2 → [纠 缠]
				for k := 0; k+1 < len(run); k++ {
					out = append(out, string(run[k:k+2]))
				}
			}

			// 跳过刚处理完的整段连续汉字。
			i = j

		case isASCIILatinDigit(r):
			// 找到一段连续 ASCII 英文/数字。
			//
			// 例如 “BookFree2026 中文”，会得到 “BookFree2026”，
			// 再统一转成小写 “bookfree2026”。
			j := i
			for j < len(runes) && isASCIILatinDigit(runes[j]) {
				j++
			}
			out = append(out, strings.ToLower(string(runes[i:j])))
			i = j

		default:
			// 不支持的字符直接跳过。
			//
			// 包括：
			//   - 空格、换行、制表符；
			//   - 标点符号；
			//   - emoji；
			//   - 当前未支持的其他语言脚本。
			i++
		}
	}

	return out
}

// SearchText 把原始文本转换成写入 FTS5 索引列的字符串。
//
// 它的工作流程是：
//  1. 调用 Tokenize 得到 token 列表；
//  2. 用单个空格把 tokens 拼起来；
//  3. 返回给 ingest/search 索引写入逻辑。
//
// 示例：
//
//	SearchText("量子纠缠 AI")
//	=> "量子 子纠 纠缠 ai"
//
// 为什么要用空格 join？
// SQLite FTS5 的 unicode61 tokenizer 会把空格分隔的内容当成独立 term。
// 我们已经自己完成了中文 bigram，所以只需要让 FTS5 把这些 token 当普通词存储即可。
func SearchText(s string) string {
	tokens := Tokenize(s)
	if len(tokens) == 0 {
		return ""
	}
	return strings.Join(tokens, " ")
}

// QueryString 根据用户输入构造 SQLite FTS5 的 MATCH 查询表达式。
//
// 示例：
//
//	QueryString("量子纠缠 AI")
//	=> "\"量子\" \"子纠\" \"纠缠\" \"ai\""
//
// FTS5 中，多个空格分隔的 term 默认是 AND 关系。
// 也就是说，搜索 “量子纠缠” 时，需要同时命中：
//   - “量子”
//   - “子纠”
//   - “纠缠”
//
// 为什么每个 token 都要用双引号包起来？
// 因为 FTS5 MATCH 支持一些特殊语法，例如 AND、OR、NEAR、* 等。
// 如果直接把用户输入拼进去，用户输入的特殊字符可能改变查询含义，甚至导致查询报错。
// 把 token quote 成字面量，可以让它更像“普通搜索词”，避免 FTS5 操作符注入。
//
// 为什么还要替换 token 里的双引号？
// FTS5 的 quoted string 中，字面量双引号需要写成两个双引号。
// 虽然 Tokenize 当前通常不会保留双引号，但这里保留防御式写法，便于以后扩展 tokenizer。
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
		b.WriteString(strings.ReplaceAll(t, `"`, `""`))
		b.WriteByte('"')
	}

	return b.String()
}
