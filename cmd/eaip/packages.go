// packages.go is what a chart index reads: the State's own eAIP package
// first, then whatever further packages its row names (State.ChartSites),
// another eAIP (PANSA's AIP VFR) or a publisher's own VFR manual (ANS
// CR's, vfrmanual.go). Each lists its aerodrome pages and reads one
// page's charts; the index merges them.

package main

import (
	"context"
	"time"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/eaip"
)

// chartPackage is one package a chart index reads.
type chartPackage interface {
	// name labels it in logs and in the index's meta.
	name() string
	// open resolves the edition serving the slot and names it, "" when
	// the slot has none.
	open(ctx context.Context, next bool) (string, error)
	// aerodromes lists its aerodrome pages.
	aerodromes(ctx context.Context) ([]eaip.Aerodrome, error)
	// read fetches one aerodrome page and reads it.
	read(ctx context.Context, ad eaip.Aerodrome, text func(*eaip.Node) string) (pageRead, error)
	// site fetches its pages and files, with its headers and certificates.
	site() *eaip.Site
}

// pageRead is what one aerodrome page gives: its charts, the effective
// date it states, and the aerodrome itself where the page is an eAIP's AD
// 2 or AD 3 page (nil for a VFR manual's, an AD 4's, or a stub), with the
// airspace its AD 2.17 (AD 3.16) publishes and that reading's counters.
type pageRead struct {
	charts  []eaip.Chart
	eff     string
	airport *aixm5.Airport
	zones   []aixm5.Airspace
	zstats  *eaip.ZoneStats
	// points are the visual reporting points the page lists.
	points []aixm5.Navaid
}

// eaipPackage is a generated eAIP package, the State's own or a further
// one.
type eaipPackage struct {
	label string
	s     *eaip.Site
	// probe is the section fetched to confirm a package exists.
	probe string
	cyc   eaip.Cycle
	// spec, the State's zone spec, reads each aerodrome's own airspace;
	// nil for a further package, whose pages give charts alone.
	spec *eaip.ZoneSpec
}

func (p *eaipPackage) name() string { return p.label }

func (p *eaipPackage) site() *eaip.Site { return p.s }

func (p *eaipPackage) open(ctx context.Context, next bool) (string, error) {
	c, err := p.s.Resolve(ctx, p.probe, time.Now(), next)
	if err != nil {
		return "", err
	}
	p.cyc = c
	switch {
	case c.Dir != "":
		return c.Dir, nil
	case c.Base != "":
		return c.Base, nil
	case c.Effective != "":
		// A package at the site's own fixed path.
		return p.s.Base, nil
	}
	return "", nil
}

func (p *eaipPackage) aerodromes(ctx context.Context) ([]eaip.Aerodrome, error) {
	return p.s.Aerodromes(ctx, p.cyc)
}

func (p *eaipPackage) read(ctx context.Context, ad eaip.Aerodrome, text func(*eaip.Node) string) (pageRead, error) {
	body, err := p.s.Get(ctx, ad.URL)
	if err != nil {
		return pageRead{}, err
	}
	doc, err := eaip.ParseHTML(body)
	if err != nil {
		return pageRead{}, err
	}
	r := pageRead{charts: eaip.ParseAerodromeCharts(doc, ad.URL, text), eff: eaip.PageEffective(body)}
	if ad.Section == 2 || ad.Section == 3 {
		if ap, ok := eaip.ReadAerodrome(doc, ad.ICAO, ad.Section == 3); ok {
			r.airport = &ap
			if p.spec != nil {
				r.zstats = eaip.NewZoneStats()
				r.zones = eaip.ATSAirspace(doc, ap, *p.spec, r.zstats)
				r.points = eaip.ReadVisualPoints(doc, ad.ICAO)
			}
		}
	}
	return r, nil
}
