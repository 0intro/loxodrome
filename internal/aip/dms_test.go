package aip

import "testing"

func TestParseLat(t *testing.T) {
	cases := []struct {
		in   string
		want float64
		ok   bool
	}{
		{"470440.00N", 47.0777778, true},
		{"470440N", 47.0777778, true},
		{"480000.00S", -48.0, true},
		{"  482936.00N  ", 48.4933333, true},
		{"909999.00N", 0, false}, // minutes/seconds out of range
		{"BADCOORD", 0, false},
		{"", 0, false},
	}
	for _, c := range cases {
		got, ok := ParseLat(c.in)
		if ok != c.ok {
			t.Errorf("ParseLat(%q) ok = %v, want %v", c.in, ok, c.ok)
			continue
		}
		if ok && near(got, c.want) == false {
			t.Errorf("ParseLat(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestParseLon(t *testing.T) {
	cases := []struct {
		in   string
		want float64
		ok   bool
	}{
		{"0020137.00E", 2.0269444, true},
		{"0042955.78E", 4.4988278, true},
		{"0015526.00W", -1.9238889, true},
		{"1809999.00E", 0, false}, // minutes/seconds out of range
		{"BADCOORD", 0, false},
	}
	for _, c := range cases {
		got, ok := ParseLon(c.in)
		if ok != c.ok {
			t.Errorf("ParseLon(%q) ok = %v, want %v", c.in, ok, c.ok)
			continue
		}
		if ok && near(got, c.want) == false {
			t.Errorf("ParseLon(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestRound5(t *testing.T) {
	cases := []struct {
		in, want float64
	}{
		{48.49333333, 48.49333},
		{-1.92388889, -1.92389},
		{0.0, 0.0},
	}
	for _, c := range cases {
		if got := Round5(c.in); got != c.want {
			t.Errorf("Round5(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}

// near tolerates ~1e-6 rounding wiggle from the DMS arithmetic.
func near(a, b float64) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return d < 1e-6
}
