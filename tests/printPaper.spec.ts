/* What paper is made of, pinned where the stylesheets and the print flows
 * state it (readFileSync, the radarPaper / navlogPaper precedent).
 *
 * The nav log printed pale on the club's printer: the shared print palette
 * pinned the day theme's SCREEN greys, and the print-color-adjust: exact the
 * stripes need also switches off Firefox's own darkening of pale text. A
 * night session was worse: every token the palette did not pin printed its
 * night value (the nav log's wind warning in a pale amber, the trace profile
 * whole). So the palette now carries paper inks (tests/contrast.spec.ts pins
 * their ratios), and the night theme is a screen theme, which this pins with
 * the roots that carry the palette and the rules every sheet shares. Also
 * what two flows put on the sheet: a profile prints at rest whatever the
 * pointer is doing, and the packs carry the POH reference. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string =>
	readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const theme = read('src/styles/theme.css');
const app = read('src/app.css');

/** Every component whose print root carries the paper palette. */
const PRINT_FLOWS = [
	'src/lib/components/NavLogModal.svelte',
	'src/lib/components/FlightPrepModal.svelte',
	'src/lib/components/flightprep/PrintDoc.svelte',
	'src/lib/components/RouteProfileModal.svelte',
	'src/lib/components/NavProfileModal.svelte',
	'src/lib/components/FlightsModal.svelte',
];

describe('night never reaches paper', () => {
	it('theme.css has one night root, opened directly inside @media screen', () => {
		expect(theme.match(/\[data-theme=/g)).toHaveLength(1);
		const at = theme.search(/:root\[data-theme=(["'])night\1\]/);
		expect(at).toBeGreaterThan(0);
		expect(theme.slice(0, at)).toMatch(/@media screen \{\s*$/);
		// The night rule is the wrapper's only rule and the file's last: its
		// own block (tokens and comments, no nested braces), then the
		// wrapper's closing brace, then nothing.
		expect(theme.slice(at)).toMatch(/^[^{}]*\{[^{}]*\}\s*\}\s*$/);
	});

	it("the map credit's night chip stays on screen with the night tokens", () => {
		// Its background is a night literal: on paper, under the day text ink
		// the tokens resolve to there, it printed day grey on near-black.
		expect(app).toMatch(
			/@media screen \{\s*:root\[data-theme="night"\] \.leaflet-control-attribution/,
		);
	});
});

describe('every designed print carries the paper palette', () => {
	const ROOTS: [string, string][] = [
		['src/lib/components/NavLogModal.svelte', 'boxClass="navlog-box print-palette"'],
		['src/lib/components/NavLogModal.svelte', 'class="pg-doc print-palette"'],
		['src/lib/components/NavLogModal.svelte', 'class="kb-doc print-palette"'],
		['src/lib/components/FlightPrepModal.svelte', 'boxClass="flight-prep-box print-palette"'],
		['src/lib/components/flightprep/PrintDoc.svelte', 'class="fpd-doc print-palette"'],
		['src/lib/components/RouteProfileModal.svelte', 'boxClass="route-profile-box print-palette"'],
		['src/lib/components/NavProfileModal.svelte', 'boxClass="nav-profile-box print-palette"'],
		['src/lib/components/FlightsModal.svelte', 'boxClass="flights-box print-palette"'],
	];
	for (const [file, needle] of ROOTS) {
		it(`${file.replace(/^.*\//, '')}: ${needle}`, () => {
			expect(read(file)).toContain(needle);
		});
	}

	const PLOTS: [string, string][] = [
		['src/lib/components/RouteProfileModal.svelte', 'class="plot-area print-plot-ink"'],
		['src/lib/components/NavProfileModal.svelte', 'class="plot-area print-plot-ink"'],
		['src/lib/components/flightprep/PrintDoc.svelte', 'class="fpd-plot print-plot-ink"'],
	];
	for (const [file, needle] of PLOTS) {
		it(`${file.replace(/^.*\//, '')}: ${needle}`, () => {
			expect(read(file)).toContain(needle);
		});
	}

	it('no print flow pins a theme token of its own: paper inks live in app.css', () => {
		// A local pin is how the flight-prep flows kept a second orange (the
		// workbook's paler one) after the shared palette took over the rest.
		const themeTokens = new Set([...theme.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
		for (const file of PRINT_FLOWS) {
			const declared = [...read(file).matchAll(/(--[\w-]+)\s*:/g)]
				.map((m) => m[1])
				.filter((tok) => themeTokens.has(tok));
			expect(declared, file).toEqual([]);
		}
		expect(app).not.toMatch(/--workbook-orange\s*:/);
	});
});

describe('the rules every sheet shares', () => {
	it('paper is white: one html / body rule, no copy per flow', () => {
		expect(app.match(/@media print \{\s*html,\s*body \{\s*background: #fff;\s*\}\s*\}/g)).toHaveLength(1);
		for (const file of ['src/app.css', 'src/lib/components/FlightPrepModal.svelte']) {
			expect(read(file), file).not.toMatch(/html\.[\w-]+ body\b/);
		}
	});

	it('no surface carries its shadow onto the sheet', () => {
		expect(app).toMatch(/@media print \{\s*\.modal-box \{[^}]*box-shadow: none !important;/);
	});
});

describe('a profile prints at rest, whatever the pointer is doing', () => {
	/* A pointer parked on the chart at Ctrl+P froze its hover onto the sheet:
	 * the trace profile printed the dim and the crosshair as they stood, and
	 * the route profile's print CSS undid the dim by setting one style for all
	 * of a dimmed band's paths, the very ones that differ included (a NO-GO
	 * penetration printed at the plain band's tenth of fill). The chart now
	 * drops its hover itself while its surface holds the print job. */
	const chart = read('src/lib/components/RouteProfile.svelte');

	it('RouteProfile reads no hover while printing', () => {
		expect(chart).toMatch(
			/const hl = \$derived\(printing \? null : \(hoveredBandKey \?\? highlightKey\)\);/,
		);
		expect(chart).toContain('{#if inspectNM != null && dragLeg === null && !printing}');
		expect(chart).toContain('{#if onCursor && hoverNM != null && !pinned && !printing}');
	});

	for (const [file, surface] of [
		['RouteProfileModal', 'routeProfile'],
		['NavProfileModal', 'navProfile'],
	] as const) {
		it(`${file} hands its print job to the chart and undoes no hover in CSS`, () => {
			const src = read(`src/lib/components/${file}.svelte`);
			expect(src).toMatch(
				new RegExp(`const printing = \\$derived\\(isPrintingSurface\\('${surface}'\\)\\)`),
			);
			expect(src).toMatch(/<RouteProfile\n(?:[^/]|\/(?!>))*\n\s*\{printing\}\n/);
			expect(src).not.toMatch(/\.(?:band|nband|band-label)\.(?:dimmed|highlight)/);
		});
	}
});

describe('the packs carry the POH reference', () => {
	/* The club sheet prints the POH tables and their correction notes on every
	 * performance sheet. The packs mount the page afresh, so its fold was
	 * closed there and they printed its summary line alone: no headwind,
	 * tailwind, grass, wet or flapless correction in the flight bag. */
	const page = read('src/lib/components/flightprep/PerformancePage.svelte');

	it('PrintDoc mounts the performance page with its fold open', () => {
		expect(read('src/lib/components/flightprep/PrintDoc.svelte')).toContain('<PerformancePage pohOpen />');
	});

	it('both POH folds open on that prop, and only on it', () => {
		expect(page).toMatch(/const \{ pohOpen = false \}: \{ pohOpen\?: boolean \} = \$props\(\);/);
		expect(page.match(/<details\b[^>]*>/g)).toEqual([
			'<details class="poh" open={pohOpen}>',
			'<details class="poh charts" open={pohOpen}>',
		]);
		// The on-screen page starts closed, and the per-page print follows it.
		expect(read('src/lib/components/FlightPrepModal.svelte')).not.toMatch(/<PerformancePage[^>]*pohOpen/);
	});

	it('prints the fold as a heading, without its disclosure triangle', () => {
		const printCss = page.slice(page.indexOf('@media print'));
		expect(printCss).toMatch(/\.poh > summary \{\s*list-style: none;\s*\}/);
	});
});
