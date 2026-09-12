// backfill.go: recover supplements the listing never advertised to us.
//
// Retention (merge.go) keeps what the dataset has already seen, and the file's
// git history gave back what it saw before retention existed. Neither reaches a
// supplement that lapsed before this project ever scraped it: the listing does
// not carry it, and its own date filter narrows the live set only, so there is
// no archive view to ask.
//
// The media store still serves them, though. Filenames are
// <prefix>_sup[_a]_<year>_<NNN>_<lang>.pdf under one flat directory, so a
// supplement can be found by NUMBER, with the AIRAC marker settled by probing
// both variants; whichever answers also states the marker. A swept supplement
// has no listing row, so its subject and validity come from the cover page
// instead (header.go), which is why its row is warned as listing-absent.

package main

import (
	"context"
	"fmt"
	"path"
	"strings"
)

// regionPrefix maps a region key to its media-store filename prefix. The
// prefix decides the path too, the store sharding on the filename's first two
// characters (pdfURL), so a region's files sit under their own bucket.
var regionPrefix = map[string]string{
	"metropole":   "lf",
	"car-sam-nam": "carsamnam",
	"pac-n":       "pacn",
	"pac-p":       "pacp",
	"run":         "run",
}

// sweepGap is how many consecutive absent numbers end a region's sweep. Real
// gaps run to a dozen or so where a block of supplements has lapsed together,
// so the stop has to clear that without walking the whole number space.
const sweepGap = 30

// sweepCeiling bounds a sweep that finds nothing at all, so a wrong year or a
// moved media path cannot turn into an unbounded crawl.
const sweepCeiling = 400

// sweepMissing probes the media store for every number of `year` that `have`
// does not already carry, one region at a time. Returns the supplements it
// recovered; a number absent from the store is simply skipped.
func sweepMissing(ctx context.Context, cache *pdfCache, lim *limiter, year int, have map[string]bool) []rawSup {
	var out []rawSup
	for _, reg := range regions {
		prefix, ok := regionPrefix[reg.key]
		if !ok {
			continue
		}
		misses := 0
		found := 0
		for n := 1; n <= sweepCeiling && misses < sweepGap; n++ {
			if have[fmt.Sprintf("%s-%d-%03d", reg.key, year, n)] {
				// Already ours: it says the number space is still live here,
				// so it resets the run of misses without costing a request.
				misses = 0
				continue
			}
			pdf, filename := probeMedia(ctx, cache, lim, prefix, year, n)
			if pdf == nil {
				misses++
				continue
			}
			misses = 0
			found++
			enName := enFilename(filename)
			pdfEn, err := cache.getDirect(ctx, pdfURL(enName), enName, "en:", lim)
			if err != nil {
				pdfEn = nil
			}
			out = append(out, sweptRawSup(reg.key, year, n, filename, pdf, pdfEn))
		}
		if found > 0 {
			fmt.Printf("backfill %s %d: recovered %d\n", reg.key, year, found)
		}
	}
	return out
}

// probeMedia resolves one supplement's PDF by number. The AIRAC marker is not
// derivable from the number (it is scattered through a year's sequence), so
// both variants are tried; the one that answers settles it.
func probeMedia(ctx context.Context, cache *pdfCache, lim *limiter, prefix string, year, number int) ([]byte, string) {
	for _, marker := range []string{"_sup_a_", "_sup_"} {
		fn := fmt.Sprintf("%s%s%d_%03d_fr.pdf", prefix, marker, year, number)
		body, err := cache.getDirect(ctx, pdfURL(fn), fn, "fr:", lim)
		if err == nil && body != nil {
			return body, fn
		}
	}
	return nil, ""
}

// sweptRawSup assembles a supplement that has no listing row. The subject and
// the validity come from the cover page; the traffic badges have no source in
// the document at all, so both are set, the permissive value and the one every
// listed supplement claims anyway.
func sweptRawSup(region string, year, number int, filename string, pdf, pdfEn []byte) rawSup {
	from, to := frValidity(pdf)
	return rawSup{
		region:    region,
		number:    number,
		year:      year,
		descFr:    frSubject(pdf),
		validFrom: from,
		validTo:   to,
		ifr:       true,
		vfr:       true,
		airac:     strings.Contains(filename, "_sup_a_"),
		filename:  filename,
		pdf:       pdf,
		pdfEn:     pdfEn,
		swept:     true,
	}
}

// hasRowWarning reports whether a decoded row already carries a warning code.
func hasRowWarning(row []any, code string) bool {
	if len(row) <= 18 {
		return false
	}
	list, ok := row[18].([]any)
	if !ok {
		return false
	}
	for _, w := range list {
		if s, ok := w.(string); ok && s == code {
			return true
		}
	}
	return false
}

// refreshRetained re-parses the supplements the listing has dropped, using the
// PDF url their own row carries. Retention freezes a row at the parser version
// that wrote it, which costs real quality once the geometry parser improves:
// 142/26 was carried forward with five zones and names like "(ZRT 1", where
// today's parser reads seven, the ZIT among them, with clean names and their
// activation dates.
//
// The listing-derived fields (subject, validity, traffic) come from the
// retained row, since they are what the sweep cannot recover and the listing no
// longer offers; everything else is re-read from the document. A supplement
// whose PDF has gone is simply not returned, and retention keeps it as it was.
func refreshRetained(ctx context.Context, cache *pdfCache, lim *limiter, rows [][]any, retainFrom int, have map[string]bool) []rawSup {
	var out []rawSup
	for _, row := range rows {
		id := rowID(row)
		if id == "" || have[id] {
			continue
		}
		region, year, number, ok := splitID(id)
		if !ok || year < retainFrom {
			continue
		}
		url, _ := row[6].(string)
		if url == "" || !strings.HasPrefix(url, pdfStore) {
			continue
		}
		filename := path.Base(url)
		// Re-derive the URL from the filename rather than trusting the stored
		// one. A retained row is frozen at the bytes that were written for it,
		// so it carries whatever URL was thought correct then, and the
		// metropole-bucket bug is exactly a stored URL that never resolved:
		// trusting it would make the refresh unable to heal the rows it exists
		// to heal.
		pdf, err := cache.getDirect(ctx, pdfURL(filename), filename, "fr:", lim)
		if err != nil || pdf == nil {
			continue
		}
		enName := enFilename(filename)
		pdfEn, err := cache.getDirect(ctx, pdfURL(enName), enName, "en:", lim)
		if err != nil {
			pdfEn = nil
		}
		str := func(i int) string {
			if i >= len(row) {
				return ""
			}
			s, _ := row[i].(string)
			return s
		}
		flag := func(i int) bool {
			if i >= len(row) {
				return false
			}
			b, _ := row[i].(bool)
			return b
		}
		out = append(out, rawSup{
			region:    region,
			number:    number,
			year:      year,
			descFr:    str(3),
			validFrom: str(7),
			validTo:   str(8),
			ifr:       flag(9),
			vfr:       flag(10),
			airac:     strings.Contains(filename, "_sup_a_"),
			filename:  filename,
			pdf:       pdf,
			pdfEn:     pdfEn,
			// A refreshed row keeps whatever provenance it had: re-reading the
			// geometry does not give a swept supplement a listing row, so its
			// subject and validity are still the cover page's.
			swept: hasRowWarning(row, "listing-absent"),
		})
	}
	if len(out) > 0 {
		fmt.Printf("refreshed %d retained supplements\n", len(out))
	}
	return out
}
