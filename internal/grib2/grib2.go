// Package grib2 reads WMO GRIB edition 2 (FM 92), as far as the forecast
// feeds Loxodrome ingests use it: regular latitude/longitude grids
// (template 3.0), instantaneous and statistically processed products
// (templates 4.0 and 4.8), simple and CCSDS packing (templates 5.0 and
// 5.42) and bitmaps. Anything else is refused by name rather than guessed:
// a new template is a fact about the feed someone must look at.
//
// A file is a sequence of self-delimiting messages; a message may repeat
// sections 2 to 7, each section 7 closing one field over the sections
// most recently seen. Values come back in ONE canonical layout whatever
// the scanning mode: rows from north to south, each row from west to
// east, NaN where the bitmap says no value.
package grib2

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"time"

	"github.com/0intro/loxodrome/internal/aec"
)

// Grid is a regular latitude/longitude grid (template 3.0) in its
// canonical layout: point (i, j) lies at North - j*Dj, West + i*Di.
type Grid struct {
	Ni, Nj int
	North  float64 // latitude of row 0, degrees
	West   float64 // longitude of column 0, degrees in [-180, 180)
	Di, Dj float64 // degrees, positive
	// Wraps reports a grid whose columns go round the whole globe, the
	// point east of the last column being column 0.
	Wraps bool
	// GridRelative reports winds resolved along the grid's own axes
	// rather than east and north; on a regular lat/lon grid the two agree.
	GridRelative bool
	ScanMode     uint8 // as coded; Values already undid it
	EarthShape   uint8
}

// Points is the number of grid points.
func (g Grid) Points() int { return g.Ni * g.Nj }

// Surface is a fixed surface: its type (code table 4.5) and value in the
// table's unit (Pa for isobaric surfaces, metres above ground for 103).
type Surface struct {
	Type    uint8
	Value   float64
	Missing bool
}

// Field is one product: its identification, its grid and its packed data.
type Field struct {
	Discipline uint8
	Centre     uint16
	RefTime    time.Time // the reference (analysis) time
	Grid       Grid

	PDT        uint16 // product definition template number
	Category   uint8
	Number     uint8
	GenProcess uint8
	// Forecast is the forecast time (template 4.0), or the start of the
	// statistical period (template 4.8), after RefTime.
	Forecast time.Duration
	Surface1 Surface
	Surface2 Surface
	// For template 4.8: the statistical process (code table 4.10: 0
	// average, 1 accumulation, 2 maximum, 3 minimum), the period's length
	// and its end, which is when such a field is valid.
	StatProcess uint8
	Period      time.Duration
	PeriodEnd   time.Time

	DRT      uint16 // data representation template number
	Packed   int    // values present, the bitmap's count of ones
	Ref      float32
	BinScale int
	DecScale int
	Bits     int
	CCSDS    aec.Params

	bitmap []byte // nil when every point has a value
	data   []byte
	// Offset and Length locate the message in its file.
	Offset int64
	Length int64
}

// ValidTime is when the field applies: the end of the period for a
// statistically processed field, the forecast time otherwise.
func (f *Field) ValidTime() time.Time {
	if f.PDT == 8 {
		return f.PeriodEnd
	}
	return f.RefTime.Add(f.Forecast)
}

// Key names a field by everything that tells two apart within one run.
type Key struct {
	Discipline, Category, Number uint8
	PDT                          uint16
	StatProcess                  uint8
	Surface                      uint8
	Level                        float64
	Valid                        time.Time
}

// Key returns the field's identity.
func (f *Field) Key() Key {
	k := Key{Discipline: f.Discipline, Category: f.Category, Number: f.Number,
		PDT: f.PDT, Surface: f.Surface1.Type, Level: f.Surface1.Value, Valid: f.ValidTime()}
	if f.PDT == 8 {
		k.StatProcess = f.StatProcess
	}
	return k
}

func (k Key) String() string {
	s := fmt.Sprintf("%d/%d/%d pdt%d sfc%d %g %s", k.Discipline, k.Category, k.Number, k.PDT, k.Surface, k.Level, k.Valid.UTC().Format("2006-01-02T15:04Z"))
	if k.PDT == 8 {
		s += fmt.Sprintf(" stat%d", k.StatProcess)
	}
	return s
}

// Reader walks the messages of a stream.
type Reader struct {
	r   *bufio.Reader
	off int64
}

// NewReader reads messages from r.
func NewReader(r io.Reader) *Reader {
	return &Reader{r: bufio.NewReaderSize(r, 1<<16)}
}

// maxMessage bounds one message: the largest these feeds write is a few MB,
// and the buffer is allocated before it is read, so a header claiming a
// gigabyte must not be believed (twenty such headers allocated 21 GB).
const maxMessage = 64 << 20

// maxPoints bounds a grid: IFS's global 0.25° is about a million points, and
// a field's samples are allocated by its stated count before any data is
// read (a 183-byte 0-bit message claiming 65536 x 65535 points asked for
// 34 GB).
const maxPoints = 1 << 24

// Next returns the next message's bytes and its offset in the stream, or
// io.EOF after the last.
func (r *Reader) Next() ([]byte, int64, error) {
	var head [16]byte
	if _, err := io.ReadFull(r.r, head[:]); err != nil {
		if err == io.EOF {
			return nil, 0, io.EOF
		}
		return nil, 0, fmt.Errorf("grib2: message header at %d: %w", r.off, err)
	}
	// Octets 5-6 are reserved: Météo-France writes 0xFFFF there, so they
	// are not checked.
	if string(head[:4]) != "GRIB" {
		return nil, 0, fmt.Errorf("grib2: no GRIB indicator at offset %d", r.off)
	}
	if head[7] != 2 {
		return nil, 0, fmt.Errorf("grib2: edition %d at offset %d", head[7], r.off)
	}
	n := binary.BigEndian.Uint64(head[8:])
	if n < 16+4 || n > maxMessage {
		return nil, 0, fmt.Errorf("grib2: message length %d at offset %d", n, r.off)
	}
	msg := make([]byte, n)
	copy(msg, head[:])
	if _, err := io.ReadFull(r.r, msg[16:]); err != nil {
		return nil, 0, fmt.Errorf("grib2: message at %d: %w", r.off, err)
	}
	off := r.off
	r.off += int64(n)
	return msg, off, nil
}

func be16(b []byte) uint16 { return binary.BigEndian.Uint16(b) }
func be32(b []byte) uint32 { return binary.BigEndian.Uint32(b) }

// sm16 and sm32 read GRIB's sign-and-magnitude integers.
func sm16(b []byte) int {
	v := int(be16(b) & 0x7FFF)
	if b[0]&0x80 != 0 {
		return -v
	}
	return v
}

func sm32(b []byte) int64 {
	v := int64(be32(b) & 0x7FFFFFFF)
	if b[0]&0x80 != 0 {
		return -v
	}
	return v
}

func sm8(b byte) int {
	v := int(b & 0x7F)
	if b&0x80 != 0 {
		return -v
	}
	return v
}

// ErrUnsupported marks a template or feature this reader refuses.
var ErrUnsupported = errors.New("grib2: unsupported")

// Identity is what a message's first field says it is, read without
// interpreting any template: the discipline, and the product template's
// number with the parameter category and number, which sit at the same
// octets of section 4 whatever the template.
type Identity struct {
	Discipline, Category, Number uint8
	PDT                          uint16
}

// Peek reads a message's Identity, so that a message in a form Parse
// refuses can still be told apart from the fields a reader wants.
func Peek(msg []byte) (Identity, error) {
	if len(msg) < 16+4 || string(msg[:4]) != "GRIB" {
		return Identity{}, errors.New("grib2: not a GRIB message")
	}
	id := Identity{Discipline: msg[6]}
	for p := 16; p+5 <= len(msg)-4; {
		n := int(be32(msg[p:]))
		if n < 5 || p+n > len(msg)-4 {
			return Identity{}, fmt.Errorf("grib2: section length %d at %d", n, p)
		}
		if msg[p+4] == 4 {
			if n < 11 {
				return Identity{}, errors.New("grib2: short section 4")
			}
			id.PDT = be16(msg[p+7:])
			id.Category = msg[p+9]
			id.Number = msg[p+10]
			return id, nil
		}
		p += n
	}
	return Identity{}, errors.New("grib2: no product definition section")
}

// Parse reads every field of one message. The fields' data alias msg.
func Parse(msg []byte, offset int64) ([]*Field, error) {
	if len(msg) < 16+4 || string(msg[:4]) != "GRIB" {
		return nil, errors.New("grib2: not a GRIB message")
	}
	if string(msg[len(msg)-4:]) != "7777" {
		return nil, fmt.Errorf("grib2: message at %d does not end in 7777", offset)
	}
	disc := msg[6]
	var (
		fields  []*Field
		cur     Field
		bitmap  []byte
		have    [8]bool
		gridPts int
	)
	cur.Discipline = disc
	cur.Offset = offset
	cur.Length = int64(len(msg))
	p := 16
	for p < len(msg)-4 {
		if p+5 > len(msg) {
			return nil, fmt.Errorf("grib2: truncated section at %d", offset+int64(p))
		}
		n := int(be32(msg[p:]))
		num := msg[p+4]
		if n < 5 || p+n > len(msg)-4 {
			return nil, fmt.Errorf("grib2: section %d length %d at %d", num, n, offset+int64(p))
		}
		s := msg[p : p+n]
		var err error
		switch num {
		case 1:
			err = cur.section1(s)
		case 2:
			// local use
		case 3:
			gridPts, err = cur.section3(s)
		case 4:
			err = cur.section4(s)
		case 5:
			err = cur.section5(s)
		case 6:
			bitmap, err = section6(s, bitmap)
		case 7:
			if !have[1] || !have[3] || !have[4] || !have[5] || !have[6] {
				return nil, fmt.Errorf("grib2: data section before its definitions at %d", offset+int64(p))
			}
			f := cur
			f.data = s[5:]
			f.bitmap = bitmap
			if err := f.checkCounts(gridPts); err != nil {
				return nil, err
			}
			fields = append(fields, &f)
		default:
			err = fmt.Errorf("grib2: section number %d at %d", num, offset+int64(p))
		}
		if err != nil {
			return nil, err
		}
		if num < 8 {
			have[num] = true
		}
		p += n
	}
	if len(fields) == 0 {
		return nil, fmt.Errorf("grib2: message at %d holds no field", offset)
	}
	return fields, nil
}

func (f *Field) section1(s []byte) error {
	if len(s) < 21 {
		return errors.New("grib2: short section 1")
	}
	f.Centre = be16(s[5:])
	y := int(be16(s[12:]))
	f.RefTime = time.Date(y, time.Month(s[14]), int(s[15]), int(s[16]), int(s[17]), int(s[18]), 0, time.UTC)
	return nil
}

func (f *Field) section3(s []byte) (int, error) {
	if len(s) < 14 {
		return 0, errors.New("grib2: short section 3")
	}
	if s[5] != 0 {
		return 0, fmt.Errorf("%w: grid definition source %d", ErrUnsupported, s[5])
	}
	npts := int(be32(s[6:]))
	if s[10] != 0 {
		return 0, fmt.Errorf("%w: optional list of numbers in section 3", ErrUnsupported)
	}
	if t := be16(s[12:]); t != 0 {
		return 0, fmt.Errorf("%w: grid definition template 3.%d", ErrUnsupported, t)
	}
	if len(s) < 72 {
		return 0, errors.New("grib2: short template 3.0")
	}
	g := Grid{EarthShape: s[14]}
	g.Ni = int(be32(s[30:]))
	g.Nj = int(be32(s[34:]))
	basic, sub := be32(s[38:]), be32(s[42:])
	unit := 1e-6
	if basic != 0 && basic != 0xFFFFFFFF && sub != 0 && sub != 0xFFFFFFFF {
		unit = float64(basic) / float64(sub)
	}
	la1 := float64(sm32(s[46:])) * unit
	lo1 := float64(sm32(s[50:])) * unit
	flags := s[54]
	la2 := float64(sm32(s[55:])) * unit
	lo2 := float64(sm32(s[59:])) * unit
	g.Di = float64(be32(s[63:])) * unit
	g.Dj = float64(be32(s[67:])) * unit
	g.ScanMode = s[71]
	g.GridRelative = flags&0x08 != 0
	if g.Ni <= 1 || g.Nj <= 1 || g.Ni*g.Nj != npts {
		return 0, fmt.Errorf("grib2: grid %dx%d against %d points", g.Ni, g.Nj, npts)
	}
	if npts > maxPoints {
		return 0, fmt.Errorf("%w: a grid of %d points", ErrUnsupported, npts)
	}
	if g.ScanMode&0x1F != 0 {
		// Boustrophedon rows and the offset-row variants.
		return 0, fmt.Errorf("%w: scanning mode %#x", ErrUnsupported, g.ScanMode)
	}
	if flags&0x30 != 0x30 {
		// Without both increments given, the grid is not regular.
		return 0, fmt.Errorf("%w: grid increments not given (flags %#x)", ErrUnsupported, flags)
	}
	// Points are regular: the increments and the corner coordinates must
	// agree, to a hundredth of the increment.
	span := func(a, b, d float64, n int) bool {
		return math.Abs(math.Abs(b-a)-d*float64(n-1)) <= d*0.01+1e-6
	}
	if !span(la1, la2, g.Dj, g.Nj) {
		return 0, fmt.Errorf("grib2: latitudes %g..%g do not span %d rows of %g", la1, la2, g.Nj, g.Dj)
	}
	// The rows run the way the scanning mode says (0x40 clear: north to
	// south), which the first and last latitudes must agree with: a grid
	// saying otherwise would have its rows placed upside down, and North
	// (their maximum) would still pass every grid check.
	if (g.ScanMode&0x40 == 0) != (la1 > la2) {
		return 0, fmt.Errorf("grib2: scanning mode %#x against latitudes %g..%g", g.ScanMode, la1, la2)
	}
	g.North = math.Max(la1, la2)
	// Longitudes run east from the first column whatever the scan
	// direction, so the west edge is the first point of an eastward scan
	// and the last of a westward one.
	west := lo1
	if g.ScanMode&0x80 != 0 {
		west = lo2
	}
	east := west + g.Di*float64(g.Ni-1)
	if east-west > 360+1e-6 {
		return 0, fmt.Errorf("grib2: %d columns of %g exceed the globe", g.Ni, g.Di)
	}
	if math.Abs(g.Di*float64(g.Ni)-360) <= g.Di*0.01 {
		g.Wraps = true
	}
	if west >= 180 {
		// ECMWF's global grid opens at 180 and runs east: its west edge
		// is -180 like everyone else's.
		west -= 360
	}
	g.West = west
	f.Grid = g
	return npts, nil
}

func surface(t byte, scale byte, value []byte) Surface {
	if t == 255 {
		return Surface{Type: t, Missing: true}
	}
	if be32(value) == 0xFFFFFFFF {
		return Surface{Type: t, Missing: true}
	}
	v := float64(sm32(value))
	sc := sm8(scale)
	return Surface{Type: t, Value: v * math.Pow(10, float64(-sc))}
}

// timeUnit converts code table 4.4 to a duration.
func timeUnit(code byte) (time.Duration, error) {
	switch code {
	case 0:
		return time.Minute, nil
	case 1:
		return time.Hour, nil
	case 2:
		return 24 * time.Hour, nil
	case 10:
		return 3 * time.Hour, nil
	case 11:
		return 6 * time.Hour, nil
	case 12:
		return 12 * time.Hour, nil
	case 13:
		return time.Second, nil
	}
	return 0, fmt.Errorf("%w: time unit %d", ErrUnsupported, code)
}

func (f *Field) section4(s []byte) error {
	if len(s) < 9 {
		return errors.New("grib2: short section 4")
	}
	if be16(s[5:]) != 0 {
		return fmt.Errorf("%w: coordinate values after the product template", ErrUnsupported)
	}
	t := be16(s[7:])
	if t != 0 && t != 8 {
		return fmt.Errorf("%w: product definition template 4.%d", ErrUnsupported, t)
	}
	if len(s) < 34 {
		return errors.New("grib2: short product template")
	}
	f.PDT = t
	f.Category = s[9]
	f.Number = s[10]
	f.GenProcess = s[11]
	u, err := timeUnit(s[17])
	if err != nil {
		return err
	}
	f.Forecast = time.Duration(sm32(s[18:])) * u
	f.Surface1 = surface(s[22], s[23], s[24:28])
	f.Surface2 = surface(s[28], s[29], s[30:34])
	f.StatProcess, f.Period, f.PeriodEnd = 0, 0, time.Time{}
	if t == 8 {
		if len(s) < 58 {
			return errors.New("grib2: short template 4.8")
		}
		y := int(be16(s[34:]))
		f.PeriodEnd = time.Date(y, time.Month(s[36]), int(s[37]), int(s[38]), int(s[39]), int(s[40]), 0, time.UTC)
		if s[41] != 1 {
			return fmt.Errorf("%w: %d time range specifications", ErrUnsupported, s[41])
		}
		f.StatProcess = s[46]
		pu, err := timeUnit(s[48])
		if err != nil {
			return err
		}
		f.Period = time.Duration(be32(s[49:])) * pu
	}
	return nil
}

func (f *Field) section5(s []byte) error {
	if len(s) < 21 {
		return errors.New("grib2: short section 5")
	}
	f.Packed = int(be32(s[5:]))
	f.DRT = be16(s[9:])
	switch f.DRT {
	case 0, 42:
	default:
		return fmt.Errorf("%w: data representation template 5.%d", ErrUnsupported, f.DRT)
	}
	f.Ref = math.Float32frombits(be32(s[11:]))
	f.BinScale = sm16(s[15:])
	f.DecScale = sm16(s[17:])
	f.Bits = int(s[19])
	f.CCSDS = aec.Params{}
	if f.DRT == 42 {
		if len(s) < 25 {
			return errors.New("grib2: short template 5.42")
		}
		f.CCSDS = aec.Params{BitsPerSample: f.Bits, Flags: aec.Flags(s[21]), BlockSize: int(s[22]), RSI: int(be16(s[23:]))}
		if f.CCSDS.Flags&aec.DataSigned != 0 {
			// Values reads the samples as unsigned: refused, never guessed.
			return fmt.Errorf("%w: signed CCSDS samples", ErrUnsupported)
		}
	}
	if f.Bits > 32 {
		return fmt.Errorf("grib2: %d bits per value", f.Bits)
	}
	return nil
}

func section6(s []byte, prev []byte) ([]byte, error) {
	if len(s) < 6 {
		return nil, errors.New("grib2: short section 6")
	}
	switch s[5] {
	case 0:
		return s[6:], nil
	case 255:
		return nil, nil
	case 254:
		if prev == nil {
			return nil, errors.New("grib2: bitmap 254 with no bitmap defined before")
		}
		return prev, nil
	}
	return nil, fmt.Errorf("%w: predefined bitmap %d", ErrUnsupported, s[5])
}

// HasBitmap reports whether the field masks some of its points.
func (f *Field) HasBitmap() bool { return f.bitmap != nil }

func (f *Field) checkCounts(gridPts int) error {
	if f.bitmap == nil {
		if f.Packed != gridPts {
			return fmt.Errorf("grib2: %d values for %d points and no bitmap", f.Packed, gridPts)
		}
		return nil
	}
	if len(f.bitmap)*8 < gridPts {
		return fmt.Errorf("grib2: bitmap of %d bits for %d points", len(f.bitmap)*8, gridPts)
	}
	ones := 0
	full := gridPts / 8
	for _, b := range f.bitmap[:full] {
		ones += popcount(b)
	}
	if rem := gridPts % 8; rem > 0 {
		ones += popcount(f.bitmap[full] & (0xFF << (8 - rem)))
	}
	if ones != f.Packed {
		return fmt.Errorf("grib2: bitmap holds %d points, section 5 says %d", ones, f.Packed)
	}
	return nil
}

func popcount(b byte) int {
	n := 0
	for ; b != 0; b &= b - 1 {
		n++
	}
	return n
}

// Samples decodes the packed integers, one per point with a value, in
// scan order.
func (f *Field) Samples() ([]uint32, error) {
	if f.Bits == 0 {
		return make([]uint32, f.Packed), nil
	}
	switch f.DRT {
	case 42:
		return aec.Decode(f.data, f.Packed, f.CCSDS)
	case 0:
		need := (f.Packed*f.Bits + 7) / 8
		if len(f.data) < need {
			return nil, fmt.Errorf("grib2: %d data bytes for %d values of %d bits", len(f.data), f.Packed, f.Bits)
		}
		out := make([]uint32, f.Packed)
		var acc uint64
		var nacc uint
		pos := 0
		bits := uint(f.Bits)
		for i := range out {
			for nacc < bits {
				acc = acc<<8 | uint64(f.data[pos])
				pos++
				nacc += 8
			}
			out[i] = uint32(acc >> (nacc - bits) & (1<<bits - 1))
			nacc -= bits
		}
		return out, nil
	}
	return nil, fmt.Errorf("%w: data representation template 5.%d", ErrUnsupported, f.DRT)
}

// RawData exposes the packed data section, for oracles.
func (f *Field) RawData() []byte { return f.data }

// Values decodes the field into the canonical layout (north to south, west
// to east), NaN where the bitmap has no value. dst must hold Grid.Points().
func (f *Field) Values(dst []float32) error {
	g := f.Grid
	n := g.Points()
	if len(dst) < n {
		return fmt.Errorf("grib2: %d values do not fit %d", n, len(dst))
	}
	samples, err := f.Samples()
	if err != nil {
		return err
	}
	ref := float64(f.Ref)
	bscale := math.Ldexp(1, f.BinScale)
	dscale := math.Pow(10, float64(-f.DecScale))
	nan := float32(math.NaN())
	k := 0
	for s := 0; s < n; s++ {
		d := f.canonical(s)
		if f.bitmap != nil && f.bitmap[s>>3]&(0x80>>(s&7)) == 0 {
			dst[d] = nan
			continue
		}
		dst[d] = float32((ref + float64(samples[k])*bscale) * dscale)
		k++
	}
	return nil
}

// canonical maps a scan-order index to the canonical index.
func (f *Field) canonical(s int) int {
	g := f.Grid
	mode := g.ScanMode
	if mode == 0 {
		return s
	}
	var i, j int
	if mode&0x20 != 0 {
		// Adjacent points run along j.
		j, i = s%g.Nj, s/g.Nj
	} else {
		i, j = s%g.Ni, s/g.Ni
	}
	if mode&0x80 != 0 {
		i = g.Ni - 1 - i
	}
	if mode&0x40 != 0 {
		j = g.Nj - 1 - j
	}
	return j*g.Ni + i
}
