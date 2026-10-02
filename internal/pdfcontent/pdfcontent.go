// Package pdfcontent reads a PDF content stream (ISO 32000-1 7.8.2): the
// operators a page or a form draws with, each with the operands before it.
//
// rsc.io/pdf has an interpreter, and it must not be given a stream it has
// not already seen end cleanly. Its lexer never reports the end of its
// input: past it every read answers a newline. So an array still open at
// the end appends the end-of-file token to itself forever, a literal
// string appends the newline forever, and a hex string spins without
// allocating. An open array is not even malformed. A page's /Contents may
// be an array of streams cut anywhere between two tokens, "as if all of
// the streams in the array were concatenated", and Romania's AIP cuts one
// right after a TJ array's "[" (ENR 2.2, pages 1 and 4). Read one part at
// a time, that grew a process to 40 GB in a minute. And the parts cannot
// be joined for rsc.io/pdf, whose interpreter takes only its own stream
// objects.
//
// So the lexer is ours, over bytes the caller joins; rsc.io/pdf still
// finds the objects and decodes the streams. It never reads past the end
// of its input, every loop consumes a byte, nesting is bounded, and a
// string, an array, a dictionary or an inline image still open at the end
// stops there, reported as ErrOpen.
package pdfcontent

import (
	"errors"
	"fmt"
	"strconv"
)

// Kind is an operand's type.
type Kind uint8

const (
	Null Kind = iota
	Bool
	Number
	String
	Name
	Array
	Dict
)

// Operand is one operand: a number, a boolean, a string's bytes, a name
// without its slash, an array's elements, or a dictionary's keys and
// values in turn.
type Operand struct {
	Kind  Kind
	Num   float64
	Bool  bool
	Str   string
	Items []Operand
}

// Float64 is the operand as a number, 0 when it is not one.
func (o Operand) Float64() float64 {
	if o.Kind == Number {
		return o.Num
	}
	return 0
}

// Name is the operand as a name, "" when it is not one.
func (o Operand) Name() string {
	if o.Kind == Name {
		return o.Str
	}
	return ""
}

// ErrOpen reports a stream ending inside a string, an array, a dictionary
// or an inline image. Everything read before it has been handed on.
var ErrOpen = errors.New("pdfcontent: stream ends inside an open construct")

// ErrDepth reports arrays and dictionaries nested deeper than MaxDepth.
var ErrDepth = errors.New("pdfcontent: nesting too deep")

// MaxDepth bounds the nesting of arrays and dictionaries. A content
// stream nests one or two deep (a TJ array, a marked-content property
// list); a thousand opening brackets is an attack or a lexing mistake.
const MaxDepth = 64

// Interpret calls do for every operator in data, in order, with the
// operands read since the one before. The operand slice is do's to keep.
// An inline image (BI ... ID data EI) is one call, "EI", its operands the
// image dictionary's keys and values.
//
// It returns ErrOpen, wrapped, when data ends inside a construct, and
// ErrDepth when nesting runs deeper than MaxDepth; the operators before
// either have been handed to do. Stray closing delimiters are skipped.
func Interpret(data []byte, do func(op string, args []Operand)) error {
	l := &lexer{b: data}
	var args []Operand
	for {
		o, t, err := l.next(0)
		if err != nil {
			return err
		}
		switch t {
		case tokEOF:
			return nil
		case tokOperand:
			args = append(args, o)
		case tokOperator:
			if o.Str == "BI" {
				entries, err := l.inlineImage()
				if err != nil {
					return err
				}
				do("EI", entries)
				args = nil
				continue
			}
			do(o.Str, args)
			args = nil
		}
		// A stray ] or >> at the top level is skipped: tokEndArray and
		// tokEndDict fall through here.
	}
}

type tok uint8

const (
	tokEOF tok = iota
	tokOperand
	tokOperator
	tokEndArray
	tokEndDict
)

type lexer struct {
	b   []byte
	pos int
}

func isSpace(c byte) bool {
	switch c {
	case 0, '\t', '\n', '\f', '\r', ' ':
		return true
	}
	return false
}

func isDelim(c byte) bool {
	switch c {
	case '(', ')', '<', '>', '[', ']', '{', '}', '/', '%':
		return true
	}
	return false
}

// skipSpace skips whitespace and comments.
func (l *lexer) skipSpace() {
	for l.pos < len(l.b) {
		switch c := l.b[l.pos]; {
		case isSpace(c):
			l.pos++
		case c == '%':
			for l.pos < len(l.b) && l.b[l.pos] != '\r' && l.b[l.pos] != '\n' {
				l.pos++
			}
		default:
			return
		}
	}
}

func openErr(what string, at int) error {
	return fmt.Errorf("%w: %s opened at byte %d", ErrOpen, what, at)
}

// next reads one token: an operand (a composite read whole), an operator,
// or the end of an array or a dictionary. depth is the nesting the token
// sits in.
func (l *lexer) next(depth int) (Operand, tok, error) {
	for {
		l.skipSpace()
		if l.pos >= len(l.b) {
			return Operand{}, tokEOF, nil
		}
		start := l.pos
		switch c := l.b[l.pos]; c {
		case '(':
			l.pos++
			s, err := l.literal(start)
			return Operand{Kind: String, Str: s}, tokOperand, err
		case '<':
			if l.pos+1 < len(l.b) && l.b[l.pos+1] == '<' {
				l.pos += 2
				items, err := l.seq(depth+1, tokEndDict, "dictionary", start)
				return Operand{Kind: Dict, Items: items}, tokOperand, err
			}
			l.pos++
			s, err := l.hex(start)
			return Operand{Kind: String, Str: s}, tokOperand, err
		case '>':
			l.pos++
			if l.pos < len(l.b) && l.b[l.pos] == '>' {
				l.pos++
				return Operand{}, tokEndDict, nil
			}
			continue // a stray '>'
		case '[':
			l.pos++
			items, err := l.seq(depth+1, tokEndArray, "array", start)
			return Operand{Kind: Array, Items: items}, tokOperand, err
		case ']':
			l.pos++
			return Operand{}, tokEndArray, nil
		case '/':
			l.pos++
			return Operand{Kind: Name, Str: l.name()}, tokOperand, nil
		case ')', '{', '}':
			l.pos++ // stray, or a PostScript brace no content stream uses
			continue
		}
		// A run of regular characters, at least the one just seen: every
		// delimiter was handled above and skipSpace took the whitespace.
		for l.pos < len(l.b) && !isSpace(l.b[l.pos]) && !isDelim(l.b[l.pos]) {
			l.pos++
		}
		w := string(l.b[start:l.pos])
		switch {
		case w == "true" || w == "false":
			return Operand{Kind: Bool, Bool: w == "true"}, tokOperand, nil
		case w == "null":
			return Operand{Kind: Null}, tokOperand, nil
		case isNumber(w):
			f, err := strconv.ParseFloat(w, 64)
			if err == nil {
				return Operand{Kind: Number, Num: f}, tokOperand, nil
			}
		}
		return Operand{Kind: Name, Str: w}, tokOperator, nil
	}
}

// seq reads an array's or a dictionary's items up to its end token. An
// operator inside one is malformed and dropped, as is the other kind's
// end token.
func (l *lexer) seq(depth int, end tok, what string, start int) ([]Operand, error) {
	if depth > MaxDepth {
		return nil, fmt.Errorf("%w: at byte %d", ErrDepth, start)
	}
	var items []Operand
	for {
		o, t, err := l.next(depth)
		if err != nil {
			return items, err
		}
		switch t {
		case tokEOF:
			return items, openErr(what, start)
		case end:
			return items, nil
		case tokOperand:
			items = append(items, o)
		}
	}
}

// isNumber reports a PDF number (7.3.3): an optional sign, digits and at
// most one period, at least one digit. strconv alone would also take
// "Inf", "NaN" and exponents, none of which PDF has.
func isNumber(w string) bool {
	digits, dot := 0, false
	for i := 0; i < len(w); i++ {
		switch c := w[i]; {
		case c >= '0' && c <= '9':
			digits++
		case c == '.' && !dot:
			dot = true
		case (c == '+' || c == '-') && i == 0:
		default:
			return false
		}
	}
	return digits > 0
}

// literal reads a literal string's bytes after its opening parenthesis
// (7.3.4.2): balanced parentheses nest, a backslash escapes, and an end
// of line not escaped reads as one line feed.
func (l *lexer) literal(start int) (string, error) {
	var out []byte
	depth := 1
	for l.pos < len(l.b) {
		c := l.b[l.pos]
		l.pos++
		switch c {
		case '(':
			depth++
			out = append(out, c)
		case ')':
			if depth--; depth == 0 {
				return string(out), nil
			}
			out = append(out, c)
		case '\r':
			if l.pos < len(l.b) && l.b[l.pos] == '\n' {
				l.pos++
			}
			out = append(out, '\n')
		case '\\':
			if l.pos >= len(l.b) {
				return string(out), openErr("string", start)
			}
			e := l.b[l.pos]
			l.pos++
			switch e {
			case 'n':
				out = append(out, '\n')
			case 'r':
				out = append(out, '\r')
			case 't':
				out = append(out, '\t')
			case 'b':
				out = append(out, '\b')
			case 'f':
				out = append(out, '\f')
			case '\r':
				// A line continuation: the backslash and the end of line
				// read as nothing.
				if l.pos < len(l.b) && l.b[l.pos] == '\n' {
					l.pos++
				}
			case '\n':
			case '0', '1', '2', '3', '4', '5', '6', '7':
				v := int(e - '0')
				for i := 0; i < 2 && l.pos < len(l.b) && l.b[l.pos] >= '0' && l.b[l.pos] <= '7'; i++ {
					v = v*8 + int(l.b[l.pos]-'0')
					l.pos++
				}
				out = append(out, byte(v)) // high-order overflow is ignored
			default:
				// ( ) \ stand for themselves, and so does any other
				// character: the backslash alone is dropped.
				out = append(out, e)
			}
		default:
			out = append(out, c)
		}
	}
	return string(out), openErr("string", start)
}

func unhex(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// hex reads a hexadecimal string's bytes after its "<" (7.3.4.3). Anything
// but a digit is skipped, and an odd final digit reads as if followed by 0.
func (l *lexer) hex(start int) (string, error) {
	var out []byte
	var hi byte
	half := false
	for l.pos < len(l.b) {
		c := l.b[l.pos]
		l.pos++
		if c == '>' {
			if half {
				out = append(out, hi<<4)
			}
			return string(out), nil
		}
		v, ok := unhex(c)
		if !ok {
			continue
		}
		if half {
			out = append(out, hi<<4|v)
		} else {
			hi = v
		}
		half = !half
	}
	return string(out), openErr("hex string", start)
}

// name reads a name's characters after its slash, #xx escapes decoded.
func (l *lexer) name() string {
	var out []byte
	for l.pos < len(l.b) && !isSpace(l.b[l.pos]) && !isDelim(l.b[l.pos]) {
		c := l.b[l.pos]
		l.pos++
		if c == '#' && l.pos+1 < len(l.b) {
			hi, ok1 := unhex(l.b[l.pos])
			lo, ok2 := unhex(l.b[l.pos+1])
			if ok1 && ok2 {
				out = append(out, hi<<4|lo)
				l.pos += 2
				continue
			}
		}
		out = append(out, c)
	}
	return string(out)
}

// inlineImage reads an inline image after its BI (8.9.7): the dictionary's
// keys and values up to ID, one whitespace byte, then the data up to an EI
// standing between whitespace and whitespace or the end. The data's length
// is not stated before PDF 2.0, so the delimited EI is how every reader
// finds the end.
func (l *lexer) inlineImage() ([]Operand, error) {
	start := l.pos
	var entries []Operand
	for {
		o, t, err := l.next(0)
		if err != nil {
			return entries, err
		}
		if t == tokEOF {
			return entries, openErr("inline image", start)
		}
		if t == tokOperator && o.Str == "ID" {
			break
		}
		if t == tokOperand {
			entries = append(entries, o)
		}
	}
	if l.pos < len(l.b) && isSpace(l.b[l.pos]) {
		l.pos++
	}
	for i := l.pos; i+1 < len(l.b); i++ {
		if l.b[i] != 'E' || l.b[i+1] != 'I' {
			continue
		}
		if i > 0 && !isSpace(l.b[i-1]) {
			continue
		}
		if i+2 < len(l.b) && !isSpace(l.b[i+2]) {
			continue
		}
		l.pos = i + 2
		return entries, nil
	}
	l.pos = len(l.b)
	return entries, openErr("inline image", start)
}
