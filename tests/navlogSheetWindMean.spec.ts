/* Where the mean forecast wind sits in the nav log sheet's title line
 * (NavLogSheet.svelte). Rendered on the server, where no effect runs, so the
 * forecast cache is filled first through a faked fetch. The place is the
 * point: among the route figures, before the provenance line and the date,
 * and never ordered with the 8px notes the A5 card moves to its line 2.
 * Whether a header then grows is a question of layout, which the server
 * cannot answer: the print measures it (navlogMeasure, the part marker
 * included), since a long route title can push the date onto a line of its
 * own. */

import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WindColumn } from '$lib/weather/openMeteo';

import { installLeafletNode } from './helpers/leafletNode';

vi.mock('$lib/weather/openMeteo', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/weather/openMeteo')>();
	const HOUR = 3600_000;
	return {
		...actual,
		fetchWindColumns: (
			points: readonly { lat: number; lon: number }[],
			opts: { startMs: number; endMs: number },
		): Promise<WindColumn[]> => {
			const t0 = Math.floor(opts.startMs / HOUR) * HOUR;
			const n = Math.ceil((opts.endMs - t0) / HOUR) + 2;
			const fill = (v: number): number[] => new Array<number>(n).fill(v);
			return Promise.resolve(
				points.map((p) => ({
					lat: p.lat,
					lon: p.lon,
					elevationM: 0,
					timesMs: Array.from({ length: n }, (_, k) => t0 + k * HOUR),
					hourly: {
						geopotential_height_925hPa: fill(800),
						wind_speed_925hPa: fill(20),
						wind_direction_925hPa: fill(250),
						geopotential_height_850hPa: fill(1500),
						wind_speed_850hPa: fill(20),
						wind_direction_850hPa: fill(250),
						wind_speed_10m: fill(20),
						wind_direction_10m: fill(250),
					},
				})),
			);
		},
		// The run metadata is never asked of the network from a spec.
		fetchModelRun: () => Promise.resolve(null),
	};
});

// The sheet's import graph reaches the map layers, which extend Leaflet's
// classes as they load: real Leaflet, over the few browser properties it
// reads at import.
installLeafletNode();
const { default: NavLogSheet } = await import('$lib/components/NavLogSheet.svelte');
const { flightPrep } = await import('$lib/state/flightPrep.svelte');
const { ensureRouteWindFor, pruneRouteWind } = await import('$lib/state/routeWind.svelte');

type Route = import('$lib/state/route.svelte').Route;

function route(): Route {
	return {
		id: 'sheet-wind-mean',
		name: null,
		selectedWaypointId: null,
		waypoints: [47, 47.5, 48].map((lat, i) => ({
			id: `sheet-wind-mean-${i}`,
			lat,
			lon: 2,
			kind: 'free' as const,
			alt: 3000,
			altAuto: true,
		})),
	};
}

/** The title line's children, in order: each one's own class (the first
 *  that is not Svelte's scoping hash, else its tag, for the unclassed route
 *  title and figures) and its text. */
function titleLine(html: string): { cls: string; text: string }[] {
	const open = /<div class="title-line[^"]*">/.exec(html);
	expect(open).not.toBeNull();
	const start = open!.index + open![0].length;
	const body = html.slice(start, html.indexOf('</div>', start));
	return [...body.matchAll(/<(strong|span)(?: class="([^"]*)")?[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => ({
		cls: (m[2] ?? '').split(/\s+/).find((c) => c !== '' && !c.startsWith('svelte-')) ?? m[1],
		text: m[3].replace(/<!--[\s\S]*?-->/g, '').trim(),
	}));
}

afterEach(() => {
	pruneRouteWind([]);
	flightPrep.dossier.flightDate = null;
	flightPrep.dossier.departureTime = null;
});

describe('the mean forecast wind in the nav log title line', () => {
	it('follows the route figures and precedes the provenance and the date, on screen and on the card', async () => {
		flightPrep.dossier.flightDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
		flightPrep.dossier.departureTime = '10:00';
		const r = route();
		await ensureRouteWindFor(r);
		for (const kneeboard of [false, true]) {
			const items = titleLine(render(NavLogSheet, { props: { route: r, kneeboard } }).body);
			const at = (cls: string): number => items.findIndex((i) => i.cls === cls);
			const mean = at('windmean');
			expect(items[mean]?.text).toBe('Mean forecast wind 250°/20 kt');
			expect(items[mean - 1]?.text).toMatch(/^ETE /);
			expect(mean).toBeLessThan(at('windline'));
			expect(mean).toBeLessThan(at('gen'));
		}
	});

	it('is never ordered onto the card line the provenance takes', () => {
		// The .kneeboard rules move the provenance and its warnings to line 2
		// with `order: 1`, and they are the only title-line rule that may set
		// an order: one reaching the mean, by its own class or a broader
		// selector, would move it off line 1.
		const source = readFileSync('src/lib/components/NavLogSheet.svelte', 'utf8');
		const style = source.slice(source.indexOf('<style>'));
		let provenanceOrdered = false;
		for (const rule of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
			const selectors = rule[1]
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.split(',')
				.map((sel) => sel.trim());
			if (!selectors.some((sel) => sel.includes('.title-line')) || !/\border\s*:/.test(rule[2])) {
				continue;
			}
			for (const sel of selectors) {
				expect(sel).toMatch(/\.title-line \.(windline|windwarn)$/);
			}
			provenanceOrdered = /\border\s*:\s*1\b/.test(rule[2]);
		}
		expect(provenanceOrdered).toBe(true);
	});
});
