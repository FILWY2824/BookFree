package search

import (
	"reflect"
	"testing"
)

func TestTokenizeChineseEnglishOnly(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []string
	}{
		{
			name: "chinese bigrams and english words are kept",
			in:   "量子纠缠 Neural Reader 2026",
			want: []string{"量子", "子纠", "纠缠", "neural", "reader", "2026"},
		},
		{
			name: "single chinese han character is kept",
			in:   "书",
			want: []string{"书"},
		},
		{
			name: "unsupported scripts are ignored",
			in:   "かなカナ한국어 русский Ελληνικά العربية",
			want: []string{},
		},
		{
			name: "unsupported scripts split supported runs",
			in:   "AIかな阅读русскийNotes",
			want: []string{"ai", "阅读", "notes"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Tokenize(tt.in)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("Tokenize(%q) = %#v, want %#v", tt.in, got, tt.want)
			}
		})
	}
}

func TestQueryStringChineseEnglishOnly(t *testing.T) {
	got := QueryString(`量子 AI かな "`)
	want := `"量子" "ai"`
	if got != want {
		t.Fatalf("QueryString() = %q, want %q", got, want)
	}
}
