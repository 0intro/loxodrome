package eaip

import (
	"math"
	"testing"

	"github.com/0intro/loxodrome/internal/geodesy"
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
			name:    "Ireland: no word for the centre at all",
			text:    "Cork Control Zone Circle, radius 15 NM 515029N 0082928W",
			kind:    "circle",
			radiusM: 15 * 1852, cenLat: 51.84139, cenLon: -8.49111,
		},
		{
			name:    "Ireland: the bare noun",
			text:    "Circle 15NM radius centre 524207N 0085529W.",
			kind:    "circle",
			radiusM: 15 * 1852, cenLat: 52.70194, cenLon: -8.92472,
		},
		{
			name:    "Romania: the metric value in brackets before the word, 'point of coordinates:'",
			text:    "Circle of 6 NM (12 KM) radius centred on point of coordinates: 445914N 0260920E",
			kind:    "circle",
			radiusM: 6 * 1852, cenLat: 44.98722, cenLon: 26.15556,
		},
		{
			name:    "Romania: kilometres, the phrase broken over two lines",
			text:    "Circle of 5 KM radius centred on point of  coordinates: 434424N 0234644E, except where  inside SOFIA FIR.",
			kind:    "circle",
			radiusM: 5000, cenLat: 43.74, cenLon: 23.77889,
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
			"Ireland: 'arc 10NM radius centre', end point implied",
			"533445N 0062411W, arc 10NM radius centre 532621N 0061508W 532347N 0063117W, " +
				"532359N 0063500W, 533531N 0063500W, 533445N 0062411W",
		},
		{
			"Slovakia: 'circular arc CCW 7 NM around', then 'to' its end",
			"483518N 0170755E 483109N 0170610E circular arc CCW 7 NM around 482411N 0170707E " +
				"to 481833N 0170053E 481933N 0165432E 483518N 0170755E",
		},
		{
			"Czechia: CWA, end point implied",
			"485746.42N 0141534.47E 485746.85N 0142121.49E CWA with radius 3 NM centred at " +
				"485647.00N 0142539.00E - 485746.96N 0142956.45E 485546.74N 0143847.18E 485746.42N 0141534.47E",
		},
		{
			"Czechia: CCA, the centre named by its reference",
			"501024.979N 0135844.727E - 500850.810N 0140201.630E - CCA with radius 3 NM centred at ARP LKKL " +
				"( 500646.49N 0140523.49E ) - 500732.280N 0140054.940E - 501024.979N 0135844.727E",
		},
		{
			"no sense stated: the short way round",
			"3130N 01702W - Arc of circle of 100 NM radius centred at 330407N 0162130W " +
				"- 3415N 01746W - 3630N 01500W - 3130N 01702W",
		},
	}
	// The fewest vertices a ring may have: a tessellated arc adds many more
	// than the sentence names, fewer on a short one (the Kladno arc is a
	// third of a quadrant on a 3 NM circle).
	short := map[string]int{"Czechia: CCA, the centre named by its reference": 8}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var st BoundaryStats
			ring := ParseBoundary(c.text, nil, &st)
			if st.Arcs != 1 {
				t.Fatalf("arcs = %d, want 1", st.Arcs)
			}
			// A tessellated arc contributes many more vertices than the
			// four the sentence names.
			want := 10
			if n, ok := short[c.name]; ok {
				want = n
			}
			if len(ring) < want {
				t.Fatalf("ring has %d points; the arc did not tessellate", len(ring))
			}
		})
	}
}

// KANS, 2026-10-01: Pristina CTA Zone 4 states each arc's sense after its
// centre, then the end point. Its first arc runs clockwise from the east
// round the south to the west, 185 degrees, the long way round: read as
// no sense stated, it ran round the north instead.
func TestParseBoundaryArcSenseAfterCentre(t *testing.T) {
	text := "425312.502N 0211635.118E 423810.908N 0212844.049E ARC 20 Nm centered on 423422.000N 0210209.000E " +
		"Clockwise 423251.213N 0203509.908E 424745.869N 0203331.821E ARC 25 Nm centered on 423422.000N 0210209.000E " +
		"Clockwise 425809.839N 0211234.621E 425312.502N 0211635.118E"
	var st BoundaryStats
	ring := ParseBoundary(text, nil, &st)
	if st.Arcs != 2 || st.ArcSensesInferred != 0 {
		t.Fatalf("arcs = %d, inferred = %d; want 2 read with their senses", st.Arcs, st.ArcSensesInferred)
	}
	// Due south of the aerodrome, 20 NM out, is on the ring.
	arpLat, arpLon := 42+34.0/60+22.0/3600, 21+2.0/60+9.0/3600
	south := false
	for _, p := range ring {
		b := geodesy.InitialBearing(arpLat, arpLon, p[0], p[1])
		nm := geodesy.DistanceM(arpLat, arpLon, p[0], p[1]) / 1852
		south = south || (b > 170 && b < 190 && nm > 19.5 && nm < 20.5)
	}
	if !south {
		t.Errorf("the 20 NM arc does not run round the south")
	}
	if !inRing(ring, arpLat, arpLon) {
		t.Errorf("the ring does not contain the aerodrome")
	}
}

// ROMATSA, 2026-09-03: LRBM AD 2.17, the Baia Mare CTR, the 13.3 NM circle
// round the aerodrome with its western side drawn by three points instead.
// Its one arc states no sense and sweeps three quarters of a turn: drawn
// the short way round, the ring crossed itself and drew a sliver out to
// the west, and the aerodrome lay outside its own control zone.
func TestParseBoundaryArcSenseFromTheRing(t *testing.T) {
	text := "474632N 0231117E - arc of circle centred at 473930N 0232758E (ARP) and radius 13.3 NM - " +
		"473642N 0230846E - 474140N 0230939E - 474702N 0230719E - 474632N 0231117E"
	var st BoundaryStats
	ring := ParseBoundary(text, nil, &st)
	if st.Arcs != 1 || st.ArcsUnread != 0 {
		t.Fatalf("arcs = %d, unread = %d; want the one arc read", st.Arcs, st.ArcsUnread)
	}
	if st.ArcSensesInferred != 1 {
		t.Errorf("senses inferred = %d, want 1", st.ArcSensesInferred)
	}
	if crossesItself(ring) {
		t.Fatalf("the ring crosses itself")
	}
	arpLat, arpLon := 47+39.0/60+30.0/3600, 23+27.0/60+58.0/3600
	if !inRing(ring, arpLat, arpLon) {
		t.Errorf("the ring does not contain the aerodrome")
	}
	// About the 13.3 NM disc: the western side cuts into it and bulges
	// out of it by as much.
	disc := math.Pi * 13.3 * 13.3 * 1.852 * 1.852
	if a := ringKm2(ring); a < 0.9*disc || a > 1.1*disc {
		t.Errorf("area %.0f km2, want within 10%% of the disc's %.0f", a, disc)
	}

	// The same arc with the sense the ring needs stated: the ring is the
	// same, and nothing was inferred.
	var stated BoundaryStats
	ring2 := ParseBoundary("474632N 0231117E - clockwise arc of circle centred at 473930N 0232758E (ARP) and radius 13.3 NM - "+
		"473642N 0230846E - 474140N 0230939E - 474702N 0230719E - 474632N 0231117E", nil, &stated)
	if stated.ArcSensesInferred != 0 || len(ring2) != len(ring) {
		t.Errorf("stated clockwise: %d points, %d inferred; want %d points, none inferred",
			len(ring2), stated.ArcSensesInferred, len(ring))
	}
}

// Avians, 2026-09-03: the FAXI TMA's 1000a collar, the ring between 6 and
// 11 NM north of Reykjavik (BIRK), with the outer arc "clockwise along an
// arc" and the inner one back "clockwise along a counter arc". Read the
// wrong way round, the inner arc sweeps the whole circle; not read at
// all, the arc's centre becomes a vertex and the collar spikes into the
// aerodrome.
func TestParseBoundaryCounterArc(t *testing.T) {
	text := "641533N 0222842W 641811N 0220427W then clockwise along an arc with 11NM radius " +
		"centered on 640748N 0215558W to 641829N 0215018W 641338N 0215253W then clockwise along " +
		"a counter arc with 6NM radius centered on 640748N 0215558W to 641321N 0220142W " +
		"641017N 0222945W 641533N 0222842W"
	var st BoundaryStats
	ring := ParseBoundary(text, nil, &st)
	if st.Arcs != 2 {
		t.Fatalf("arcs = %d, want 2", st.Arcs)
	}
	birkLat, birkLon := 64+7.0/60+48.0/3600, -(21 + 55.0/60 + 58.0/3600)
	for _, p := range ring {
		nm := geodesy.DistanceM(birkLat, birkLon, p[0], p[1]) / 1852
		// The published west corners lie 16 NM out; nothing comes nearer
		// than the inner arc, and nothing lies south of the aerodrome.
		if nm < 5.9 || nm > 16.5 || p[0] < birkLat {
			t.Fatalf("vertex %v is %.1f NM from BIRK: the collar is misdrawn", p, nm)
		}
	}
}

// The abbreviations carry the sense: LPS SR's LZR314 runs CW round
// Malacky, LZR1 CCW, and read the other way round the arc sweeps the
// long way, through the zone's neighbour.
func TestParseBoundaryArcSenseAbbreviations(t *testing.T) {
	cenLat, cenLon := 48+24.0/60+11.0/3600, 17+7.0/60+7.0/3600
	for _, c := range []struct{ text, sense string }{
		{"483518N 0170755E 483340N 0171552E 482931N 0171355E circular arc CW 7 NM around 482411N 0170707E " +
			"to 482849N 0171500E 483518N 0170755E", "CW"},
		{"483442N 0172235E 482849N 0171500E circular arc CCW 7 NM around 482411N 0170707E " +
			"to 482931N 0171355E 483442N 0172235E", "CCW"},
	} {
		var st BoundaryStats
		ring := ParseBoundary(c.text, nil, &st)
		if st.Arcs != 1 {
			t.Fatalf("%s: arcs = %d, want 1", c.sense, st.Arcs)
		}
		// The two end points lie 16 degrees of bearing apart, east of the
		// centre: the short sweep keeps every arc vertex east of it.
		for _, p := range ring {
			if d := geodesy.DistanceM(cenLat, cenLon, p[0], p[1]); math.Abs(d-7*1852) < 200 && p[1] < cenLon {
				t.Fatalf("%s: arc vertex %v lies west of the centre, the long way round", c.sense, p)
			}
		}
	}
}

// A circle named after a point ON it continues the boundary along it.
// AirNav's Shannon CTA walks the whole 15 NM circle from a point on it
// and back, then a lobe beside it: the zone is their union, larger than
// the circle. Avinor's END452 lists four points, the first and the last
// on its circle, and then the circle: the boundary goes round it from the
// last point back to the first, in the sense the points already ran, and
// closes there, with no chord across it.
func TestParseBoundaryCircleContinued(t *testing.T) {
	var st BoundaryStats
	shannon := ParseBoundary("524539N 0083131W, circle 15NM radius centre 524207N 0085529W, 524539N 0083131W, "+
		"524846N 0082758W, arc 18NM radius centre 524207N 0085529W, 524019N 0082604W, 523902N 0081444W, "+
		"arc 25NM radius centre 524207N 0085529W, 525106N 0081705W, 524846N 0082758W, 524539N 0083131W.", nil, &st)
	circle := math.Pi * math.Pow(15*1.852, 2)
	if a := ringKm2(shannon); a < circle*1.05 || a > circle*1.3 {
		t.Errorf("Shannon CTA = %.0f km2, want the %.0f km2 circle and its lobe", a, circle)
	}

	end452 := ParseBoundary("672223N 0140758E - 671810N 0140354E - 671948N 0135122E - 672402N 0135505E - "+
		"A circle, radius 5.4 NM centred on 672740N 0140524E", nil, &st)
	circle = math.Pi * math.Pow(5.4*1.852, 2)
	if a := ringKm2(end452); a < circle*1.05 || a > circle*1.5 {
		t.Errorf("END452 = %.0f km2, want the %.0f km2 circle and the area south of it", a, circle)
	}
	if first, last := end452[0], end452[len(end452)-1]; geodesy.DistanceM(first[0], first[1], last[0], last[1]) > 1000 {
		t.Errorf("END452 ends %v, not at its first point %v", last, first)
	}
}

// "... along Tirana FIR boundary to the point of origin." with no point
// after it: the border is walked back to the first point.
func TestParseBoundaryBorderToOrigin(t *testing.T) {
	border := &BorderRing{Pts: [][2]float64{{41.0, 20.0}, {42.0, 20.0}, {42.0, 21.0}, {41.0, 21.0}}}
	var st BoundaryStats
	ring := ParseBoundary("410000N 0200000E - 413000N 0203000E - 420000N 0204800E along Tirana FIR boundary "+
		"to the point of origin.", border, &st)
	if st.BorderStitched != 1 {
		t.Fatalf("stitched = %d, want 1", st.BorderStitched)
	}
	// From the top edge back to the south-west corner, the short way is
	// through the north-west corner.
	found := false
	for _, p := range ring {
		found = found || p == [2]float64{42.0, 20.0}
	}
	if !found {
		t.Errorf("ring %v does not walk the border through its north-west corner", ring)
	}
}

// ringKm2 is a ring's area, planar at its mean latitude.
func ringKm2(ring [][2]float64) float64 {
	return math.Abs(signedArea(ring)) * 111.32 * 111.32
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

// ROMATSA cuts some of its circles back at its own FIR: "Circle of 5 KM
// radius centred on point of coordinates: 434424N 0234644E, except where
// inside SOFIA FIR" is the Romanian part of a circle round the Kozloduy
// plant, on the Bulgarian bank. The ring is clipped to the State's own FIR
// ring, the border ring; the FIR the words name is the neighbour's.
func TestParseBoundaryExceptInsideFIR(t *testing.T) {
	// A square "FIR" whose east edge runs down 24.0 E, and a 5 km circle
	// centred just east of it, as Kozloduy is south of the Danube.
	border := &BorderRing{Pts: [][2]float64{{45, 23}, {45, 24}, {43, 24}, {43, 23}}}
	text := "Circle of 5 KM radius centred on point of coordinates: 440000N 0240100E, except where inside SOFIA FIR."
	var st BoundaryStats
	ring := ParseBoundary(text, border, &st)
	if st.ClippedToFIR != 1 {
		t.Fatalf("clipped = %d, want 1", st.ClippedToFIR)
	}
	if len(ring) < 3 {
		t.Fatalf("ring = %v, want the part west of 24.0 E", ring)
	}
	onEdge := 0
	for _, p := range ring {
		if p[1] > 24.00001 {
			t.Fatalf("vertex %v lies east of the FIR's edge", p)
		}
		if math.Abs(p[1]-24) < 1e-5 {
			onEdge++
		}
	}
	if onEdge < 2 {
		t.Errorf("%d vertices on the FIR's edge, want the two the clip cuts", onEdge)
	}
	// Without the State's own ring there is nothing to clip to: the circle
	// stays whole, and so does one lying wholly inside the FIR.
	st = BoundaryStats{}
	if whole := ParseBoundary(text, nil, &st); len(whole) != geodesy.CircleSteps || st.ClippedToFIR != 0 {
		t.Errorf("no border ring: %d vertices, clipped %d; want the whole circle", len(whole), st.ClippedToFIR)
	}
	st = BoundaryStats{}
	inside := "Circle of 5 KM radius centred on point of coordinates: 440000N 0233000E, except airspace within Belgrad FIR."
	if whole := ParseBoundary(inside, border, &st); len(whole) != geodesy.CircleSteps || st.ClippedToFIR != 0 {
		t.Errorf("a circle inside the FIR: %d vertices, clipped %d; want the whole circle, untouched", len(whole), st.ClippedToFIR)
	}
	// Wholly outside it, nothing of the zone is the State's.
	st = BoundaryStats{}
	outside := "Circle of 5 KM radius centred on point of coordinates: 440000N 0243000E, except where inside SOFIA FIR."
	if ring := ParseBoundary(outside, border, &st); ring != nil || st.ClippedAway != 1 {
		t.Errorf("a circle outside the FIR: ring %d vertices, clipped away %d; want none, counted", len(ring), st.ClippedAway)
	}
}

// Avinor's ENR 5.1, 2026-09-03: areas that are sectors of a circle, swept
// clockwise from the first true bearing to the second, which the names
// confirm: Alomar Nv (north-west) is 270° - 360° and Alomar Sø (south-
// east) 090° - 180°. The upper Alomar areas are the same sectors of the
// annulus from 1 to 5 NM, R og B 1 a sector across north, and Halten a
// circle with a sector reaching beyond it.
func TestParseBoundarySectors(t *testing.T) {
	const nm = 1852.0
	// inSweep reports a bearing inside the clockwise sweep from one
	// bearing to the other, within half a degree.
	inSweep := func(b, from, to float64) bool {
		return math.Mod(b-from+720, 360) <= math.Mod(to-from+720, 360)+0.5 || math.Mod(from-b+720, 360) <= 0.5
	}
	for _, c := range []struct {
		name, text         string
		from, to           float64
		inner, outer, core float64 // NM
		centreIsVertex     bool
	}{
		{"Alomar Nv Lower", "691642N 0160031E - Sector 270° - 360° (T), radius 1 NM", 270, 360, 0, 1, 0, true},
		{"Alomar Sø Lower", "691642N 0160031E - Sector 090° - 180° (T), radius 1 NM", 90, 180, 0, 1, 0, true},
		{"Alomar Nv Upper", "691642N 0160031E - Sector 270° - 360° (T), radius 1 - 5 NM", 270, 360, 1, 5, 0, false},
		{"R og B 1", "691719N 0160133E - Sector 291° - 020° (T), radius 12 NM", 291, 20, 0, 12, 0, true},
		{"Halten", "642000N 0092454E - 1. A circle, radius 1.1 NM2. A sector 330° - 030° (T), radius 3.3 NM", 330, 30, 0, 3.3, 1.1, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			var st BoundaryStats
			ring := ParseBoundary(c.text, nil, &st)
			if len(ring) < 10 || st.ArcsUnread != 0 {
				t.Fatalf("ring %v, stats %+v", ring, st)
			}
			var cen [2]float64
			cen[0], cen[1], _ = FirstCoord(c.text)
			for _, p := range ring {
				d := geodesy.DistanceM(cen[0], cen[1], p[0], p[1]) / nm
				if d < 0.01 {
					if !c.centreIsVertex {
						t.Errorf("the centre is a vertex of %s", c.name)
					}
					continue
				}
				b := geodesy.InitialBearing(cen[0], cen[1], p[0], p[1])
				switch {
				case c.core > 0 && math.Abs(d-c.core) < 0.02*c.core:
					// The circle's rest lies outside the sector.
					if !inSweep(b, c.to, c.from) {
						t.Errorf("%s: circle point at %.1f° inside the sector", c.name, b)
					}
				case math.Abs(d-c.outer) < 0.02*c.outer || c.inner > 0 && math.Abs(d-c.inner) < 0.02*c.inner:
					if !inSweep(b, c.from, c.to) {
						t.Errorf("%s: point at %.1f°, %.2f NM outside %.0f° - %.0f°", c.name, b, d, c.from, c.to)
					}
				default:
					t.Errorf("%s: point at %.2f NM, on neither radius", c.name, d)
				}
			}
		})
	}
}

// Avinor's ENR 5.5 writes a circle as its centre, a dash and the radius,
// the word circle left out.
func TestParseBoundaryRadiusAfterCentre(t *testing.T) {
	var st BoundaryStats
	ring := ParseBoundary("Ulven 601130N 0052525E - Radius 1 NM", nil, &st)
	if st.Circles != 1 || len(ring) < 16 {
		t.Fatalf("ring %d points, stats %+v", len(ring), st)
	}
	for _, p := range ring {
		if d := geodesy.DistanceM(60.19167, 5.42361, p[0], p[1]); math.Abs(d-1852) > 20 {
			t.Fatalf("point %v is %.0f m from the centre", p, d)
		}
	}
}
