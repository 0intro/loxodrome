package eaip

import (
	"math"
	"testing"
)

// The lateral-limits grammar is the same sentence in seven wordings, and
// every one of them is a real line from a live eAIP. Getting one wrong
// does not fail loudly: the zone degrades to a default-size circle or
// vanishes, which is a false statement about where an aircraft may fly.
// So each wording is pinned by the shape it must produce.
func TestParseBoundaryWordings(t *testing.T) {
	cases := []struct {
		name string
		text string
		// want is the shape: "circle" (tessellated ring around a centre),
		// "poly" (the listed points), "arc" (points plus a tessellation).
		kind    string
		radiusM float64
		cenLat  float64
		cenLon  float64
	}{
		{
			name:    "Belgium: value before the word, comma-separated",
			text:    "A circle, 3 NM radius, centred on 505957N 0050355E.",
			kind:    "circle",
			radiusM: 3 * 1852, cenLat: 50.9992, cenLon: 5.0653,
		},
		{
			name:    "Portugal: value after the word, kilometres",
			text:    "A circle radius 5 KM centred on 383147N 0075331W",
			kind:    "circle",
			radiusM: 5000, cenLat: 38.5297, cenLon: -7.8919,
		},
		{
			name:    "Czechia: 'of radius' and a decimal value",
			text:    "A circle of radius 1.1 NM centred at 491048.73N 0142231.77E",
			kind:    "circle",
			radiusM: 1.1 * 1852, cenLat: 49.1802, cenLon: 14.3755,
		},
		{
			name:    "Slovakia: 'with the centre point at'",
			text:    "A circle of radius 2 km with the centre point at: 481533N 0182725E",
			kind:    "circle",
			radiusM: 2000, cenLat: 48.2592, cenLon: 18.4569,
		},
		{
			name:    "Poland: no article, bilingual prefix, 'centred at point:'",
			text:    "Okrag o promieniu 3 km i srodku w punkcie/ Circle of 3 km radius centred at point: 512729N 0212542E",
			kind:    "circle",
			radiusM: 3000, cenLat: 51.4581, cenLon: 21.4283,
		},
		{
			name: "plain coordinate list",
			text: "383435N 0090834W - 383435N 0090602W - 383200N 0090602W - 383435N 0090834W",
			kind: "poly",
		},
		{
			name: "minutes-only coordinates, as the FIR descriptions use",
			text: "4300N 01300W - 4200N 01000W - 3558N 00723W - 4300N 01300W",
			kind: "poly",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var st BoundaryStats
			ring := ParseBoundary(c.text, nil, &st)
			if len(ring) < 3 {
				t.Fatalf("ring too short: %d points", len(ring))
			}
			switch c.kind {
			case "circle":
				if st.Circles != 1 {
					t.Fatalf("circles = %d, want 1", st.Circles)
				}
				// Every vertex sits one radius from the stated centre.
				for _, p := range ring {
					d := haversineM(c.cenLat, c.cenLon, p[0], p[1])
					if math.Abs(d-c.radiusM) > 0.02*c.radiusM {
						t.Fatalf("vertex %v is %.0f m from the centre, want %.0f", p, d, c.radiusM)
					}
				}
			case "poly":
				if st.Circles != 0 || st.Arcs != 0 {
					t.Fatalf("circles=%d arcs=%d, want a plain point list", st.Circles, st.Arcs)
				}
			}
		})
	}
}

// An arc may be written with its end point ("traced clockwise to X") or
// without, in which case the end is the next coordinate of the list. Both
// have to tessellate, and an arc whose sense the State left out takes the
// short way round.
func TestParseBoundaryArcs(t *testing.T) {
	cases := []struct {
		name string
		text string
	}{
		{
			"Belgium: end point stated",
			"511743N 0053057E - an arc of circle, 5 NM radius, centred at 511421N 0053650E " +
				"and traced clockwise to 511052N 0054231E - 511743N 0053057E",
		},
		{
			"Portugal: sense before the word, end point implied",
			"405519N 0085905W then a counter clockwise arc 25NM centred on 411623N 0084116W " +
				"- 405251N 0083005W - 404400N 0085905W - 405519N 0085905W",
		},
		{
			"Portugal: 'arc radius 20 KM', end point implied",
			"415629N 0065456W then a clockwise arc radius 20 KM centred on 415124N 0064227W " +
				"- 415632N 0065510W - 414354N 0063307W - 415629N 0065456W",
		},
		{
			"no sense stated: the short way round",
			"3130N 01702W - Arc of circle of 100 NM radius centred at 330407N 0162130W " +
				"- 3415N 01746W - 3630N 01500W - 3130N 01702W",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var st BoundaryStats
			ring := ParseBoundary(c.text, nil, &st)
			if st.Arcs != 1 {
				t.Fatalf("arcs = %d, want 1", st.Arcs)
			}
			// A tessellated arc contributes many more vertices than the
			// four the sentence names.
			if len(ring) < 10 {
				t.Fatalf("ring has %d points; the arc did not tessellate", len(ring))
			}
		})
	}
}

// A zone published as a single point has no lateral limit to draw. The
// spec decides whether that becomes a circle (Belgium's reading) or
// nothing (the cohort's), and either way it is counted.
func TestZoneRingPointOnly(t *testing.T) {
	const site = "Inch Strand 520815N 0095853W Castlemaine Harbour"

	st := NewZoneStats()
	if ring := ZoneRing(site, ZoneSpec{}, st); ring != nil {
		t.Fatalf("ring = %d points, want none", len(ring))
	}
	if st.PointOnly != 1 || st.PointCircles != 0 {
		t.Fatalf("pointOnly=%d pointCircles=%d, want 1 and 0", st.PointOnly, st.PointCircles)
	}

	st = NewZoneStats()
	ring := ZoneRing(site, ZoneSpec{PointRadiusM: 1852}, st)
	if len(ring) < 10 {
		t.Fatalf("ring = %d points, want a tessellated circle", len(ring))
	}
	if st.PointOnly != 0 || st.PointCircles != 1 {
		t.Fatalf("pointOnly=%d pointCircles=%d, want 0 and 1", st.PointOnly, st.PointCircles)
	}
}

func haversineM(lat1, lon1, lat2, lon2 float64) float64 {
	const r = 6371008.8
	rad := math.Pi / 180
	dLat := (lat2 - lat1) * rad
	dLon := (lon2 - lon1) * rad
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*rad)*math.Cos(lat2*rad)*math.Sin(dLon/2)*math.Sin(dLon/2)
	return 2 * r * math.Asin(math.Sqrt(a))
}
