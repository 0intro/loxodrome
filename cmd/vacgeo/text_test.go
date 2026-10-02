package main

import "testing"

func TestGlyphNameRune(t *testing.T) {
	// XEP names every subset glyph MT<code>, the code being a Windows-1252
	// code point. This is the whole reason the plates' text is readable.
	cases := map[string]rune{
		"MT76":  'L',
		"MT79":  'O',
		"MT52":  '4',
		"MT32":  ' ',
		"MT176": '°',
		// 146 is cp1252's right single quote, which is how the SIA sets a
		// minute mark. Latin-1 leaves it a control character, and reading
		// it as one is the cmd/supaip prime-mark bug in another costume.
		"MT146":   '’',
		"uni2032": '′',
		"degree":  '°',
		"nine":    '9',
		"MTnope":  0,
		"g42":     0,
	}
	for name, want := range cases {
		if got := glyphNameRune(name); got != want {
			t.Errorf("glyphNameRune(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestCp1252Rune(t *testing.T) {
	for n, want := range map[int]rune{32: ' ', 65: 'A', 146: '’', 176: '°', 233: 'é', 129: 0, 256: 0} {
		if got := cp1252Rune(n); got != want {
			t.Errorf("cp1252Rune(%d) = %q, want %q", n, got, want)
		}
	}
}
