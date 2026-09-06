// interpret.go walks a VAC plate's content stream and flattens what the
// page draws into page space: straight path edges, rectangles and show
// strings, each already pushed through the current transformation matrix.
//
// rsc.io/pdf cannot do this for us, and two of its behaviours are traps a
// naive port of cmd/supaip/pdf.go would walk straight into:
//
//   - Page.Content() PANICS on every French VAC plate. Their /Contents is an
//     ARRAY of streams, which Value.Reader() rejects, and the resulting error
//     is not io.EOF so the buffer panics rather than stopping. The array is
//     one logical stream per PDF 32000-1 7.8.2, so we read the parts in order
//     and carry the graphics state across them.
//   - Content() ignores Do entirely, treats m/l/c as no-ops and reports re
//     WITHOUT applying the CTM. On these plates that is everything: the whole
//     chart is a single /I0 Do under two chained cm matrices, so a walk that
//     does not enter Form XObjects sees an empty page.
//
// So the operator set is ours, over the exported pdf.Interpret. Only the
// font machinery is borrowed (pdf.Font.Encoder / Width), which is what keeps
// this command free of a poppler dependency: the geometry and the graticule
// labels come out of the same walk, in the same coordinate space, and cannot
// disagree about where a tick is.

package main

import (
	"fmt"
	"math"
	"strings"

	"rsc.io/pdf"
)

// maxFormDepth bounds Form XObject recursion. A self-referencing form is
// malformed but must not hang a scheduled build.
const maxFormDepth = 8

// mat is a PDF transformation matrix [a b c d e f] in the row-vector
// convention of PDF 32000-1 8.3.3: [x y 1] times [[a b 0] [c d 0] [e f 1]].
type mat [6]float64

var identity = mat{1, 0, 0, 1, 0, 0}

// mul returns the matrix that applies m first and then n, which is the
// order cm needs: the operand transforms into the space the CTM already
// describes.
func (m mat) mul(n mat) mat {
	return mat{
		m[0]*n[0] + m[1]*n[2],
		m[0]*n[1] + m[1]*n[3],
		m[2]*n[0] + m[3]*n[2],
		m[2]*n[1] + m[3]*n[3],
		m[4]*n[0] + m[5]*n[2] + n[4],
		m[4]*n[1] + m[5]*n[3] + n[5],
	}
}

func (m mat) apply(x, y float64) (float64, float64) {
	return m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]
}

// scale is the uniform scale factor the matrix applies, used to size text
// and to reject degenerate transforms.
func (m mat) scale() float64 {
	return math.Sqrt(math.Abs(m[0]*m[3] - m[1]*m[2]))
}

// seg is one straight edge of a drawn path, in page space.
type seg struct {
	x1, y1, x2, y2 float64
}

func (s seg) length() float64 {
	return math.Hypot(s.x2-s.x1, s.y2-s.y1)
}

// box is an axis-aligned rectangle in page space.
type box struct {
	x0, y0, x1, y1 float64
}

// holds reports whether a page point falls inside the box.
func (b box) holds(p [2]float64) bool {
	return p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1
}

func (b box) width() float64  { return b.x1 - b.x0 }
func (b box) height() float64 { return b.y1 - b.y0 }

// textRun is one show string with its page-space origin, the effective font
// size after the CTM, and the horizontal advance it consumed. A coordinate
// label may be drawn as one run ("002°35'") or as several ("002°" then
// "35'"), so the label grammar works on runs and joins neighbours itself.
type textRun struct {
	x, y float64
	size float64
	adv  float64
	text string
}

// poly is one closed subpath, kept whole because a shape's identity is in
// its outline: the runway on a ground-movement chart is a long thin filled
// quadrilateral, and nothing else on the sheet looks like one.
type poly struct {
	pts    []float64 // flattened x,y pairs, page space
	filled bool
}

// pageContent is everything one page draws, flattened into page space,
// with the sheet it was drawn on.
type pageContent struct {
	media box
	segs  []seg
	rects []box
	polys []poly
	runs  []textRun
}

// gstate is the part of the PDF graphics state this walk tracks.
type gstate struct {
	ctm    mat
	font   pdf.Font
	enc    pdf.TextEncoding
	hasFnt bool
	tfs    float64
	tc     float64
	tw     float64
	th     float64
	trise  float64
	tl     float64
}

type walker struct {
	out   pageContent
	stack []gstate
	g     gstate

	// encoders, keyed by the font's subset-prefixed BaseFont name: one
	// /Differences table per font program, not one per Tf.
	encs map[string]pdf.TextEncoding

	// current path, in page space
	cur   []float64 // flattened x,y pairs
	start [2]float64
	open  bool
	fill  bool // the paint operator now closing the path fills it

	// text object state
	tm, tlm mat
	inText  bool
}

// walkPage flattens one page. It never returns a partial-and-plausible
// result: a panic anywhere in rsc.io/pdf (a malformed stream, an
// unsupported /Filter, a Reader() on a non-stream) becomes an error, the
// cmd/supaip/pdf.go discipline.
func walkPage(p pdf.Page) (c pageContent, err error) {
	defer func() {
		if r := recover(); r != nil {
			c = pageContent{}
			err = fmt.Errorf("pdf walk panic: %v", r)
		}
	}()
	w := &walker{g: gstate{ctm: identity, th: 1}, encs: map[string]pdf.TextEncoding{}}
	w.out.media = mediaBox(p)
	for _, strm := range contentStreams(p) {
		w.interpret(strm, p.Resources(), 0)
	}
	return w.out, nil
}

// mediaBox reads the sheet size. Page.MediaBox() is commented out in
// rsc.io/pdf v0.1.1, and the attribute is inheritable, so the walk up the
// page tree is ours; an unreadable one falls back to A5 portrait, which is
// what every plate in the corpus is.
func mediaBox(p pdf.Page) box {
	for v := p.V; !v.IsNull(); v = v.Key("Parent") {
		mb := v.Key("MediaBox")
		if mb.Kind() == pdf.Array && mb.Len() == 4 {
			return box{
				x0: math.Min(mb.Index(0).Float64(), mb.Index(2).Float64()),
				y0: math.Min(mb.Index(1).Float64(), mb.Index(3).Float64()),
				x1: math.Max(mb.Index(0).Float64(), mb.Index(2).Float64()),
				y1: math.Max(mb.Index(1).Float64(), mb.Index(3).Float64()),
			}
		}
	}
	return box{x1: 419.528, y1: 595.276}
}

// contentStreams returns the page's content stream parts in order. A single
// stream and an array of streams are the same logical stream; operators may
// straddle the boundary, so the caller keeps one graphics state across them.
func contentStreams(p pdf.Page) []pdf.Value {
	c := p.V.Key("Contents")
	if c.Kind() != pdf.Array {
		return []pdf.Value{c}
	}
	out := make([]pdf.Value, 0, c.Len())
	for i := 0; i < c.Len(); i++ {
		out = append(out, c.Index(i))
	}
	return out
}

func (w *walker) interpret(strm pdf.Value, res pdf.Value, depth int) {
	pdf.Interpret(strm, func(stk *pdf.Stack, op string) {
		// Drain on EVERY operator: Interpret never clears the stack, so
		// operands left behind by an op we ignore would shift the next
		// one's arguments.
		n := stk.Len()
		args := make([]pdf.Value, n)
		for i := n - 1; i >= 0; i-- {
			args[i] = stk.Pop()
		}
		w.do(op, args, res, depth)
	})
}

func num(args []pdf.Value, i int) float64 {
	if i < 0 || i >= len(args) {
		return 0
	}
	return args[i].Float64()
}

func (w *walker) do(op string, args []pdf.Value, res pdf.Value, depth int) {
	switch op {
	case "q":
		w.stack = append(w.stack, w.g)
	case "Q":
		if n := len(w.stack); n > 0 {
			w.g = w.stack[n-1]
			w.stack = w.stack[:n-1]
		}
	case "cm":
		if len(args) >= 6 {
			m := mat{num(args, 0), num(args, 1), num(args, 2), num(args, 3), num(args, 4), num(args, 5)}
			w.g.ctm = m.mul(w.g.ctm)
		}
	case "gs", "d", "w", "J", "j", "M", "i", "ri":
		// Graphics state parameters we do not need; drained above.

	case "m":
		w.flush()
		x, y := w.g.ctm.apply(num(args, 0), num(args, 1))
		w.cur = []float64{x, y}
		w.start = [2]float64{x, y}
		w.open = true
	case "l":
		w.lineTo(num(args, 0), num(args, 1))
	case "c":
		// Curves contribute their endpoint only. Nothing this command
		// looks for (tick marks, neatlines, runway edges) is a curve, and
		// flattening one would invent vertices a straightness test then
		// has to reject.
		w.lineTo(num(args, 4), num(args, 5))
	case "v", "y":
		w.lineTo(num(args, 2), num(args, 3))
	case "h":
		w.closePath()
	case "re":
		w.flush()
		x, y, rw, rh := num(args, 0), num(args, 1), num(args, 2), num(args, 3)
		w.addRect(x, y, rw, rh)
	case "f", "F", "f*", "B", "B*", "b", "b*", "S", "s", "n":
		if op == "b" || op == "b*" || op == "s" {
			w.closePath()
		}
		switch op {
		case "f", "F", "f*", "B", "B*", "b", "b*":
			w.fill = true
		}
		w.flush()
		w.fill = false

	case "BT":
		w.inText = true
		w.tm, w.tlm = identity, identity
	case "ET":
		w.inText = false
	case "Tf":
		w.g.tfs = num(args, 1)
		if len(args) >= 1 {
			f := pdf.Font{V: res.Key("Font").Key(args[0].Name())}
			w.g.font, w.g.hasFnt = f, !f.V.IsNull()
			w.g.enc = nil
			if w.g.hasFnt {
				key := f.BaseFont()
				enc, ok := w.encs[key]
				if !ok {
					enc = fontEncoder(f)
					w.encs[key] = enc
				}
				w.g.enc = enc
			}
		}
	case "Tc":
		w.g.tc = num(args, 0)
	case "Tw":
		w.g.tw = num(args, 0)
	case "Tz":
		w.g.th = num(args, 0) / 100
	case "TL":
		w.g.tl = num(args, 0)
	case "Ts":
		w.g.trise = num(args, 0)
	case "Td":
		w.tlm = mat{1, 0, 0, 1, num(args, 0), num(args, 1)}.mul(w.tlm)
		w.tm = w.tlm
	case "TD":
		w.g.tl = -num(args, 1)
		w.tlm = mat{1, 0, 0, 1, num(args, 0), num(args, 1)}.mul(w.tlm)
		w.tm = w.tlm
	case "Tm":
		if len(args) >= 6 {
			w.tlm = mat{num(args, 0), num(args, 1), num(args, 2), num(args, 3), num(args, 4), num(args, 5)}
			w.tm = w.tlm
		}
	case "T*":
		w.nextLine()
	case "Tj", "TJ":
		w.show(args)
	case "'":
		w.nextLine()
		w.show(args)
	case "\"":
		w.g.tw = num(args, 0)
		w.g.tc = num(args, 1)
		w.nextLine()
		w.show(args[min(2, len(args)):])

	case "Do":
		if depth >= maxFormDepth || len(args) == 0 {
			return
		}
		w.drawXObject(args[0].Name(), res, depth)
	}
}

func (w *walker) lineTo(x, y float64) {
	if !w.open {
		return
	}
	px, py := w.g.ctm.apply(x, y)
	w.cur = append(w.cur, px, py)
}

func (w *walker) closePath() {
	if !w.open || len(w.cur) < 2 {
		return
	}
	w.cur = append(w.cur, w.start[0], w.start[1])
}

// flush turns the pending subpath into segments. Paths are recorded when
// the path is painted OR abandoned: a clipped-and-discarded path still
// tells us where a neatline runs.
func (w *walker) flush() {
	for i := 0; i+3 < len(w.cur); i += 2 {
		w.out.segs = append(w.out.segs, seg{w.cur[i], w.cur[i+1], w.cur[i+2], w.cur[i+3]})
	}
	if len(w.cur) >= 6 {
		w.out.polys = append(w.out.polys, poly{pts: append([]float64(nil), w.cur...), filled: w.fill})
	}
	w.cur = nil
	w.open = false
}

func (w *walker) addRect(x, y, rw, rh float64) {
	xs := make([]float64, 0, 4)
	ys := make([]float64, 0, 4)
	for _, c := range [4][2]float64{{x, y}, {x + rw, y}, {x + rw, y + rh}, {x, y + rh}} {
		px, py := w.g.ctm.apply(c[0], c[1])
		xs = append(xs, px)
		ys = append(ys, py)
	}
	b := box{x0: xs[0], y0: ys[0], x1: xs[0], y1: ys[0]}
	for i := 1; i < 4; i++ {
		b.x0 = math.Min(b.x0, xs[i])
		b.y0 = math.Min(b.y0, ys[i])
		b.x1 = math.Max(b.x1, xs[i])
		b.y1 = math.Max(b.y1, ys[i])
	}
	w.out.rects = append(w.out.rects, b)
	// A rectangle is also four edges: the neatline of an APP panel is
	// sometimes an `re` and sometimes four `l`, and the tick search must
	// see both the same way.
	for i := 0; i < 4; i++ {
		j := (i + 1) % 4
		w.out.segs = append(w.out.segs, seg{xs[i], ys[i], xs[j], ys[j]})
	}
}

func (w *walker) nextLine() {
	w.tlm = mat{1, 0, 0, 1, 0, -w.g.tl}.mul(w.tlm)
	w.tm = w.tlm
}

// show renders the string operands of a text operator, advancing the text
// matrix by the glyph widths so a run's origin is where it really sits.
func (w *walker) show(args []pdf.Value) {
	if !w.inText {
		// Some producers show text with no BT; treat the text matrix as
		// identity rather than dropping the label.
		w.inText = true
	}
	for _, a := range args {
		switch a.Kind() {
		case pdf.Array:
			// A TJ operand. pdf.Interpret does NOT hand the array's
			// elements over one by one: it un-reads the opening bracket
			// and pushes the whole array as a single value. Ignoring
			// that kind drops every TJ on the page, which on these
			// plates is the entire header block, the ARP among it, with
			// no error anywhere to say so.
			sub := make([]pdf.Value, a.Len())
			for i := range sub {
				sub[i] = a.Index(i)
			}
			w.show(sub)
		case pdf.String:
			raw := a.RawString()
			trm := mat{w.g.tfs * w.g.th, 0, 0, w.g.tfs, 0, w.g.trise}.mul(w.tm).mul(w.g.ctm)
			text := raw
			if w.g.enc != nil {
				text = w.g.enc.Decode(raw)
			}
			adv := 0.0
			for i := 0; i < len(raw); i++ {
				code := int(raw[i])
				width := 0.0
				if w.g.hasFnt {
					width = w.g.font.Width(code) / 1000
				}
				step := width*w.g.tfs + w.g.tc
				if code == ' ' {
					step += w.g.tw
				}
				adv += step * w.g.th
			}
			w.tm = mat{1, 0, 0, 1, adv, 0}.mul(w.tm)
			// The advance is measured in PAGE space, between the run's
			// own origin and the pen after it: a label's width is what
			// tells the grammar whether the next run abuts it.
			end := mat{w.g.tfs * w.g.th, 0, 0, w.g.tfs, 0, w.g.trise}.mul(w.tm).mul(w.g.ctm)
			if s := strings.TrimSpace(text); s != "" {
				w.out.runs = append(w.out.runs, textRun{
					x:    trm[4],
					y:    trm[5],
					size: math.Abs(trm[0]),
					adv:  math.Hypot(end[4]-trm[4], end[5]-trm[5]),
					text: text,
				})
			}
		case pdf.Integer, pdf.Real:
			// TJ kerning: a positive number moves the next glyph LEFT.
			adj := -a.Float64() / 1000 * w.g.tfs * w.g.th
			w.tm = mat{1, 0, 0, 1, adj, 0}.mul(w.tm)
		}
	}
}

// drawXObject enters a Form XObject with its own Matrix folded into the CTM
// and its own Resources, falling back to the caller's when it declares none.
// Image XObjects are ignored: these plates draw no raster chart body.
func (w *walker) drawXObject(name string, res pdf.Value, depth int) {
	form := res.Key("XObject").Key(name)
	if form.IsNull() || form.Key("Subtype").Name() != "Form" {
		return
	}
	saved, savedStack := w.g, w.stack
	w.stack = nil
	if m := form.Key("Matrix"); m.Kind() == pdf.Array && m.Len() == 6 {
		var fm mat
		for i := 0; i < 6; i++ {
			fm[i] = m.Index(i).Float64()
		}
		w.g.ctm = fm.mul(w.g.ctm)
	}
	sub := form.Key("Resources")
	if sub.IsNull() {
		sub = res
	}
	w.interpret(form, sub, depth+1)
	w.flush()
	w.g, w.stack = saved, savedStack
}
