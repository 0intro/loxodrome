// text.go decodes the plates' show strings.
//
// rsc.io/pdf's own Font.Encoder cannot read them. XEP subsets every font and
// writes an /Encoding /Differences array whose glyph names are of the form
// MT<n>, n being the character's code point in the producer's own charset;
// rsc.io/pdf looks each name up in the standard Adobe glyph list, finds
// nothing, and hands back the raw subset code. So "LOGNES" arrives as
// "\x02\x03\x04\x05\x06\a" and every coordinate label is invisible.
//
// The charset is Windows-1252, which is where the prime marks come from:
// the SIA writes a minute mark as character 146, and 146 is cp1252's RIGHT
// SINGLE QUOTATION MARK. That is the same prime cmd/supaip meets as a raw
// byte after poppler has passed it through (its geom.go coordRe accepts
// ', U+2032 and any C0 byte for exactly this reason); decoding the plate
// ourselves turns it into an honest U+2019 before the grammar ever sees it.

package main

import (
	"strconv"
	"strings"

	"rsc.io/pdf"
)

// cp1252High maps the 0x80-0x9F range Windows-1252 fills and Latin-1 leaves
// as controls. Everything outside it is Latin-1, i.e. the code point itself.
var cp1252High = [32]rune{
	0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
	0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017D, 0,
	0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
	0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178,
}

func cp1252Rune(n int) rune {
	switch {
	case n < 0 || n > 0xFF:
		return 0
	case n >= 0x80 && n <= 0x9F:
		return cp1252High[n-0x80]
	default:
		return rune(n)
	}
}

// glyphNameRune resolves one /Differences glyph name. It covers the three
// forms these plates use and the handful of standard names that carry
// meaning for the coordinate grammar; anything else returns 0 and the
// caller keeps the raw code, which the tolerant label grammar reads as a
// separator rather than as a digit.
func glyphNameRune(name string) rune {
	if n, ok := strings.CutPrefix(name, "MT"); ok {
		if v, err := strconv.Atoi(n); err == nil {
			return cp1252Rune(v)
		}
	}
	if h, ok := strings.CutPrefix(name, "uni"); ok && len(h) >= 4 {
		if v, err := strconv.ParseUint(h[:4], 16, 32); err == nil {
			return rune(v)
		}
	}
	return standardGlyphs[name]
}

// standardGlyphs is the Adobe-name subset that matters here: digits, the
// degree sign and the prime marks. A plate written with real glyph names
// still has to yield a readable "48°53'".
var standardGlyphs = map[string]rune{
	"space": ' ', "zero": '0', "one": '1', "two": '2', "three": '3', "four": '4',
	"five": '5', "six": '6', "seven": '7', "eight": '8', "nine": '9',
	"degree": '°', "quotesingle": '\'', "quoteright": '’', "quotedbl": '"',
	"quotedblright": '”', "minute": '′', "second": '″',
	"period": '.', "comma": ',', "hyphen": '-', "slash": '/', "colon": ':',
	"N": 'N', "S": 'S', "E": 'E', "W": 'W',
}

// diffEncoder decodes with the font's own /Differences table.
type diffEncoder struct {
	m map[int]rune
}

func (e *diffEncoder) Decode(raw string) string {
	var b strings.Builder
	for i := 0; i < len(raw); i++ {
		if r, ok := e.m[int(raw[i])]; ok && r != 0 {
			b.WriteRune(r)
			continue
		}
		b.WriteByte(raw[i])
	}
	return b.String()
}

// fontEncoder returns the decoder for one font: ours when the font carries
// a /Differences array, rsc.io/pdf's otherwise (a plate using a named base
// encoding needs no help).
func fontEncoder(f pdf.Font) pdf.TextEncoding {
	enc := f.V.Key("Encoding")
	if enc.Kind() == pdf.Dict {
		if d := enc.Key("Differences"); d.Kind() == pdf.Array {
			return &diffEncoder{m: differencesMap(d)}
		}
	}
	return f.Encoder()
}

// differencesMap flattens a /Differences array into code -> rune. The array
// is a sequence of "start code" integers each followed by the glyph names
// of consecutive codes (PDF 32000-1 9.6.6.1).
func differencesMap(d pdf.Value) map[int]rune {
	out := make(map[int]rune, d.Len())
	code := 0
	for i := 0; i < d.Len(); i++ {
		v := d.Index(i)
		switch v.Kind() {
		case pdf.Integer, pdf.Real:
			code = int(v.Int64())
		case pdf.Name:
			if r := glyphNameRune(v.Name()); r != 0 {
				out[code] = r
			}
			code++
		}
	}
	return out
}
