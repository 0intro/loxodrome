package pdfcontent

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

// trace renders every operator with its operands, one per line.
func trace(t *testing.T, data string) (string, error) {
	t.Helper()
	var b strings.Builder
	err := Interpret([]byte(data), func(op string, args []Operand) {
		b.WriteString(op)
		for _, a := range args {
			b.WriteString(" " + show(a))
		}
		b.WriteString("\n")
	})
	return b.String(), err
}

func show(o Operand) string {
	switch o.Kind {
	case Number:
		return fmt.Sprint(o.Num)
	case Bool:
		return fmt.Sprint(o.Bool)
	case String:
		return fmt.Sprintf("%q", o.Str)
	case Name:
		return "/" + o.Str
	case Array, Dict:
		open, end := "[", "]"
		if o.Kind == Dict {
			open, end = "<<", ">>"
		}
		var parts []string
		for _, it := range o.Items {
			parts = append(parts, show(it))
		}
		return open + strings.Join(parts, " ") + end
	}
	return "null"
}

func TestInterpret(t *testing.T) {
	for _, c := range []struct {
		name, in, want string
	}{
		{"path", "0 0 m 10.5 -3 l S", "m 0 0\nl 10.5 -3\nS\n"},
		{"numbers", "+1 -.5 3. .25 0 d0", "d0 1 -0.5 3 0.25 0\n"},
		{"not numbers", "1.2.3 Inf NaN -", "1.2.3\nInf\nNaN\n-\n"},
		{"names", "/F#201 12 Tf /A/B BDC", "Tf /F 1 12\nBDC /A /B\n"},
		{"comments", "% a comment\n1 w % another\n2 J", "w 1\nJ 2\n"},
		{"true false null", "true false null op", "op true false null\n"},
		{"text array", "[(A) -120 (B)] TJ", "TJ [\"A\" -120 \"B\"]\n"},
		{"property list", "/OC <</MCID 3 /Name (x)>> BDC", "BDC /OC <</MCID 3 /Name \"x\">>\n"},
		{"nested", "[[1 2] [3]] op", "op [[1 2] [3]]\n"},
		// The Romanian ENR 2.2 page: the producer cut the stream right
		// after a TJ array's "[", and the parts joined read as one.
		{"array across a part boundary", "0.0015 Tw\n[\n( -)-6.5( f)] TJ", "Tw 0.0015\nTJ [\" -\" -6.5 \" f\"]\n"},
		{"stray closers", ") ] >> } > { 1 0 0 1 0 0 cm", "cm 1 0 0 1 0 0\n"},
		{"operands with no operator", "1 2 3", ""},
	} {
		got, err := trace(t, c.in)
		if err != nil {
			t.Errorf("%s: error %v", c.name, err)
		}
		if got != c.want {
			t.Errorf("%s: got\n%s\nwant\n%s", c.name, got, c.want)
		}
	}
}

func TestStrings(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{`(plain)`, "plain"},
		{`(a (nested) b)`, "a (nested) b"},
		{`(esc \( \) \\ \n\r\t\b\f)`, "esc ( ) \\ \n\r\t\b\f"},
		{`(\101\1011\7)`, "AA1\a"},
		{`(\q)`, "q"},
		{"(line\\\r\ncontinued)", "linecontinued"},
		{"(cr\rcrlf\r\nlf\n)", "cr\ncrlf\nlf\n"},
		{`<41 42 4>`, "AB@"},
		{`<>`, ""},
	} {
		got, err := trace(t, c.in+" op")
		if err != nil {
			t.Errorf("%s: error %v", c.in, err)
			continue
		}
		if want := fmt.Sprintf("op %q\n", c.want); got != want {
			t.Errorf("%s: got %s want %s", c.in, got, want)
		}
	}
}

// Every construct still open at the end of the input stops there: the
// loop rsc.io/pdf runs instead is what this package exists to avoid.
func TestOpenAtTheEnd(t *testing.T) {
	for _, in := range []string{
		"0 0 m 10 0 l S [",
		"0 0 m 10 0 l S [(a) 2",
		"0 0 m 10 0 l S (unterminated",
		"0 0 m 10 0 l S (a\\",
		"0 0 m 10 0 l S <4142",
		"0 0 m 10 0 l S << /A 1",
		"0 0 m 10 0 l S [[<< /A [1",
		"0 0 m 10 0 l S BI /W 1 /H 1 ID \x00\x01",
		"0 0 m 10 0 l S BI /W 1",
	} {
		got, err := trace(t, in)
		if !errors.Is(err, ErrOpen) {
			t.Errorf("%q: error %v, want ErrOpen", in, err)
		}
		if want := "m 0 0\nl 10 0\nS\n"; got != want {
			t.Errorf("%q: got %q, want the operators before it, %q", in, got, want)
		}
	}
}

func TestDepth(t *testing.T) {
	in := strings.Repeat("[", MaxDepth+1) + strings.Repeat("]", MaxDepth+1) + " op"
	if _, err := trace(t, in); !errors.Is(err, ErrDepth) {
		t.Errorf("error %v, want ErrDepth", err)
	}
	in = strings.Repeat("[", MaxDepth) + strings.Repeat("]", MaxDepth) + " op"
	if _, err := trace(t, in); err != nil {
		t.Errorf("at the limit: error %v", err)
	}
}

// An inline image's data is skipped whatever it holds: the parentheses and
// brackets in it would open a string or an array to a lexer reading on.
func TestInlineImage(t *testing.T) {
	in := "q BI /W 4 /H 1 /BPC 8 /CS /G ID \x00(\xff[EIE I EI Q"
	got, err := trace(t, in)
	if err != nil {
		t.Fatal(err)
	}
	if want := "q\nEI /W 4 /H 1 /BPC 8 /CS /G\nQ\n"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	// EI closing the stream, with nothing after it.
	if got, err := trace(t, "BI /W 1 ID x EI"); err != nil || got != "EI /W 1\n" {
		t.Errorf("EI at the end: got %q, %v", got, err)
	}
}

// Whatever the input, Interpret returns, and does not panic.
func FuzzInterpret(f *testing.F) {
	for _, s := range []string{
		"0 0 m 10 0 l S [", "[(a) 2 (b)] TJ", "(a (b) \\) c", "<414", "<< /A [1 2] >> op",
		"BI /W 1 ID \x00 EI Q", "%comment", "/F#20 1 Tf", ") ] >> }",
	} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		ops := 0
		_ = Interpret(data, func(string, []Operand) { ops++ })
		if ops > len(data) {
			t.Errorf("%d operators from %d bytes", ops, len(data))
		}
	})
}
