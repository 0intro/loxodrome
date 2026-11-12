// Command aipdocs assembles the offline AIP document packs: one file per
// document set holding every PDF the set publishes, with an index at the
// head (internal/docpack). The Android app downloads a pack whole through
// the chart-archive route and slices single documents out of it, so a
// pilot has the Atlas VAC plates and the AIP supplements in the cockpit
// with no network.
//
// It exists because the SIA cannot serve this directly: its PDFs carry no
// CORS header, no Content-Length, no ETag, and it ignores Range, so a
// device can neither read the bytes nor resume, size or revalidate a
// download. Packing the set once per build moves every one of those onto
// R2. The side effect is the one that matters most: the SIA is fetched
// once per cycle in total, instead of once per user.
//
// Which documents a set contains is read out of the committed datasets
// (fr-adcharts.json's Atlas VAC membership, fr-supaip.json's supplement
// rows), never re-scraped, so a pack and the panel that reads it cannot
// disagree. Both AIRAC slots are built, mirroring cmd/fr and cmd/airports:
// the pre-release pack is cut only when fr-adcharts.next.json exists, that
// file's presence being the evidence the SIA pre-release tree is up and its
// membership index was read.
//
//	go run ./cmd/aipdocs -set vac -target auto
//	go run ./cmd/aipdocs -set sup -lang fr
//
// docs/offline-maps.md carries the contract; the pack format and the
// determinism rule are internal/docpack.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/docpack"
)

const (
	// maxMissingFrac aborts a build that lost too much of its set. A
	// handful of retired overseas supplements is normal; a fifth of the
	// Atlas VAC missing means the tree moved and the pack would be worse
	// than none, since the app would believe it holds those plates.
	defaultMaxMissingFrac = 0.05
	// buildTimeout bounds the whole run. 656 plates at six in flight take
	// a few minutes on a warm cache and rather longer on a cold one.
	buildTimeout = 90 * time.Minute
)

func main() {
	log.SetFlags(0)
	var (
		set         = flag.String("set", "vac", `document set: "vac" or "sup"`)
		lang        = flag.String("lang", "fr", `language for -set sup: "fr" or "en"`)
		target      = flag.String("target", "auto", `AIRAC slot: "current", "next" or "auto"`)
		dataDir     = flag.String("data", "public/data", "directory holding the committed datasets")
		outDir      = flag.String("out", "local/aipdocs", "directory to write the packs to")
		cacheDir    = flag.String("cache", "local/aipdocs-cache", "PDF content cache")
		concurrency = flag.Int("concurrency", 6, "concurrent downloads")
		maxMissing  = flag.Float64("max-missing", defaultMaxMissingFrac, "abort above this fraction of missing documents")
	)
	flag.Parse()

	if err := run(*set, *lang, *target, *dataDir, *outDir, *cacheDir, *concurrency, *maxMissing); err != nil {
		log.Fatalf("aipdocs: %v", err)
	}
}

func run(set, lang, target, dataDir, outDir, cacheDir string, concurrency int, maxMissing float64) error {
	ctx, cancel := context.WithTimeout(context.Background(), buildTimeout)
	defer cancel()

	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	f := &fetcher{concurrency: concurrency}

	switch set {
	case "sup":
		if lang != "fr" && lang != "en" {
			return fmt.Errorf(`-lang must be "fr" or "en"; got %q`, lang)
		}
		return buildSup(ctx, f, lang, dataDir, outDir, cacheDir, maxMissing)
	case "vac":
		return buildVac(ctx, f, target, dataDir, outDir, cacheDir, maxMissing)
	default:
		return fmt.Errorf(`-set must be "vac" or "sup"; got %q`, set)
	}
}

// buildVac cuts the Atlas VAC pack for one or both AIRAC slots. The current
// slot is built FIRST, per the repo rule that a publisher listing several
// editions hands over the oldest first: writing the current slot is what
// retires a pre-release it has caught up with.
func buildVac(ctx context.Context, f *fetcher, target, dataDir, outDir, cacheDir string, maxMissing float64) error {
	slots := []struct {
		name    string // dataset stem
		out     string // pack file name
		wantNow bool   // build it in "auto"
	}{
		// The pack file name IS the archive id the app asks for, so the
		// worker's rule stays "object = <id>.pack" with no mapping table.
		// That is why the pre-release is fr-vac-next and not the datasets'
		// own fr-vac.next: there the ".next" is spliced into a URL, here the
		// id is the address.
		{"fr-adcharts", "fr-vac.pack", target == "current" || target == "auto"},
		{"fr-adcharts.next", "fr-vac-next.pack", target == "next" || target == "auto"},
	}

	built := 0
	for _, slot := range slots {
		if !slot.wantNow {
			continue
		}
		data := filepath.Join(dataDir, slot.name+".json")
		meta := filepath.Join(dataDir, slot.name+".meta.json")
		if _, err := os.Stat(data); err != nil {
			if target == "auto" {
				// No pre-release published yet, which is the normal state
				// for most of a cycle. Not an error.
				log.Printf("%s: absent, skipping", slot.name)
				continue
			}
			return fmt.Errorf("%s: %w", data, err)
		}
		effective, err := aip.ReadEffective(meta)
		if err != nil {
			return err
		}
		rows, err := loadVacRows(data)
		if err != nil {
			return err
		}
		refs := vacDocs(rows, effective)
		if len(refs) == 0 {
			return fmt.Errorf("%s: no Atlas VAC membership", data)
		}
		cycle := aip.EAIPDateSegment(effective)
		f.dir = filepath.Join(cacheDir, "vac", cycle)
		meta2 := docpack.Meta{
			Set:       "fr-vac",
			Cycle:     cycle,
			Effective: effective.Format("2006-01-02"),
		}
		if err := assemble(ctx, f, refs, meta2, filepath.Join(outDir, slot.out), maxMissing); err != nil {
			return err
		}
		built++
	}
	if built == 0 {
		return fmt.Errorf("no slot built for -target %s", target)
	}
	return nil
}

// buildSup cuts the AIP supplement pack. It has no AIRAC slot: the SIA
// serves supplements from stable URLs, so the set changes when a supplement
// is published or lapses, not on the cycle.
func buildSup(ctx context.Context, f *fetcher, lang, dataDir, outDir, cacheDir string, maxMissing float64) error {
	data := filepath.Join(dataDir, "fr-supaip.json")
	rows, err := loadSupRows(data)
	if err != nil {
		return err
	}
	today := time.Now().UTC().Format("2006-01-02")
	refs := supDocs(rows, lang, today)
	if len(refs) == 0 {
		return fmt.Errorf("%s: no supplement in force", data)
	}
	f.dir = filepath.Join(cacheDir, "sup")
	return assemble(ctx, f, refs, docpack.Meta{Set: "fr-sup", Lang: lang},
		filepath.Join(outDir, "fr-sup-"+lang+".pack"), maxMissing)
}

// assemble fetches every reference and writes the pack.
func assemble(ctx context.Context, f *fetcher, refs []docRef, meta docpack.Meta, out string, maxMissing float64) error {
	log.Printf("%s: %d documents", meta.Set, len(refs))
	last := 0
	results := f.all(ctx, refs, func(done, total int) {
		if done*10/total > last {
			last = done * 10 / total
			log.Printf("%s: %d/%d", meta.Set, done, total)
		}
	})
	if err := firstError(results); err != nil {
		return err
	}

	var docs []docpack.Doc
	for _, r := range results {
		if r.missing {
			meta.Missing = append(meta.Missing, r.ref.Name)
			continue
		}
		docs = append(docs, docpack.Doc{Name: r.ref.Name, Path: r.path})
	}
	if frac := float64(len(meta.Missing)) / float64(len(refs)); frac > maxMissing {
		return fmt.Errorf("%s: %d of %d documents missing (%.1f%%), above the %.1f%% floor",
			meta.Set, len(meta.Missing), len(refs), frac*100, maxMissing*100)
	}

	// Write beside the target and rename, so a failed run never leaves a
	// truncated pack where a complete one was.
	tmp := out + ".part"
	fh, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if err := docpack.Write(fh, meta, docs); err != nil {
		fh.Close()
		return err
	}
	if err := fh.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, out); err != nil {
		return err
	}

	info, err := os.Stat(out)
	if err != nil {
		return err
	}
	log.Printf("%s: wrote %s, %d documents, %d missing, %.1f MB",
		meta.Set, out, len(docs), len(meta.Missing), float64(info.Size())/(1<<20))
	return nil
}
