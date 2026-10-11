package grib2

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/0intro/loxodrome/internal/aec"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type oracleRecord struct {
	Offset        int64      `json:"offset"`
	SamplesSHA256 string     `json:"samples_sha256"`
	ValuesSHA256  string     `json:"values_sha256"`
	Valid         int        `json:"valid"`
	Sum           float64    `json:"sum"`
	Probe         []*float64 `json:"probe"`
}

func readOracle(t *testing.T, path string) []oracleRecord {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []oracleRecord
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	for sc.Scan() {
		var r oracleRecord
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func u32Hash(v []uint32) string {
	b := make([]byte, 4*len(v))
	for i, x := range v {
		binary.LittleEndian.PutUint32(b[4*i:], x)
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func valuesHash(v []float32) string {
	b := make([]byte, 4*len(v))
	for i, x := range v {
		bits := math.Float32bits(x)
		if x != x {
			bits = 0x7FC00000
		}
		binary.LittleEndian.PutUint32(b[4*i:], bits)
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// checkAgainstOracle decodes every field of a file and holds it to the
// oracle's record: the packed integers bit for bit (libaec), the values
// to within GDAL's own single-precision arithmetic.
func checkAgainstOracle(t *testing.T, path string, recs []oracleRecord) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	r := NewReader(f)
	k := 0
	exact, approx := 0, 0
	var vals []float32
	for {
		msg, off, err := r.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		fields, err := Parse(msg, off)
		if err != nil {
			t.Fatal(err)
		}
		for _, fld := range fields {
			if k >= len(recs) {
				t.Fatalf("%s: more fields than the oracle's %d", path, len(recs))
			}
			rec := recs[k]
			k++
			if rec.Offset != off {
				t.Fatalf("%s field %d: offset %d, oracle %d", path, k-1, off, rec.Offset)
			}
			s, err := fld.Samples()
			if err != nil {
				t.Fatalf("%s field %d (%s): %v", path, k-1, fld.Key(), err)
			}
			if h := u32Hash(s); h != rec.SamplesSHA256 {
				t.Errorf("%s field %d (%s): packed integers differ from libaec", path, k-1, fld.Key())
				continue
			}
			n := fld.Grid.Points()
			if cap(vals) < n {
				vals = make([]float32, n)
			}
			vals = vals[:n]
			if err := fld.Values(vals); err != nil {
				t.Fatal(err)
			}
			if valuesHash(vals) == rec.ValuesSHA256 {
				exact++
				continue
			}
			approx++
			// Not bit-identical: GDAL forms R + X*2^E in single precision,
			// where a reference far from zero leaves its own rounding (a
			// few units in the reference's last float32 place) on values
			// near zero; we compute in double. Hold the probes to that
			// rounding and the counts exactly.
			refTol := 4 * math.Abs(float64(fld.Ref)) * math.Pow(10, float64(-fld.DecScale)) / (1 << 24)
			valid := 0
			sum := 0.0
			for _, v := range vals {
				if v == v {
					valid++
					sum += float64(v)
				}
			}
			if valid != rec.Valid {
				t.Errorf("%s field %d (%s): %d points with a value, GDAL %d", path, k-1, fld.Key(), valid, rec.Valid)
				continue
			}
			for pi, pv := range rec.Probe {
				got := vals[pi*9973]
				switch {
				case pv == nil && got == got:
					t.Errorf("%s field %d (%s): point %d has a value, GDAL none", path, k-1, fld.Key(), pi*9973)
				case pv != nil && got != got:
					t.Errorf("%s field %d (%s): point %d has no value, GDAL %g", path, k-1, fld.Key(), pi*9973, *pv)
				case pv != nil && math.Abs(float64(got)-*pv) > 1e-6*math.Max(1, math.Abs(*pv))+refTol:
					t.Errorf("%s field %d (%s): point %d = %g, GDAL %g", path, k-1, fld.Key(), pi*9973, got, *pv)
				}
			}
			if math.Abs(sum-rec.Sum) > 1e-5*math.Max(1, math.Abs(rec.Sum))+float64(valid)*refTol {
				t.Errorf("%s field %d (%s): sum %g, GDAL %g", path, k-1, fld.Key(), sum, rec.Sum)
			}
		}
	}
	if k != len(recs) {
		t.Errorf("%s: %d fields, oracle %d", path, k, len(recs))
	}
	t.Logf("%s: %d fields, values bit-identical to GDAL in %d, within its float32 rounding in %d", filepath.Base(path), k, exact, approx)
}

// The committed messages (one each cut from a real AROME, ARPEGE and IFS
// file: a masked field, a statistically processed one, a 0-bit constant
// field, a global one) with the oracle's record of each.
func TestCommittedMessages(t *testing.T) {
	files, _ := filepath.Glob("testdata/*.grib2")
	if len(files) < 4 {
		t.Fatalf("only %d committed messages", len(files))
	}
	for _, f := range files {
		checkAgainstOracle(t, f, readOracle(t, f+".oracle.jsonl"))
	}
}

// TestCorpus holds every field of every GRIB2 file under NWP_CORPUS to the
// oracle, run beside the file on first use (python3 -I
// testdata/grib_oracle.py, which needs libaec, numpy and GDAL).
func TestCorpus(t *testing.T) {
	dir := os.Getenv("NWP_CORPUS")
	if dir == "" {
		t.Skip("NWP_CORPUS not set")
	}
	var files []string
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(p, ".grib2") {
			files = append(files, p)
		}
		return nil
	})
	if len(files) == 0 {
		t.Fatalf("no .grib2 under %s", dir)
	}
	oracle, _ := filepath.Abs("testdata/grib_oracle.py")
	for _, f := range files {
		o := f + ".oracle.jsonl"
		if _, err := os.Stat(o); err != nil {
			out, err := exec.Command("python3", "-I", oracle, f).Output()
			if err != nil {
				t.Fatalf("oracle on %s: %v", f, err)
			}
			if err := os.WriteFile(o, out, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		checkAgainstOracle(t, f, readOracle(t, o))
	}
}

// message assembles a one-field GRIB2 message with simple packing over a
// regular grid, for the cases no feed exercises.
type testGrid struct {
	ni, nj         int
	la1, lo1       int32 // microdegrees, sign-and-magnitude when written
	la2, lo2       int32
	di, dj         uint32
	scan, resFlags byte
}

func smBytes32(v int32) []byte {
	b := make([]byte, 4)
	u := uint32(v)
	if v < 0 {
		u = uint32(-v) | 0x80000000
	}
	binary.BigEndian.PutUint32(b, u)
	return b
}

func section(num byte, body []byte) []byte {
	b := make([]byte, 5, 5+len(body))
	binary.BigEndian.PutUint32(b, uint32(5+len(body)))
	b[4] = num
	return append(b, body...)
}

func buildMessage(g testGrid, pdt uint16, bitmap []byte, samples []uint32, bits int, ref float32, e, d int16) []byte {
	var sec1 bytes.Buffer
	sec1.Write([]byte{0, 98, 0, 0, 2, 0, 1})
	binary.Write(&sec1, binary.BigEndian, uint16(2026))
	sec1.Write([]byte{10, 6, 12, 0, 0, 0, 1})

	var sec3 bytes.Buffer
	n := g.ni * g.nj
	sec3.WriteByte(0)
	binary.Write(&sec3, binary.BigEndian, uint32(n))
	sec3.Write([]byte{0, 0})
	binary.Write(&sec3, binary.BigEndian, uint16(0))
	sec3.Write([]byte{6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0})
	binary.Write(&sec3, binary.BigEndian, uint32(g.ni))
	binary.Write(&sec3, binary.BigEndian, uint32(g.nj))
	binary.Write(&sec3, binary.BigEndian, uint32(0))
	binary.Write(&sec3, binary.BigEndian, uint32(0xFFFFFFFF))
	sec3.Write(smBytes32(g.la1))
	sec3.Write(smBytes32(g.lo1))
	sec3.WriteByte(g.resFlags)
	sec3.Write(smBytes32(g.la2))
	sec3.Write(smBytes32(g.lo2))
	binary.Write(&sec3, binary.BigEndian, g.di)
	binary.Write(&sec3, binary.BigEndian, g.dj)
	sec3.WriteByte(g.scan)

	var sec4 bytes.Buffer
	binary.Write(&sec4, binary.BigEndian, uint16(0))
	binary.Write(&sec4, binary.BigEndian, pdt)
	sec4.Write([]byte{2, 2, 2, 0, 0, 0, 0, 0, 1})
	// The forecast time: +3 h, or for a statistical field +2 h with its one
	// hour ending at 15:00, so the end is no start plus forecast.
	fc := uint32(3)
	if pdt == 8 {
		fc = 2
	}
	binary.Write(&sec4, binary.BigEndian, fc)
	sec4.Write([]byte{100, 0})
	binary.Write(&sec4, binary.BigEndian, uint32(85000))
	sec4.Write([]byte{255, 255, 255, 255, 255, 255})
	if pdt == 8 {
		binary.Write(&sec4, binary.BigEndian, uint16(2026))
		sec4.Write([]byte{10, 6, 15, 0, 0, 1})
		binary.Write(&sec4, binary.BigEndian, uint32(0))
		sec4.Write([]byte{2, 2, 1})
		binary.Write(&sec4, binary.BigEndian, uint32(1))
		sec4.Write([]byte{255, 0, 0, 0, 0})
	}

	var sec5 bytes.Buffer
	binary.Write(&sec5, binary.BigEndian, uint32(len(samples)))
	binary.Write(&sec5, binary.BigEndian, uint16(0))
	binary.Write(&sec5, binary.BigEndian, math.Float32bits(ref))
	sm16 := func(v int16) uint16 {
		if v < 0 {
			return uint16(-v) | 0x8000
		}
		return uint16(v)
	}
	binary.Write(&sec5, binary.BigEndian, sm16(e))
	binary.Write(&sec5, binary.BigEndian, sm16(d))
	sec5.Write([]byte{byte(bits), 0})

	var sec6 []byte
	if bitmap == nil {
		sec6 = []byte{255}
	} else {
		sec6 = append([]byte{0}, bitmap...)
	}

	var data []byte
	var acc uint64
	var nacc uint
	for _, s := range samples {
		acc = acc<<uint(bits) | uint64(s)
		nacc += uint(bits)
		for nacc >= 8 {
			data = append(data, byte(acc>>(nacc-8)))
			nacc -= 8
		}
	}
	if nacc > 0 {
		data = append(data, byte(acc<<(8-nacc)))
	}

	var body bytes.Buffer
	body.Write(section(1, sec1.Bytes()))
	body.Write(section(3, sec3.Bytes()))
	body.Write(section(4, sec4.Bytes()))
	body.Write(section(5, sec5.Bytes()))
	body.Write(section(6, sec6))
	body.Write(section(7, data))
	body.WriteString("7777")
	head := []byte{'G', 'R', 'I', 'B', 0xFF, 0xFF, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0}
	binary.BigEndian.PutUint64(head[8:], uint64(16+body.Len()))
	return append(head, body.Bytes()...)
}

func parseOne(t *testing.T, msg []byte) *Field {
	t.Helper()
	fields, err := Parse(msg, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(fields) != 1 {
		t.Fatalf("%d fields", len(fields))
	}
	return fields[0]
}

// A 3x2 grid holding point values 10*row + column in the canonical
// layout, written in each scanning order.
func TestScanModesNormalise(t *testing.T) {
	want := []float32{0, 1, 2, 10, 11, 12} // north row first, west to east
	cases := []struct {
		scan     byte
		order    []uint32 // the samples in scan order
		la1, la2 int32
		lo1, lo2 int32
	}{
		{0x00, []uint32{0, 1, 2, 10, 11, 12}, 50e6, 49e6, 1e6, 3e6},
		{0x40, []uint32{10, 11, 12, 0, 1, 2}, 49e6, 50e6, 1e6, 3e6},
		{0x80, []uint32{2, 1, 0, 12, 11, 10}, 50e6, 49e6, 3e6, 1e6},
		{0xC0, []uint32{12, 11, 10, 2, 1, 0}, 49e6, 50e6, 3e6, 1e6},
		{0x20, []uint32{0, 10, 1, 11, 2, 12}, 50e6, 49e6, 1e6, 3e6},
	}
	for _, c := range cases {
		g := testGrid{ni: 3, nj: 2, la1: c.la1, la2: c.la2, lo1: c.lo1, lo2: c.lo2, di: 1e6, dj: 1e6, scan: c.scan, resFlags: 0x30}
		f := parseOne(t, buildMessage(g, 0, nil, c.order, 8, 0, 0, 0))
		if f.Grid.North != 50 || f.Grid.West != 1 {
			t.Errorf("scan %#x: north %g west %g", c.scan, f.Grid.North, f.Grid.West)
		}
		got := make([]float32, 6)
		if err := f.Values(got); err != nil {
			t.Fatal(err)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("scan %#x: canonical %v, want %v", c.scan, got, want)
				break
			}
		}
	}
}

func TestBitmapAndScaling(t *testing.T) {
	g := testGrid{ni: 4, nj: 2, la1: 40e6, la2: 39e6, lo1: 350e6, lo2: 353e6, di: 1e6, dj: 1e6, resFlags: 0x30}
	// Points 1 and 6 masked; values (R + X*2^E)/10^D with R=100, E=1, D=1.
	bm := []byte{0b10111101}
	f := parseOne(t, buildMessage(g, 0, bm, []uint32{0, 1, 2, 3, 4, 5}, 4, 100, 1, 1))
	if f.Grid.West != -10 {
		t.Errorf("west %g, want -10 (350 E)", f.Grid.West)
	}
	got := make([]float32, 8)
	if err := f.Values(got); err != nil {
		t.Fatal(err)
	}
	want := []float64{10, math.NaN(), 10.2, 10.4, 10.6, 10.8, math.NaN(), 11}
	for i, w := range want {
		if math.IsNaN(w) != math.IsNaN(float64(got[i])) || (!math.IsNaN(w) && math.Abs(float64(got[i])-w) > 1e-6) {
			t.Fatalf("values %v, want %v", got, want)
		}
	}
	if !f.HasBitmap() || f.Packed != 6 {
		t.Errorf("bitmap %v packed %d", f.HasBitmap(), f.Packed)
	}
}

func TestStatisticalPeriodStampsItsEnd(t *testing.T) {
	g := testGrid{ni: 2, nj: 2, la1: 1e6, la2: 0, lo1: 0, lo2: 1e6, di: 1e6, dj: 1e6, resFlags: 0x30}
	f := parseOne(t, buildMessage(g, 8, nil, []uint32{1, 2, 3, 4}, 8, 0, 0, 0))
	if f.PDT != 8 || f.StatProcess != 2 || f.Period != time.Hour {
		t.Fatalf("pdt %d stat %d period %v", f.PDT, f.StatProcess, f.Period)
	}
	if want := time.Date(2026, 10, 6, 15, 0, 0, 0, time.UTC); !f.ValidTime().Equal(want) {
		t.Errorf("valid %v, want the period's end %v", f.ValidTime(), want)
	}
	if f.Surface1.Type != 100 || f.Surface1.Value != 85000 {
		t.Errorf("surface %+v", f.Surface1)
	}
}

func TestConstantField(t *testing.T) {
	g := testGrid{ni: 2, nj: 2, la1: 1e6, la2: 0, lo1: 0, lo2: 1e6, di: 1e6, dj: 1e6, resFlags: 0x30}
	f := parseOne(t, buildMessage(g, 0, nil, []uint32{0, 0, 0, 0}, 0, 273.15, 0, 0))
	got := make([]float32, 4)
	if err := f.Values(got); err != nil {
		t.Fatal(err)
	}
	for _, v := range got {
		if v != 273.15 {
			t.Fatalf("0-bit field %v", got)
		}
	}
}

func TestRefusals(t *testing.T) {
	g := testGrid{ni: 2, nj: 2, la1: 1e6, la2: 0, lo1: 0, lo2: 1e6, di: 1e6, dj: 1e6, resFlags: 0x30}
	good := buildMessage(g, 0, nil, []uint32{1, 2, 3, 4}, 8, 0, 0, 0)
	mutate := func(at func([]byte) int, v byte) []byte {
		m := append([]byte(nil), good...)
		m[at(m)] = v
		return m
	}
	sec := func(num byte) func([]byte) int {
		return func(m []byte) int {
			p := 16
			for p < len(m)-4 {
				if m[p+4] == num {
					return p
				}
				p += int(binary.BigEndian.Uint32(m[p:]))
			}
			panic("no section")
		}
	}
	for name, msg := range map[string][]byte{
		"grid template 3.1":      mutate(func(m []byte) int { return sec(3)(m) + 13 }, 1),
		"product template 4.1":   mutate(func(m []byte) int { return sec(4)(m) + 8 }, 1),
		"data template 5.3":      mutate(func(m []byte) int { return sec(5)(m) + 10 }, 3),
		"boustrophedon scan":     mutate(func(m []byte) int { return sec(3)(m) + 71 }, 0x10),
		"predefined bitmap 7":    mutate(func(m []byte) int { return sec(6)(m) + 5 }, 7),
		"missing end marker":     mutate(func(m []byte) int { return len(m) - 1 }, '6'),
		"too many packed values": mutate(func(m []byte) int { return sec(5)(m) + 8 }, 5),
	} {
		if _, err := Parse(msg, 0); err == nil {
			t.Errorf("%s accepted", name)
		} else if strings.Contains(name, "template") && !errors.Is(err, ErrUnsupported) {
			t.Errorf("%s: %v is not ErrUnsupported", name, err)
		}
	}
}

func TestReaderWalksMessages(t *testing.T) {
	g := testGrid{ni: 2, nj: 2, la1: 1e6, la2: 0, lo1: 0, lo2: 1e6, di: 1e6, dj: 1e6, resFlags: 0x30}
	a := buildMessage(g, 0, nil, []uint32{1, 2, 3, 4}, 8, 0, 0, 0)
	b := buildMessage(g, 8, nil, []uint32{5, 6, 7, 8}, 8, 0, 0, 0)
	r := NewReader(bytes.NewReader(append(append([]byte(nil), a...), b...)))
	_, off1, err := r.Next()
	if err != nil || off1 != 0 {
		t.Fatal(off1, err)
	}
	_, off2, err := r.Next()
	if err != nil || off2 != int64(len(a)) {
		t.Fatal(off2, err)
	}
	if _, _, err := r.Next(); err != io.EOF {
		t.Fatalf("after the last message: %v", err)
	}
	if _, _, err := NewReader(bytes.NewReader([]byte("GRIP0000"))).Next(); err == nil {
		t.Fatal("a short non-GRIB stream read")
	}
}

// TestPeekNamesARefusedMessage: a message in a template Parse refuses still
// says what it holds, so a reader can tell an unwanted one from a field it
// reads (internal/nwp's ingest skips the former).
func TestPeekNamesARefusedMessage(t *testing.T) {
	g := testGrid{ni: 2, nj: 2, la1: 1e6, la2: 0, lo1: 0, lo2: 1e6, di: 1e6, dj: 1e6, resFlags: 0x30}
	msg := buildMessage(g, 0, nil, []uint32{1, 2, 3, 4}, 8, 0, 0, 0)
	p := 16
	for msg[p+4] != 4 {
		p += int(binary.BigEndian.Uint32(msg[p:]))
	}
	msg[p+8] = 1 // product definition template 4.1
	if _, err := Parse(msg, 0); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("parse: %v", err)
	}
	id, err := Peek(msg)
	if err != nil {
		t.Fatal(err)
	}
	if id != (Identity{Discipline: 0, Category: 2, Number: 2, PDT: 1}) {
		t.Errorf("identity %+v", id)
	}
	if _, err := Peek([]byte("GRIB not a message at all......7777")); err == nil {
		t.Error("peeked into garbage")
	}
}

func TestSizesAreRefusedBeforeTheyAreAllocated(t *testing.T) {
	// A 0-bit field claiming 8192 x 4097 points: 33.5 M samples asked of
	// a message of a few hundred bytes.
	huge := testGrid{ni: 8192, nj: 4097, la1: 0, la2: -4096e3, lo1: 0, lo2: 8191e3, di: 1e3, dj: 1e3, resFlags: 0x30}
	if _, err := Parse(buildMessage(huge, 0, nil, nil, 0, 0, 0, 0), 0); !errors.Is(err, ErrUnsupported) {
		t.Errorf("a grid of %d points: %v", 8192*4097, err)
	}
	// A header claiming a gigabyte: refused before the buffer is made.
	head := []byte{'G', 'R', 'I', 'B', 0, 0, 0, 2, 0, 0, 0, 0, 0x40, 0, 0, 0}
	if _, _, err := NewReader(bytes.NewReader(head)).Next(); err == nil || !strings.Contains(err.Error(), "message length") {
		t.Errorf("a 1 GiB message: %v", err)
	}
}

func TestScanDirectionMustAgreeWithTheCorners(t *testing.T) {
	// Mode 0 scans north to south, yet the first row is the southern one:
	// its rows would be placed upside down, every grid check passing.
	g := testGrid{ni: 2, nj: 2, la1: 0, la2: 1e6, lo1: 0, lo2: 1e6, di: 1e6, dj: 1e6, resFlags: 0x30}
	if _, err := Parse(buildMessage(g, 0, nil, []uint32{1, 2, 3, 4}, 8, 0, 0, 0), 0); err == nil {
		t.Error("a mirrored grid accepted")
	}
}

func TestSignedCCSDSSamplesRefused(t *testing.T) {
	raw, err := os.ReadFile("testdata/ifs025-r50hpa.grib2")
	if err != nil {
		t.Fatal(err)
	}
	msg := append([]byte(nil), raw...)
	p := 16
	for msg[p+4] != 5 {
		p += int(binary.BigEndian.Uint32(msg[p:]))
	}
	if binary.BigEndian.Uint16(msg[p+9:]) != 42 {
		t.Skip("the committed IFS message is not CCSDS-packed")
	}
	msg[p+21] |= byte(aec.DataSigned)
	if _, err := Parse(msg, 0); !errors.Is(err, ErrUnsupported) {
		t.Errorf("signed samples: %v", err)
	}
}

// TestCommittedPeriodStampsItsEnd: AROME's real 4.8 message states a
// forecast time of 0 h and a period of one hour ending at 01:00Z; it is
// valid at the end, not at the start plus the forecast time.
func TestCommittedPeriodStampsItsEnd(t *testing.T) {
	raw, err := os.ReadFile("testdata/arome0025-sp1-pdt8.grib2")
	if err != nil {
		t.Fatal(err)
	}
	f := parseOne(t, raw)
	if f.PDT != 8 || f.Period != time.Hour {
		t.Fatalf("pdt %d period %v", f.PDT, f.Period)
	}
	ref := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
	if !f.RefTime.Equal(ref) {
		t.Errorf("reference %v", f.RefTime)
	}
	if want := ref.Add(time.Hour); !f.ValidTime().Equal(want) {
		t.Errorf("valid %v, want the period's end %v", f.ValidTime(), want)
	}
}

// AROME-OM's Guyane grid as its file states it, longitudes from 0 to 360:
// the west edge 303.25 reads -56.75, rows north first, no bitmap.
func TestCommittedAromeOMGrid(t *testing.T) {
	raw, err := os.ReadFile("testdata/aromeomguyane-ip2-cloud6bit.grib2")
	if err != nil {
		t.Fatal(err)
	}
	f := parseOne(t, raw)
	g := f.Grid
	near := func(a, b float64) bool { return math.Abs(a-b) < 1e-9 }
	if g.Ni != 419 || g.Nj != 317 || !near(g.North, 8.95) || !near(g.West, -56.75) || !near(g.Di, 0.025) || !near(g.Dj, 0.025) || g.Wraps {
		t.Fatalf("grid %+v, want 419 x 317 from 8.95 N, 56.75 W by 0.025", g)
	}
	if f.Discipline != 0 || f.Category != 6 || f.Number != 32 {
		t.Errorf("field %d/%d/%d, want cloud fraction 0/6/32", f.Discipline, f.Category, f.Number)
	}
	if want := time.Date(2026, 10, 8, 1, 0, 0, 0, time.UTC); !f.ValidTime().Equal(want) {
		t.Errorf("valid %v, want %v", f.ValidTime(), want)
	}
}
