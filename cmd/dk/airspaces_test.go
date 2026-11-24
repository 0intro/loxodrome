package main

import "testing"

// The build is held: public/data is refused, a local directory taken.
func TestHeldOut(t *testing.T) {
	if heldOut(defaultOutDir) == nil {
		t.Error("public/data accepted")
	}
	if err := heldOut(t.TempDir()); err != nil {
		t.Errorf("a local directory refused: %v", err)
	}
}

// ENR 5's flight-plan buffer zones are dropped, their areas kept.
func TestDkDrop(t *testing.T) {
	for _, c := range []struct {
		section, designator string
		drop                bool
	}{
		{"ENR 5.1", "EKR11Z", true},
		{"ENR 5.2", "EKTSAJY2Z", true},
		{"ENR 5.1", "EKR11", false},
		{"ENR 2.1", "EKZZZ", false},
	} {
		if got := dkDrop(c.section, c.designator, "") != ""; got != c.drop {
			t.Errorf("%s %s: dropped %v, want %v", c.section, c.designator, got, c.drop)
		}
	}
}
