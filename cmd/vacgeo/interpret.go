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
	// The advance as a VECTOR, which is the only thing on this struct that
	// says which way the run runs. `size` is the text matrix's a
	// coefficient, so a run set at 90 degrees reports 0.00, and `adv` is a
	// magnitude; every reader that adds `adv` to `x` is assuming upright
	// text, which the labels are and a marking set into a turned panel is
	// not.
	ax, ay float64
	text   string
}

// poly is one closed subpath, kept whole because a shape's identity is in
// its outline: the runway on a ground-movement chart is a long thin filled
// quadrilateral, and nothing else on the sheet looks like one.
type poly struct {
	pts    []float64 // flattened x,y pairs, page space
	filled bool
	// curve marks, per point, the ones a CURVE operator reached. A bezier
	// contributes its endpoint alone (see the `c` case), so a drawn circle
	// arrives here as a diamond whose sides lie a third of the radius
	// inside the ink. Nothing in the reader minds: no tick, neatline or
	// runway edge is a curve. Anything that wants to tell a drawn straight
	// line from the chord of a bend has to be told, and this is the
	// telling. Nil on a path with no curve in it.
	curve []bool
}

// curved reports whether the edge leaving point i is the chord of a bend
// rather than a line the sheet drew.
func (p poly) curved(i int) bool {
	if p.curve == nil {
		return false
	}
	j := i + 1
	return (i < len(p.curve) && p.curve[i]) || (j < len(p.curve) && p.curve[j])
}

// bounds is the poly's extent.
func (p poly) bounds() box {
	b := box{x0: p.pts[0], y0: p.pts[1], x1: p.pts[0], y1: p.pts[1]}
	for i := 0; i+1 < len(p.pts); i += 2 {
		b.x0 = math.Min(b.x0, p.pts[i])
		b.y0 = math.Min(b.y0, p.pts[i+1])
		b.x1 = math.Max(b.x1, p.pts[i])
		b.y1 = math.Max(b.y1, p.pts[i+1])
	}
	return b
}

// pageContent is everything one page draws, flattened into page space,
// with the sheet it was drawn on.
type pageContent struct {
	media box
	segs  []seg
	rects []box
	polys []poly
	runs  []textRun
	// The windows a knockout left open, tightest first. Ink outside one
	// has already been dropped; what the box is still worth is that the
	// plate DREW where its panel ends, which is a frame.
	masks []box
}

// subpath is one finished piece of the path being built, kept only until
// the operator that paints it: a knockout is a statement about the path as
// a WHOLE, an outer rectangle with a hole in it, and neither piece says
// anything on its own.
type subpath struct {
	b    box
	rect bool    // a near-rectangle, so a plausible panel edge
	area float64 // signed, to tell a hole from a second outline
}

// knockout is one white fill that covered everything outside a rectangle,
// with how much ink had been laid down when it landed. Ink recorded after
// it is drawn OVER it and stays: on these plates the header block is set
// after the panel is masked, and the ARP is in the header.
type knockout struct {
	hole                         box
	nSegs, nRects, nPolys, nRuns int
}

// gstate is the part of the PDF graphics state this walk tracks.
type gstate struct {
	ctm    mat
	font   pdf.Font
	enc    pdf.TextEncoding
	hasFnt bool
	// Whether the non-stroking colour is white, which is the whole of what
	// this walk needs of colour: a white fill is the only one that can
	// UNDRAW something.
	white bool
	tfs   float64
	tc    float64
	tw    float64
	th    float64
	trise float64
	tl    float64
}

type walker struct {
	out   pageContent
	stack []gstate
	g     gstate

	// encoders, keyed by the font's subset-prefixed BaseFont name: one
	// /Differences table per font program, not one per Tf.
	encs map[string]pdf.TextEncoding

	// current path, in page space
	cur      []float64 // flattened x,y pairs
	curCurve []bool    // per point, reached by a curve operator
	start    [2]float64
	open     bool
	fill     bool      // the paint operator now closing the path fills it
	sub      []subpath // the pieces of it finished so far

	knockouts []knockout

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
	w.applyKnockouts()
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
	case "g", "rg", "k", "sc", "scn":
		// The non-stroking colour, kept only as "is it white". The
		// component conventions are the same in an ICCBased space as in
		// the device one it substitutes for, so sc/scn read by arity.
		w.g.white = isWhite(args)
	case "cs":
		// A colour space with no components yet. Whatever the space, the
		// initial colour is black in every one of them (PDF 32000-1
		// 8.6.8), and a pattern has no components at all.
		w.g.white = false

	case "m":
		w.flush()
		x, y := w.g.ctm.apply(num(args, 0), num(args, 1))
		w.cur = []float64{x, y}
		w.curCurve = []bool{false}
		w.start = [2]float64{x, y}
		w.open = true
	case "l":
		w.lineTo(num(args, 0), num(args, 1))
	case "c":
		// Curves contribute their endpoint only. Nothing this command
		// looks for (tick marks, neatlines, runway edges) is a curve, and
		// flattening one would invent vertices a straightness test then
		// has to reject. The endpoint is MARKED so that anything which
		// does mind can tell the chord from a drawn line.
		w.curveTo(num(args, 4), num(args, 5))
	case "v", "y":
		w.curveTo(num(args, 2), num(args, 3))
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
		// Taken before this path's own edges land, so a knockout never
		// undraws the rectangle that IS it.
		mark := knockout{
			nSegs: len(w.out.segs), nRects: len(w.out.rects),
			nPolys: len(w.out.polys), nRuns: len(w.out.runs),
		}
		w.flush()
		if w.fill && w.g.white {
			w.noteKnockout(mark, op == "f*" || op == "B*" || op == "b*")
		}
		w.fill = false
		w.sub = nil

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
	w.curCurve = append(w.curCurve, false)
}

func (w *walker) curveTo(x, y float64) {
	if !w.open {
		return
	}
	w.lineTo(x, y)
	if n := len(w.curCurve); n > 0 {
		w.curCurve[n-1] = true
	}
}

func (w *walker) closePath() {
	if !w.open || len(w.cur) < 2 {
		return
	}
	w.cur = append(w.cur, w.start[0], w.start[1])
	w.curCurve = append(w.curCurve, false)
}

// flush turns the pending subpath into segments. Paths are recorded when
// the path is painted OR abandoned: a clipped-and-discarded path still
// tells us where a neatline runs.
func (w *walker) flush() {
	for i := 0; i+3 < len(w.cur); i += 2 {
		w.out.segs = append(w.out.segs, seg{w.cur[i], w.cur[i+1], w.cur[i+2], w.cur[i+3]})
	}
	if len(w.cur) >= 6 {
		p := poly{pts: append([]float64(nil), w.cur...), filled: w.fill}
		for _, b := range w.curCurve {
			if b {
				p.curve = append([]bool(nil), w.curCurve...)
				break
			}
		}
		w.out.polys = append(w.out.polys, p)
	}
	if len(w.cur) >= 4 {
		w.sub = append(w.sub, subpathOf(w.cur))
	}
	w.cur = nil
	w.curCurve = nil
	w.open = false
}

// subpathOf measures one finished piece of a path: its extent, whether it
// is a rectangle whatever angle it is drawn at, and the sign of its area.
//
// The angle matters. A panel neatline is not always drawn square to the
// page: Sainte-Leocadie's approach sheet is turned a fifth of a degree, and
// a fifth of a degree is two points across a sheet, which is enough to hide
// the frame from every axis-aligned reader on the page.
func subpathOf(pts []float64) subpath {
	s := subpath{b: box{x0: pts[0], y0: pts[1], x1: pts[0], y1: pts[1]}}
	for i := 0; i+1 < len(pts); i += 2 {
		s.b.x0 = math.Min(s.b.x0, pts[i])
		s.b.y0 = math.Min(s.b.y0, pts[i+1])
		s.b.x1 = math.Max(s.b.x1, pts[i])
		s.b.y1 = math.Max(s.b.y1, pts[i+1])
		j := i + 2
		if j+1 >= len(pts) {
			j = 0
		}
		s.area += (pts[i]*pts[j+1] - pts[j]*pts[i+1]) / 2
	}
	s.rect = isRectangle(pts)
	return s
}

// isRectangle reports whether a closed subpath of four corners is a
// rectangle: every corner square within a couple of degrees and opposite
// sides the same length. The tolerance is drafting slop, not licence, since
// what this answers is whether a shape can be a panel edge at all.
func isRectangle(pts []float64) bool {
	cs := corners(pts)
	if len(cs) != 4 {
		return false
	}
	at := func(i int) (float64, float64) { return cs[i%4][0], cs[i%4][1] }
	for i := 0; i < 4; i++ {
		x, y := at(i)
		ax, ay := at(i + 3)
		bx, by := at(i + 1)
		ax, ay = ax-x, ay-y
		bx, by = bx-x, by-y
		la, lb := math.Hypot(ax, ay), math.Hypot(bx, by)
		if la < 1 || lb < 1 || math.Abs((ax*bx+ay*by)/(la*lb)) > 0.035 {
			return false
		}
	}
	for i := 0; i < 2; i++ {
		x0, y0 := at(i)
		x1, y1 := at(i + 1)
		x2, y2 := at(i + 2)
		x3, y3 := at(i + 3)
		a, b := math.Hypot(x1-x0, y1-y0), math.Hypot(x3-x2, y3-y2)
		if math.Abs(a/b-1) > 0.02 {
			return false
		}
	}
	return true
}

// isWhite reads a non-stroking colour operand list as white: gray 1, RGB
// 1 1 1 or CMYK 0 0 0 0. A name operand is a pattern, which paints ink of
// its own whatever the numbers beside it say.
func isWhite(args []pdf.Value) bool {
	for _, a := range args {
		if a.Kind() == pdf.Name {
			return false
		}
	}
	switch len(args) {
	case 1:
		return num(args, 0) >= 0.999
	case 3:
		return num(args, 0) >= 0.999 && num(args, 1) >= 0.999 && num(args, 2) >= 0.999
	case 4:
		return num(args, 0) <= 0.001 && num(args, 1) <= 0.001 &&
			num(args, 2) <= 0.001 && num(args, 3) <= 0.001
	}
	return false
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
	w.sub = append(w.sub, subpathOf([]float64{xs[0], ys[0], xs[1], ys[1], xs[2], ys[2], xs[3], ys[3]}))
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
					ax:   end[4] - trm[4],
					ay:   end[5] - trm[5],
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

// The share of the sheet a knockout's two halves must reach: the outer
// piece has to be the page (nothing smaller can undraw a whole margin) and
// the hole has to be big enough to be a map panel rather than a label halo.
const (
	knockoutOuterShare = 0.95
	knockoutHoleShare  = 0.10
)

// noteKnockout reads the white fill a plate paints over everything outside
// its panel.
//
// Sainte-Leocadie's approach sheet draws its chart WIDER than the panel and
// hides the overspill: an outer rectangle the size of the page, a hole the
// size of the map, filled with no ink at all (`0 0 0 0 k`). The graticule
// runs on under it, three parallels above the panel and two meridians to
// the left of it, and that hidden ink is what stretched the tick extent
// past every rectangle the sheet draws. The frame search then found nothing
// but the page, and Sainte-Leocadie shipped its whole plate over the ground,
// header and footer and all, the worst-clipped panel in the corpus.
//
// Ink nobody can see is not evidence. So the hole is recorded as a window
// on the sheet, everything earlier that falls outside it is dropped, and
// the window itself joins the frame candidates: a plate that says where its
// panel ends by painting out the rest has said it as plainly as one that
// draws a neatline.
func (w *walker) noteKnockout(mark knockout, evenOdd bool) {
	sheet := w.out.media.width() * w.out.media.height()
	if sheet <= 0 {
		return
	}
	var outer, hole *subpath
	for i := range w.sub {
		s := &w.sub[i]
		switch a := s.b.width() * s.b.height(); {
		case a >= sheet*knockoutOuterShare:
			if outer != nil {
				return
			}
			outer = s
		case s.rect && a >= sheet*knockoutHoleShare:
			if hole != nil {
				return
			}
			hole = s
		default:
			// Any third piece and the painted region is not a rectangle
			// with a rectangular hole, whatever the two candidates look
			// like. A degenerate subpath is not a piece: these plates open
			// a subpath and abandon it without drawing anything.
			if s.b.width() > 1 || s.b.height() > 1 {
				return
			}
		}
	}
	if outer == nil || hole == nil {
		return
	}
	// Under the nonzero rule the hole is only a hole when it is wound
	// against the outline; wound with it, the fill covers the panel too,
	// and a plate that whited out its own map is not what this reads. The
	// even-odd rule needs no such test.
	if !evenOdd && outer.area*hole.area > 0 {
		return
	}
	mark.hole = hole.b
	w.knockouts = append(w.knockouts, mark)
}

// applyKnockouts drops the ink each knockout covered and publishes the
// windows they left. Only what was already on the page is dropped: the
// header block, the ARP among it, is set AFTER the panel is masked.
func (w *walker) applyKnockouts() {
	for _, k := range w.knockouts {
		w.out.masks = append(w.out.masks, k.hole)
		segs := w.out.segs[:0:0]
		for i, s := range w.out.segs {
			if i >= k.nSegs || overlaps(k.hole, box{math.Min(s.x1, s.x2), math.Min(s.y1, s.y2),
				math.Max(s.x1, s.x2), math.Max(s.y1, s.y2)}) {
				segs = append(segs, s)
			}
		}
		w.out.segs = segs
		rects := w.out.rects[:0:0]
		for i, b := range w.out.rects {
			if i >= k.nRects || overlaps(k.hole, b) {
				rects = append(rects, b)
			}
		}
		w.out.rects = rects
		polys := w.out.polys[:0:0]
		for i, p := range w.out.polys {
			if i >= k.nPolys || overlaps(k.hole, p.bounds()) {
				polys = append(polys, p)
			}
		}
		w.out.polys = polys
		runs := w.out.runs[:0:0]
		for i, r := range w.out.runs {
			if i >= k.nRuns || overlaps(k.hole, box{r.x, r.y, r.x + r.adv, r.y + r.size}) {
				runs = append(runs, r)
			}
		}
		w.out.runs = runs
	}
}

// overlaps reports whether two boxes share any area, touching included: a
// tick hanging off a neatline has one end exactly on the boundary.
func overlaps(a, b box) bool {
	return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1
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
	// A path the form left unpainted is not a piece of the caller's next
	// one, whatever the stream looks like across the boundary.
	w.sub = nil
	w.g, w.stack = saved, savedStack
}
