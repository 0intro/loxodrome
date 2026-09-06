/* The printed sheet's orientation, and the one place the two platforms
 * disagree about who chooses it.
 *
 * On the web `@page { size: A4 landscape }` picks the sheet. On Android the
 * sheet comes from the PrintAttributes the app hands the print framework and
 * CSS cannot reach it: Chromium lays the page out at the `@page` size, then
 * scales that box onto whatever media the framework picked. With an empty
 * PrintAttributes that media was the framework's own default (A4 portrait),
 * so every landscape flow printed shrunk into the top of a portrait sheet.
 *
 * So the orientation now travels with the call, read off the very CSS each
 * flow installs. This pins the reading, and pins the Java that consumes it,
 * which no TypeScript build can see (the internal/docpack precedent for a
 * cross-language contract). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	PRINT_NAV_PLOT_H,
	PRINT_PLOT_W,
	PRINT_ROUTE_PLOT_H,
	pageOrientation,
} from '$lib/ui/print';
import { DOCUMENT_ORIENTATION } from '$lib/ui/printJob';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('pageOrientation', () => {
	it('reads the app’s own @page strings', () => {
		expect(pageOrientation('@media print { @page { size: A4 landscape; margin: 0; } }')).toBe(
			'landscape',
		);
		expect(pageOrientation('@media print { @page { size: A4 landscape; margin: 10mm; } }')).toBe(
			'landscape',
		);
	});

	it('is portrait when the flow declares no size', () => {
		// The surfaces whose pageCss returns null (flight prep's fuel and
		// mass-and-balance pages, every surface with no pageCss at all).
		expect(pageOrientation(null)).toBe('portrait');
		expect(pageOrientation('@media print { @page { margin: 0; } }')).toBe('portrait');
		expect(pageOrientation('@media print { @page { size: A4; margin: 0; } }')).toBe('portrait');
	});

	it('does not fire on the word appearing outside an @page block', () => {
		expect(pageOrientation('/* landscape */ @media print { @page { margin: 0; } }')).toBe(
			'portrait',
		);
	});

	it('is what the document flows send', () => {
		// The kneeboard, the flight-prep and dossier packs, the weather
		// briefing and the NOTAM bulletin all print installDocumentPageCss's
		// landscape sheet.
		expect(DOCUMENT_ORIENTATION).toBe('landscape');
	});
});

describe('every registered @page in the tree reads back', () => {
	const FILES = [
		'src/lib/components/FlightPrepModal.svelte',
		'src/lib/components/FlightsModal.svelte',
		'src/lib/components/NavProfileModal.svelte',
		'src/lib/components/RouteProfileModal.svelte',
		'src/lib/ui/printJob.ts',
	];

	it('names A4 landscape wherever it names a size, and is read as such', () => {
		// The `${margin}` placeholder in printJob's template literal is why the
		// declaration body is matched a piece at a time rather than as [^}]*.
		const RULE = /@media print \{ @page \{(?:[^{}]|\$\{[^{}]*\})*\} \}/g;
		let seen = 0;
		for (const f of FILES) {
			for (const m of read(f).matchAll(RULE)) {
				seen += 1;
				expect(pageOrientation(m[0]), `${f}: ${m[0]}`).toBe('landscape');
			}
		}
		// Five sources: the four surfaces plus the document flows' own.
		expect(seen).toBe(5);
	});
});

describe('the profile surfaces print at page geometry, not at the screen', () => {
	/* The chart fits its band labels against the pixel size it is built at, so
	 * printing the screen-sized one truncated them (docs/route-profile.md).
	 * Both surfaces must hand RouteProfile the page constants while they hold
	 * the print job, and nothing in their print CSS may re-size the SVG after
	 * the fact. */
	const CASES = [
		['RouteProfileModal', 'routeProfile', 'PRINT_ROUTE_PLOT_H'],
		['NavProfileModal', 'navProfile', 'PRINT_NAV_PLOT_H'],
	] as const;

	for (const [file, surface, heightConst] of CASES) {
		it(`${file} swaps in the page size while printing`, () => {
			const src = read(`src/lib/components/${file}.svelte`);
			expect(src).toMatch(
				new RegExp(`const printing = \\$derived\\(isPrintingSurface\\('${surface}'\\)\\)`),
			);
			expect(src).toMatch(/widthPx=\{printing \? PRINT_PLOT_W : win\.plotW\}/);
			expect(src).toMatch(new RegExp(`heightPx=\\{printing \\? ${heightConst} : win\\.plotH\\}`));
			// The scaling rule this replaced: stretching one viewBox to the
			// page keeps the label fitting it was built with.
			const printCss = src.slice(src.indexOf('@media print'));
			expect(printCss).not.toMatch(/svg\.plot\)?\s*\{[^}]*\b(width|height)\s*:\s*(100%|auto)/);
		});
	}

	it('leaves the chart room for the chrome above it on the tighter platform', () => {
		// A4 landscape content box at the 10mm @page margin is 718px, and the
		// Android framework's own minMargins take it to ~707 (measured). The
		// chart is unbreakable, so it must clear the surface chrome with room
		// for a longer route's crossings strip.
		expect(PRINT_PLOT_W).toBeLessThanOrEqual(1047);
		expect(PRINT_ROUTE_PLOT_H).toBeLessThan(PRINT_NAV_PLOT_H);
		expect(PRINT_NAV_PLOT_H).toBeLessThanOrEqual(640);
	});
});

describe('the Android bridge consumes it', () => {
	const java = read('android/app/src/main/java/fr/loxodrome/app/PrintPlugin.java');

	it('reads the flag the web side sends', () => {
		expect(read('src/lib/ui/print.ts')).toMatch(/landscape: orientation === 'landscape'/);
		expect(java).toMatch(/call\.getBoolean\("landscape", false\)/);
	});

	it('pins A4 in the orientation the flow asked for, both ways', () => {
		// Every @page in the app names A4, the static portrait one included,
		// so the media is always set and always A4; only the rotation varies.
		expect(java).toMatch(
			/setMediaSize\(\s*landscape\s*\?\s*PrintAttributes\.MediaSize\.ISO_A4\.asLandscape\(\)\s*:\s*PrintAttributes\.MediaSize\.ISO_A4\.asPortrait\(\)\s*\)/,
		);
		// One call, so no branch can be left following the device default.
		expect(java.match(/setMediaSize\(/g)).toHaveLength(1);
		expect(java).not.toMatch(/MediaSize\.(?!ISO_A4)\w+/);
	});

	it('still hands the built attributes to the job', () => {
		expect(java).toMatch(/manager\.print\(jobName, adapter, attributes\.build\(\)\)/);
	});
});
