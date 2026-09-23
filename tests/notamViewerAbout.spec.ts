/* The NOTAM Viewer's About page had no drift net of any kind.
 *
 * tests/aboutCoverage.spec.ts reads `lib/components/AboutModal.svelte` and
 * nothing else, so the flight app's credits are pinned and this app's were
 * not, in the app whose own About argues at length that crediting what it does
 * not carry "would be untrue". The INVERSE went unnoticed for exactly as long:
 * it fetched NOAA weather on every aerodrome panel and the Copernicus
 * elevation mosaic for every airspace profile, credited neither, and said in
 * three separate comments that it had neither.
 *
 * tests/notamViewerDatasets.spec.ts already holds the page to the DATASETS,
 * deriving the publishers from the manifest so one cannot ship uncredited.
 * This is the same trick for the sources that are not datasets: they are
 * declared in `VIEWER_LIVE_SOURCES` beside the manifest, each naming the
 * `t.about.*` heading that owes it a section, and the page is checked against
 * that rather than against a second hand-kept list. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VIEWER_LIVE_SOURCES } from '../src/notam/datasets';

const ABOUT = join(process.cwd(), 'src/notam/AboutSurface.svelte');

function about(): string {
	return readFileSync(ABOUT, 'utf8');
}

/** The `t.about.*` / `t.viewer.*` headings the page renders, in document
 *  order. Only `<h3>{t.x.y}</h3>` counts: the literal `Loxodrome` heading is
 *  the app it points at, not a credit. */
function headings(): string[] {
	return [...about().matchAll(/<h3>\{t\.(\w+)\.(\w+)\}<\/h3>/g)].map((m) => `${m[1]}.${m[2]}`);
}

describe('the NOTAM Viewer About page', () => {
	it('finds the headings at all (the scan itself is load-bearing)', () => {
		expect(headings().length).toBeGreaterThan(4);
	});

	it('credits every live source it declares it reaches', () => {
		// Not a dataset, so notamViewerDatasets.spec.ts cannot see them: the
		// weather relay and the elevation mosaic reach hosts, not /data files.
		const found = headings();
		const missing = VIEWER_LIVE_SOURCES.filter((s) => !found.includes(`about.${s.heading}`));
		expect(missing.map((s) => s.id)).toEqual([]);
	});

	it('carries exactly its credit sections, ordered by TYPE OF DATA', () => {
		// The About credits are classified by the type of data they cover: a
		// new source goes in the section its data belongs to, never after
		// whatever is last, and the order between the seven this app carries
		// is the order aboutCoverage.spec.ts pins for the flight app's ten.
		// EVERY heading the page renders is held to it, whatever catalog it
		// reads: filtering on one namespace let a `t.viewer.*` section
		// anywhere pass unseen. The one catalog heading that credits nothing,
		// the project's own source, is named rather than filtered out; the
		// sibling app's heading is the literal Loxodrome, which the scan does
		// not read.
		const NOT_CREDITS = ['viewer.aboutSourceHeading'];
		const credits = headings().filter((h) => !NOT_CREDITS.includes(h));
		expect(credits).toEqual([
			'about.aipHeading',
			'about.adChartsHeading',
			'about.notamHeading',
			'about.weatherHeading',
			'viewer.aboutBaseMapHeading',
			'about.terrainHeading',
			'about.librariesHeading',
		]);
		// And the declared live sources are exactly the ones among them that
		// no dataset explains: a section the page carries for a source this
		// app does not reach fails here, which is what the old hand-kept list
		// of forbidden keys tried to say.
		const fixed = ['aipHeading', 'adChartsHeading', 'notamHeading', 'librariesHeading'];
		const live = credits
			.filter((h) => h.startsWith('about.'))
			.map((h) => h.slice('about.'.length))
			.filter((h) => !fixed.includes(h));
		expect(live.sort()).toEqual(VIEWER_LIVE_SOURCES.map((s) => s.heading).sort());
	});

	it('credits every base map the Layers popover offers', () => {
		// The corner credit may fold after five seconds only because the
		// licence stays findable here (map/attributionCredit.ts), and the
		// popover offers every BASE_LAYERS entry. Read off the registry's
		// source, the module importing Leaflet.
		const registry = readFileSync(join(process.cwd(), 'src/lib/map/baseLayers.ts'), 'utf8');
		const labels = [...registry.matchAll(/^\t\tlabel: '([^']+)',$/gm)].map((m) => m[1]);
		expect(labels.length).toBeGreaterThanOrEqual(5);
		const src = about();
		const at = src.indexOf('{t.viewer.aboutBaseMapHeading}');
		const list = src.slice(at, src.indexOf('</ul>', at));
		const credited = [...list.matchAll(/<li>/g)].length;
		expect(credited).toBe(labels.length);
		for (const label of labels) {
			// The provider, the label's first word: "Google Satellite" is
			// credited as Google, "Bing Aerial" as Microsoft Bing.
			expect(list).toContain(label.split(' ')[0]);
		}
	});

	it("prints each source's own terms from the credit tables, not from a copy", () => {
		// The AIP section and the aerodrome-chart section list every source
		// the manifest reads with its heading and its licence line, the flight
		// app's own (src/notam/datasets.ts AIP_CREDITS, AD_CHART_CREDITS);
		// the national services sentence alone passed on none of the notices.
		const src = about();
		expect(src).toContain('byName(viewerDatasetPrefixes(), AIP_CREDITS');
		expect(src).toContain('byName(viewerAdChartPrefixes(), AD_CHART_CREDITS');
		expect(src.match(/\{t\.about\[c\.license\]\}/g)).toHaveLength(2);
		// The Licence Ouverte's edition date, beside the SIA's name.
		expect(src).toContain('AIRAC {fmtAiracDate(frCycle)}');
	});

	it('prints the elevation attributions from the manifest, not from a copy', () => {
		// Each tier's `attribution` is VERBATIM what its licence demands, and
		// the Copernicus ones are mandatory. Reading them off the same file the
		// tiles are described by is what stops the credit drifting from what is
		// actually served; AboutModal does it the same way.
		const src = about();
		expect(src).toContain('ensureTerrainRegions');
		expect(src).toContain('terrainRegions()');
		expect(src).toContain('tier.attribution');
	});

});
