package eaip

import (
	"fmt"
	"strings"
	"testing"
)

// Three States' ENR 5.4: LPS SR in metres by its heading, the lighting
// column's heading naming a type too; SMATSA in feet; Avians with the unit
// in each value and "No light" for an unlit dam.
func TestParseObstacleTables(t *testing.T) {
	doc := adDoc(t, `<table><tr><td>Designation</td><td>OBST type</td><td>OBST position</td><td>ELEV/HGT (m)</td><td>LGT - Colour, Type</td><td>Remarks</td></tr>
		<tr><td>BOSANY</td><td>chimney</td><td>483433N 0181411E</td><td>282/110</td><td>yes - R, LIL</td><td></td></tr></table>
		<table><tr><td>Designation</td><td>Type of obstacle</td><td>Coordinates</td><td>ELEV / HGT GND (FT)</td><td>OBST LGT Type / Colour</td><td>Remarks</td></tr>
		<tr><td>LY_OBST_0002</td><td>Bridge pylon</td><td>444741.7N 0202534.6E</td><td>895 / 659</td><td>Yes FLG / R</td><td></td></tr></table>
		<table><tr><td>OBST ID or designation</td><td>OBST type</td><td>OBST position</td><td>ELEV/HGT</td><td>OBST LGT Type/Colour</td><td>Remarks</td></tr>
		<tr><td>BIRDOB1005</td><td>Dam</td><td>645648N 0154730W</td><td>2080 FT / 650 FT</td><td>No light</td><td>KARAHNJUKAR</td></tr></table>`)
	var got []string
	for _, o := range ParseObstacleTables(doc) {
		got = append(got, fmt.Sprintf("%s %s elev=%.0fft hgt=%.0fft lit=%v", o.Name, o.Type, *o.ElevM/FtPerM, *o.HeightM/FtPerM, o.Lighted))
	}
	want := []string{
		"BOSANY CHIMNEY elev=925ft hgt=361ft lit=true",
		"LY_OBST_0002 BRIDGE elev=895ft hgt=659ft lit=true",
		"BIRDOB1005 DAM elev=2080ft hgt=650ft lit=false",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("got\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}
