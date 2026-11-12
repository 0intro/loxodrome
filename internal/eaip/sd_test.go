package eaip

import (
	"reflect"
	"testing"
)

// The generator prints a value and hides its source right after it, with
// text between the two now and then; the text readers see the value only.
func TestSDTags(t *testing.T) {
	doc, err := ParseHTML([]byte(`<table><tr row_id="1160"><td><p>
<span class="SD" id="a">LONDON FIR</span><span class="sdParams" style="display: none;">TAIRSPACE;TXT_NAME;1160</span>
</p><p><span class="SD" id="b">550000N</span><span class="sdParams" style="display: none;">TAIRSPACE_VERTEX;GEO_LAT;3732</span>
<span class="SD" id="c">0050000E</span> <span class="sdParams" style="display: none;">TAIRSPACE_VERTEX;GEO_LONG;3732</span></p>
<span class="sdParams" style="display: none;">MALFORMED</span></td></tr></table>`))
	if err != nil {
		t.Fatal(err)
	}
	want := []SDValue{
		{Table: "TAIRSPACE", Column: "TXT_NAME", Record: "1160", Value: "LONDON FIR"},
		{Table: "TAIRSPACE_VERTEX", Column: "GEO_LAT", Record: "3732", Value: "550000N"},
		{Table: "TAIRSPACE_VERTEX", Column: "GEO_LONG", Record: "3732", Value: "0050000E"},
	}
	if got := SDTags(doc); !reflect.DeepEqual(got, want) {
		t.Errorf("SDTags =\n%+v\nwant\n%+v", got, want)
	}
	// The readers' own text never carries the hidden half.
	if txt := NormSpace(NodeText(doc)); txt != "LONDON FIR 550000N 0050000E" {
		t.Errorf("NodeText = %q", txt)
	}
}
