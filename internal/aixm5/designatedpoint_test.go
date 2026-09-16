package aixm5

import "testing"

func TestDesignatedPointType(t *testing.T) {
	cases := []struct{ in, want string }{
		{"ICAO", "WAYPOINT"},
		{"icao", "WAYPOINT"},
		{" ICAO ", "WAYPOINT"},
		{"COORD", "VFR_REPORTING_POINT"},
		{"ADHP", ""}, // on an aerodrome -> dropped
		{"OTHER", "VFR_REPORTING_POINT"},
		{"", "VFR_REPORTING_POINT"},
	}
	for _, c := range cases {
		if got := designatedPointType(c.in); got != c.want {
			t.Errorf("designatedPointType(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
