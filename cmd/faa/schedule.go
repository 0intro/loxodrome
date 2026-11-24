// schedule.go fills the airspace rows' hours-of-activity column.
//
// The FAA publishes activity times two different ways, and the airspace
// artifact has one prose column for them (`workHr`, which cmd/fr fills
// from the SIA codeWorkHr and the AIXM publishers from their timesheets,
// and which the detail panel prints verbatim):
//
//   - Special-use airspace carries TIMESOFUSE on the feature itself, as
//     prose: "0800 - 2200, DAILY", "CONTINUOUS", "BY NOTAM".
//   - Class airspace carries nothing on the feature; its tower hours live
//     in the separate Airspace_Schedule layer as AIXM Timesheet XML,
//     keyed on the airspace's GLOBAL_ID.
//
// The second is rendered into the same day-and-time shape the AIXM
// publishers already emit ("ANY 06:00-22:00"), so one column reads the
// same however it was sourced.

package main

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/overlay"
)

const airspaceScheduleURL = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Airspace_Schedule/FeatureServer/0/query"

// timesheet is one entry of the APPLIES schedule document.
type timesheet struct {
	TimeReference        string `xml:"timeReference"`
	DaylightSavingAdjust string `xml:"daylightSavingAdjust"`
	StartDate            string `xml:"startDate"`
	EndDate              string `xml:"endDate"`
	Day                  string `xml:"day"`
	StartTime            string `xml:"startTime"`
	EndTime              string `xml:"endTime"`
}

type scheduleDoc struct {
	Timesheets []timesheet `xml:"Timesheet"`
}

// fetchAirspaceSchedules returns the rendered hours prose per airspace
// GLOBAL_ID. A layer that cannot be read is not fatal: the hours are an
// enrichment, and losing them must not cost us the airspace itself.
func fetchAirspaceSchedules(ctx context.Context) (map[string]string, error) {
	raw, err := fetchFAAPaginated(ctx, airspaceScheduleURL)
	if err != nil {
		return nil, err
	}
	var fc struct {
		Features []struct {
			Properties map[string]any `json:"properties"`
		} `json:"features"`
	}
	if err := json.Unmarshal(raw, &fc); err != nil {
		return nil, fmt.Errorf("decode Airspace_Schedule: %w", err)
	}
	out := make(map[string]string, len(fc.Features))
	for i := range fc.Features {
		p := fc.Features[i].Properties
		id := propString(p, "Airspace_ID")
		applies := propString(p, "APPLIES")
		if id == "" || applies == "" {
			continue
		}
		if text := renderSchedule(applies); text != "" {
			out[strings.ToUpper(id)] = text
		}
	}
	return out, nil
}

// renderSchedule turns the Timesheet XML into the day-and-time prose the
// AIXM publishers emit. Sheets that differ only by day and share the same
// part of the year and window collapse into one range, so a
// Monday-to-Friday tower reads as "MON-FRI 07:00-23:00" rather than five
// identical lines, and a tower open later in summer reads its seasons
// ("15 MAY-30 SEP: ANY 06:00-22:00").
func renderSchedule(applies string) string {
	var doc scheduleDoc
	if err := xml.Unmarshal([]byte(applies), &doc); err != nil {
		return ""
	}
	// Group by part of the year and window, keeping first-seen order.
	type group struct {
		season, window string
		days           []string
	}
	var groups []*group
	byKey := map[[2]string]*group{}
	for _, t := range doc.Timesheets {
		start, end := strings.TrimSpace(t.StartTime), strings.TrimSpace(t.EndTime)
		if start == "" || end == "" {
			continue
		}
		key := [2]string{aixm5.Season(t.StartDate, t.EndDate), start + "-" + end}
		g, seen := byKey[key]
		if !seen {
			g = &group{season: key[0], window: key[1]}
			byKey[key] = g
			groups = append(groups, g)
		}
		day := strings.ToUpper(strings.TrimSpace(t.Day))
		if day == "" {
			day = "ANY"
		}
		if !slicesContains(g.days, day) {
			g.days = append(g.days, day)
		}
	}
	parts := make([]string, 0, len(groups))
	for _, g := range groups {
		part := compactDays(g.days) + " " + g.window
		if g.season != "" {
			part = g.season + ": " + part
		}
		parts = append(parts, part)
	}
	if len(parts) == 0 {
		return ""
	}
	text := strings.Join(parts, "; ")
	// One time reference for the whole document is the normal case; name
	// it once at the end rather than on every part.
	if ref := commonRef(doc.Timesheets); ref != "" {
		text += " (" + daylightZone(ref, doc.Timesheets) + ")"
	}
	return text
}

// daylightZone names the time reference of sheets whose clock times
// move with daylight saving time the way the Chart Supplement names an
// airport's zone, its daylight offset beside it: UTC-5(-4DT). Any other
// reference is returned as it is.
func daylightZone(ref string, sheets []timesheet) string {
	for _, t := range sheets {
		if !strings.EqualFold(strings.TrimSpace(t.DaylightSavingAdjust), "YES") {
			return ref
		}
	}
	offset, ok := strings.CutPrefix(ref, "UTC")
	if !ok {
		return ref
	}
	n, err := strconv.Atoi(offset)
	if err != nil {
		return ref
	}
	return fmt.Sprintf("%s(%+dDT)", ref, n+1)
}

// weekOrder is the calendar order used to collapse a run of days.
var weekOrder = []string{"MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"}

// compactDays turns a day set into the shortest faithful spelling:
// "ANY" stays as it is, a full week becomes ANY, and a contiguous run
// becomes "MON-FRI".
func compactDays(days []string) string {
	if len(days) == 0 {
		return "ANY"
	}
	if len(days) == 1 {
		return days[0]
	}
	idx := make([]int, 0, len(days))
	for _, d := range days {
		i := indexOf(weekOrder, d)
		if i < 0 {
			// A day outside the week (HOL, WORK_DAY, ...) keeps the raw set.
			sorted := append([]string{}, days...)
			sort.Strings(sorted)
			return strings.Join(sorted, ",")
		}
		idx = append(idx, i)
	}
	sort.Ints(idx)
	if len(idx) == 7 {
		return "ANY"
	}
	contiguous := true
	for i := 1; i < len(idx); i++ {
		if idx[i] != idx[i-1]+1 {
			contiguous = false
			break
		}
	}
	if contiguous {
		return weekOrder[idx[0]] + "-" + weekOrder[idx[len(idx)-1]]
	}
	names := make([]string, 0, len(idx))
	for _, i := range idx {
		names = append(names, weekOrder[i])
	}
	return strings.Join(names, ",")
}

// commonRef returns the time reference when every sheet agrees on one.
func commonRef(sheets []timesheet) string {
	ref := ""
	for _, t := range sheets {
		r := strings.TrimSpace(t.TimeReference)
		if r == "" {
			continue
		}
		if ref == "" {
			ref = r
		} else if ref != r {
			return ""
		}
	}
	return ref
}

func indexOf(list []string, v string) int {
	for i, s := range list {
		if s == v {
			return i
		}
	}
	return -1
}

func slicesContains(list []string, v string) bool { return indexOf(list, v) >= 0 }

// applySchedules fills each row's hours column: the SUA prose the parser
// already carried, or the rendered timesheet of a class airspace, found
// by the GLOBAL_ID of the row's own feature (globalIDs, parallel to rows).
func applySchedules(rows []overlay.Row, byGlobalID map[string]string, globalIDs []string) int {
	filled := 0
	for i := range rows {
		if rows[i].WorkHr != "" {
			filled++
			continue
		}
		gid := globalIDs[i]
		if gid == "" {
			continue
		}
		if text := byGlobalID[strings.ToUpper(gid)]; text != "" {
			rows[i].WorkHr = text
			filled++
		}
	}
	return filled
}
