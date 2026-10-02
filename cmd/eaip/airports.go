// airports.go writes <cc>-airports.json: every aerodrome and heliport the
// State's own package publishes, read off its AD 2 and AD 3 pages by
// internal/eaip's ReadAerodrome (the reference point, the elevation, the
// types of traffic, the transition altitude, the runways and their
// declared distances, the radio), through the shared builder every AIXM
// publisher's airports go through. The pages are the ones the chart
// index reads, fetched once for both.

package main

import (
	"cmp"
	"crypto/sha256"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
)

// writeAirports builds and writes one State's airports from the pass.
func writeAirports(s *State, pass *adPass, dir, effective string, resolved resolution, outDir, target string, win aip.SanityWindows) error {
	var msg aixm5.Message
	var unread []string
	h := sha256.New()
	pages := append([]aerodromePage(nil), pass.pages...)
	sort.Slice(pages, func(i, j int) bool { return pages[i].ad.ICAO < pages[j].ad.ICAO })
	for _, p := range pages {
		if p.src != 0 {
			// A further package (a VFR manual, an AD 4) is the chart
			// index's; its aerodromes are not this dataset's.
			continue
		}
		if p.err != nil || p.airport == nil {
			unread = append(unread, p.ad.ICAO)
			continue
		}
		ap := *p.airport
		fmt.Fprintf(h, "%s %.5f %.5f\n", ap.ID, ap.Lat, ap.Lon)
		msg.Airports = append(msg.Airports, ap)
	}
	country := strings.ToUpper(s.CC)
	art, meta, err := aixm5build.BuildAirports(&msg, s.Label+" eAIP "+dir, h.Sum(nil), effective,
		aixm5build.AirportsOptions{
			Country: country,
			CountryFromIcao: func(icao string) string {
				return cmp.Or(s.AirportCountry[icao], country)
			},
			Now:         time.Now,
			MinAirports: cmp.Or(win.MinAirports, s.MinAirports, 1),
			MaxAirports: cmp.Or(win.MaxAirports, 1000),
		})
	if err != nil {
		return err
	}
	out := airportsMeta{AirportsMeta: meta, resolution: resolved, Unread: unread}
	slot, err := aip.WriteDataset(outDir, s.CC+"-airports", target, meta.Effective, art, out)
	if err != nil {
		return err
	}
	fmt.Printf("%s: wrote %d airports (%d runways, %d radios, %d with a TA, %d unread); effective %s; slot=%s\n",
		s.CC, meta.AhpCount, meta.RunwayCount, meta.RadioCount, meta.TransitionAltCount, len(unread), meta.Effective, slot)
	return nil
}

// writeFacilities builds and writes one State's aerodrome directory
// (<cc>-aerodrome-facilities.json) from the same pass: what ReadAerodrome
// reads of the site, the operator and its contacts, the operator's hours
// and the remarks, through the shared builder the AIXM publishers use.
func writeFacilities(s *State, pass *adPass, dir, effective string, outDir, target string) error {
	var msg aixm5.Message
	h := sha256.New()
	pages := append([]aerodromePage(nil), pass.pages...)
	sort.Slice(pages, func(i, j int) bool { return pages[i].ad.ICAO < pages[j].ad.ICAO })
	for _, p := range pages {
		if p.src != 0 || p.err != nil || p.airport == nil {
			continue
		}
		ap := *p.airport
		fmt.Fprintf(h, "%s %d %d %d\n", ap.ID, len(ap.Notes), len(ap.Hours), len(ap.Contacts))
		msg.Airports = append(msg.Airports, ap)
	}
	art, meta, err := aixm5build.BuildFacilities(&msg, s.Label+" eAIP "+dir, h.Sum(nil), effective,
		aixm5build.FacilitiesOptions{
			Country:       strings.ToUpper(s.CC),
			Now:           time.Now,
			MinAerodromes: cmp.Or(s.MinAirports, 1),
			MaxAerodromes: 1000,
		})
	if err != nil {
		return err
	}
	slot, err := aip.WriteDataset(outDir, s.CC+"-aerodrome-facilities", target, meta.Effective, art, meta)
	if err != nil {
		return err
	}
	fmt.Printf("%s: wrote %d aerodrome facilities (%d heliports); effective %s; slot=%s\n",
		s.CC, meta.AerodromeCount, meta.HeliportCount, meta.Effective, slot)
	return nil
}

// airportsMeta is the shared builder's sidecar, with the package
// resolution and the pages that gave no aerodrome (a stub with no
// reference point, a page that would not load).
type airportsMeta struct {
	aixm5build.AirportsMeta
	resolution
	Unread []string `json:"unread,omitempty"`
}
