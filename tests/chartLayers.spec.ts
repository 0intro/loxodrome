/* Which chart layers leave the machine. A layer with no public tile source is
 * LOCAL-ONLY: nothing its publisher states lets this app re-serve the chart
 * (each says why beside its source in map/chartOverlays.ts), so production
 * neither lists it nor offers it as an offline pack. The two gates read
 * different fields: the Layers tab and the About credits ask for a public
 * source (`publishedChartLayers`), while the offline manager's list is every
 * def carrying an `archive` (`packableCharts`), whatever the build. An archive
 * on a local-only layer would offer the whole chart for download on every
 * production install, and nothing but this spec would notice. */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('leaflet', () => ({
	default: { latLngBounds: (a: unknown, b: unknown) => ({ a, b }) },
}));
vi.mock('$lib/offline/passiveTiles', () => ({ cachedTileLayer: () => null }));

const { CHART_LAYERS, publishedChartLayers } = await import('$lib/map/chartOverlays');
const { CHART_WORKER } = await import('$lib/net/endpoints');

/** The charts held back by their publishers' terms. The list is the whole
 *  set, so a new layer with no public source has to be named here, which is
 *  where the decision gets recorded (bg500 arrived without it), and one of
 *  these growing a public source fails. */
const LOCAL_ONLY = ['nl500', 'cz500', 'no250', 'si250', 'hu500', 'ro500', 'ba500', 'al500', 'bg500'];

describe('local-only chart layers', () => {
	it('are exactly the ones named here', () => {
		const local = CHART_LAYERS.filter((d) => d.sources.public === undefined).map((d) => d.id);
		expect(local.sort()).toEqual([...LOCAL_ONLY].sort());
	});

	it('draw from the local dev server alone', () => {
		for (const id of LOCAL_ONLY) {
			const def = CHART_LAYERS.find((d) => d.id === id);
			expect(def, id).toBeDefined();
			expect(def?.sources.public, id).toBeUndefined();
			expect(def?.archive, id).toBeUndefined();
			expect(def?.sources.local, id).toMatch(/^http:\/\/localhost:8080\//);
		}
	});

	it('are never listed in production', () => {
		const published = new Set(publishedChartLayers().map((d) => d.id));
		for (const d of CHART_LAYERS) {
			expect(published.has(d.id), d.id).toBe(d.sources.public !== undefined);
		}
	});

	it('are never offered as a pack: an archive only where the worker publishes the chart', () => {
		for (const d of CHART_LAYERS) {
			if (d.archive === undefined) {
				continue;
			}
			expect(d.sources.public, d.id).toBeDefined();
			expect(d.archive, d.id).toBe(`${CHART_WORKER}/${d.id}/archive`);
		}
	});
});

describe('the About credits of the published charts', () => {
	it('name every holder the map corner credits', () => {
		// The corner credit folds away after five seconds, and the About line
		// is where it stays findable (map/attributionCredit.ts): the Austrian
		// sheet's corner named the BEV's topographic base, its About line did
		// not.
		const missing: string[] = [];
		for (const def of publishedChartLayers()) {
			const text = def.attribution.replace(/<[^>]*>/g, '');
			for (const part of text.split('&copy;').slice(1)) {
				const holder = part.split(/[,/]/)[0].trim();
				if (holder !== '' && !`${def.label} ${def.license}`.includes(holder)) {
					missing.push(`${def.id}: ${holder}`);
				}
			}
		}
		expect(missing).toEqual([]);
	});
});

describe("the README's chart layers", () => {
	// It said thirteen and named HungaroControl, whose chart is held back, in
	// both places, when eighteen were published, Austro Control's among them.
	const readme = readFileSync('README.md', 'utf8');
	const published = publishedChartLayers();
	const publisher = (label: string): string => label.split(' ')[0];
	const names = (text: string, word: string): boolean =>
		new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
	const paragraphs = [
		/\n\n(\w+) official chart layers stack over the map[\s\S]*?\n\n/.exec(readme),
		/\n\nThe raster charts come from[\s\S]*?\n\n/.exec(readme),
	];

	it('count the published layers', () => {
		const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
		expect(paragraphs[0]).not.toBeNull();
		expect(words.indexOf(paragraphs[0]![1].toLowerCase())).toBe(published.length);
	});

	it('name every published publisher, and no held-back one', () => {
		const shown = new Set(published.map((d) => publisher(d.label)));
		for (const m of paragraphs) {
			expect(m).not.toBeNull();
			for (const word of shown) {
				expect(names(m![0], word), word).toBe(true);
			}
			for (const def of CHART_LAYERS.filter((d) => d.sources.public === undefined)) {
				const word = publisher(def.label);
				if (!shown.has(word)) {
					expect(names(m![0], word), def.id).toBe(false);
				}
			}
		}
	});
});
