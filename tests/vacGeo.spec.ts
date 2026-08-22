/* The VAC panel georeference as the app reads it, and the committed dataset
 * as a cross-language pin: cmd/vacgeo writes the rows, src/lib/data/vacgeo.ts
 * decodes them, and the two have to agree about what a row means. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
	loadFrVacGeo,
	panelNativeZoom,
	panelPtPerDegLat,
	type VacPanel,
	type VacPanelKind,
} from '$lib/data/vacgeo';
import { ensureVacGeo, resetVacGeoForTest, vacPanelsIn } from '$lib/state/vacGeo.svelte';

/** A north-up affine, the shape a graticule panel writes. */
const AXIS = [1, 0, 0, 1, 0, 0] as const;

/** One dataset row with the affine the two corners imply, so a fixture
 *  cannot state a mapping its own corners disagree with. */
function axisRow(
	ident: string,
	page: number,
	kind: string,
	clip: readonly [number, number, number, number],
	sw: readonly [number, number],
	ne: readonly [number, number],
): unknown[] {
	const d = (ne[0] - sw[0]) / (clip[3] - clip[1]);
	const a = (ne[1] - sw[1]) / (clip[2] - clip[0]);
	return [
		ident,
		2,
		page,
		kind,
		clip,
		sw,
		ne,
		[a, 0, 0, d, sw[1] - clip[0] * a, sw[0] - clip[1] * d],
	];
}

function panelOf(
	ident: string,
	page: number,
	kind: 'APP' | 'ATT' | 'GMC',
	clip: readonly [number, number, number, number],
	sw: readonly [number, number],
	ne: readonly [number, number],
): VacPanel {
	const r = axisRow(ident, page, kind, clip, sw, ne);
	return {
		ident,
		section: 2,
		page,
		kind,
		clip,
		aff: r[7] as VacPanel['aff'],
		south: sw[0],
		north: ne[0],
		west: sw[1],
		east: ne[1],
	};
}

interface Doc {
	fields: string[];
	rows: unknown[][];
}

const doc = JSON.parse(
	readFileSync(new URL('../public/data/fr-vacgeo.json', import.meta.url), 'utf-8'),
) as Doc;

const meta = JSON.parse(
	readFileSync(new URL('../public/data/fr-vacgeo.meta.json', import.meta.url), 'utf-8'),
) as {
	panels: number;
	aerodromes: number;
	byKind: Record<string, number>;
	bbox?: number[];
};

/** Decode through the app's own loader by standing in for fetch. */
async function decode(body: unknown): Promise<VacPanel[]> {
	const original = globalThis.fetch;
	globalThis.fetch = () =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				headers: { 'content-type': 'application/json' },
			}),
		);
	try {
		return await loadFrVacGeo('/data/fr-vacgeo.json');
	} finally {
		globalThis.fetch = original;
	}
}

describe('loadFrVacGeo', () => {
	it('resolves columns by name, so an inserted column cannot shift the reader', async () => {
		const panels = await decode({
			fields: [
				'kind',
				'ident',
				'nonsense',
				'section',
				'page',
				'clip',
				'sw',
				'ne',
				'aff',
			],
			rows: [
				['ATT', 'lfpl', 0, 2, 2, [14, 352, 367, 550], [48.8, 2.56], [48.84, 2.67], AXIS],
			],
		});
		expect(panels).toHaveLength(1);
		expect(panels[0]).toMatchObject({
			ident: 'LFPL',
			section: 2,
			page: 2,
			kind: 'ATT',
			south: 48.8,
			west: 2.56,
			north: 48.84,
			east: 2.67,
		});
	});

	it('drops a row it cannot trust rather than placing a chart approximately', async () => {
		const panels = await decode({
			fields: ['ident', 'section', 'page', 'kind', 'clip', 'sw', 'ne', 'aff'],
			rows: [
				['LFXX', 2, 1, 'IAC', [0, 0, 1, 1], [1, 1], [2, 2], AXIS], // not a mapped family
				['LFXX', 9, 1, 'APP', [0, 0, 1, 1], [1, 1], [2, 2], AXIS], // no such section
				['LFXX', 2, 1, 'APP', [0, 0, 1], [1, 1], [2, 2], AXIS], // short clip
				['LFXX', 2, 1, 'APP', [0, 0, 1, 1], [1], [2, 2], AXIS], // half a corner
				['LFXX', 2, 1, 'APP', [0, 0, 1, 1], [1, 1], [2, 2], [1, 2, 3]], // short affine
			],
		});
		expect(panels).toEqual([]);
	});

	it('reads a corner pair whichever way round it is stored', async () => {
		const [p] = await decode({
			fields: ['ident', 'section', 'page', 'kind', 'clip', 'sw', 'ne', 'aff'],
			rows: [
				['LFRB', 2, 1, 'APP', [50, 34, 402, 468], [48.64, -4.18], [48.22, -4.69], AXIS],
			],
		});
		expect(p.south).toBeCloseTo(48.22, 5);
		expect(p.north).toBeCloseTo(48.64, 5);
		expect(p.west).toBeCloseTo(-4.69, 5);
		expect(p.east).toBeCloseTo(-4.18, 5);
	});

	it('answers with no panels when the file is missing', async () => {
		const original = globalThis.fetch;
		globalThis.fetch = () => Promise.resolve(new Response('', { status: 404 }));
		try {
			await expect(loadFrVacGeo('/data/nope.json')).resolves.toEqual([]);
		} finally {
			globalThis.fetch = original;
		}
	});

	it('answers with no panels when the dev server returns its SPA shell', async () => {
		const original = globalThis.fetch;
		globalThis.fetch = () =>
			Promise.resolve(
				new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
			);
		try {
			await expect(loadFrVacGeo('/data/fr-vacgeo.json')).resolves.toEqual([]);
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe('panelNativeZoom', () => {
	it('is the zoom at which a point of paper is about a pixel of screen', () => {
		// LFPL's approach sheet: 450 points of paper over 0.146 degrees of
		// latitude. That is about 1:100 000, and 1:100 000 is a pixel to
		// the point at zoom 11.5, where a Web Mercator pixel is 36 m and a
		// point of paper at that scale is 35.
		//
		const p = panelOf(
			'LFPL',
			1,
			'APP',
			[50.52, 33.41, 403.07, 483.74],
			[48.76608, 2.54307],
			[48.91221, 2.71661],
		);
		expect(panelPtPerDegLat(p)).toBeCloseTo(3082, -1);
		expect(panelNativeZoom(p)).toBeCloseTo(11.5, 1);
	});

	it('puts a larger-scale landing panel above an approach one', () => {
		const app = panelOf('LFPL', 1, 'APP', [0, 0, 350, 450], [48.76, 2.5], [48.91, 2.7]);
		const att = panelOf('LFPL', 2, 'ATT', [0, 0, 350, 200], [48.8, 2.5], [48.84, 2.7]);
		expect(panelNativeZoom(att)).toBeGreaterThan(panelNativeZoom(app));
	});
});

describe('the committed dataset', () => {
	it('decodes every row the builder wrote', async () => {
		const panels = await decode(doc);
		expect(panels).toHaveLength(doc.rows.length);
		expect(panels.length).toBe(meta.panels);
		expect(new Set(panels.map((p) => p.ident)).size).toBe(meta.aerodromes);
	});

	it('agrees with its own sidecar about what it holds', async () => {
		const panels = await decode(doc);
		const byKind: Record<string, number> = {};
		for (const p of panels) {
			byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
		}
		expect(byKind).toEqual(meta.byKind);
	});

	it('places every panel the right way up and inside the envelope', async () => {
		const panels = await decode(doc);
		const bbox = meta.bbox ?? [-180, -90, 180, 90];
		for (const p of panels) {
			expect(p.north).toBeGreaterThan(p.south);
			expect(p.east).toBeGreaterThan(p.west);
			// A VAC panel is a local sheet: nothing here spans a degree of
			// latitude, and a row that did would be a misread graticule.
			expect(p.north - p.south).toBeLessThan(1);
			expect(p.east - p.west).toBeLessThan(1.5);
			expect(p.clip[2]).toBeGreaterThan(p.clip[0]);
			expect(p.clip[3]).toBeGreaterThan(p.clip[1]);
			const cLat = (p.south + p.north) / 2;
			const cLon = (p.west + p.east) / 2;
			expect(cLon).toBeGreaterThanOrEqual(bbox[0]);
			expect(cLat).toBeGreaterThanOrEqual(bbox[1]);
			expect(cLon).toBeLessThanOrEqual(bbox[2]);
			expect(cLat).toBeLessThanOrEqual(bbox[3]);
		}
	});

	it('places the western half of the country in the west', async () => {
		// LFRB is at 004 25 W. Before the hemisphere was read off the
		// plate's own header, its approach sheet fitted perfectly and
		// landed in Champagne.
		const panels = await decode(doc);
		const brest = panels.filter((p) => p.ident === 'LFRB');
		expect(brest.length).toBeGreaterThan(0);
		for (const p of brest) {
			expect(p.west).toBeLessThan(0);
			expect(p.east).toBeLessThan(0);
			expect(p.south).toBeGreaterThan(48);
			expect(p.north).toBeLessThan(49);
		}
	});
});

describe('vacPanelsIn', () => {
	/** Load the module's private list through its own ensure path. */
	async function loadPanels(rows: unknown[][]): Promise<void> {
		resetVacGeoForTest();
		const original = globalThis.fetch;
		globalThis.fetch = (input: RequestInfo | URL) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			const body = url.endsWith('.meta.json')
				? { effective: '2026-08-06' }
				: {
						fields: ['ident', 'section', 'page', 'kind', 'clip', 'sw', 'ne', 'aff'],
						rows,
					};
			return Promise.resolve(
				new Response(JSON.stringify(body), {
					headers: { 'content-type': 'application/json' },
				}),
			);
		};
		try {
			await ensureVacGeo();
		} finally {
			globalThis.fetch = original;
		}
	}

	// Lognes: an approach sheet over the field and a landing sheet inside
	// it, at the scales the real plate is drawn to.
	const lfplApp = axisRow('LFPL', 1, 'APP', [50, 33, 403, 484], [48.766, 2.543], [48.912, 2.717]);
	const lfplAtt = axisRow('LFPL', 2, 'ATT', [14, 352, 367, 550], [48.805, 2.569], [48.845, 2.676]);
	// Orly's approach sheet, which covers Lognes as well and is drawn to a
	// much smaller scale.
	const lfpoApp = axisRow('LFPO', 1, 'APP', [51, 35, 404, 475], [48.48, 2.11], [48.85, 2.56]);
	const overLfpl = { south: 48.81, west: 2.6, north: 48.835, east: 2.65 };

	const at = (view: typeof overLfpl, z: number, kinds: VacPanelKind[] = ['APP', 'ATT', 'GMC']) =>
		vacPanelsIn(view, kinds, z, panelNativeZoom).map((p) => `${p.ident} ${p.kind}`);

	it('draws the aerodrome under the middle of the view, not its neighbours', async () => {
		// The obvious rule, every sheet whose scale suits the zoom, tiles a
		// dozen approach charts across the Paris basin. Only the sheet the
		// view is centred on is the answer to the question a VAC asks.
		await loadPanels([lfplApp, lfplAtt, lfpoApp]);
		const wide = { south: 48.5, west: 2.1, north: 48.85, east: 2.56 };
		expect(at(wide, 12)).toEqual(['LFPO APP']);
		expect(at(overLfpl, 13).sort()).toEqual(['LFPL APP', 'LFPL ATT']);
	});

	it('answers nothing rather than a neighbour when the chosen field is too small to read', async () => {
		// Over Lognes at a zoom where Lognes' own sheets are thumbnails,
		// Orly's chart covers the same ground and IS legible. Choosing the
		// aerodrome after the zoom test put Orly's approach sheet across
		// the screen while the map was centred on Lognes.
		await loadPanels([lfplApp, lfplAtt, lfpoApp]);
		expect(at(overLfpl, 10)).toEqual([]);
	});

	it('holds a sheet back until a level under its printed size', async () => {
		await loadPanels([lfplApp]);
		const native = panelNativeZoom(
			panelOf('LFPL', 1, 'APP', [50, 33, 403, 484], [48.766, 2.543], [48.912, 2.717]),
		);
		// A sheet at half its engraved size is not yet a chart to read, but
		// it is one to see coming, and an overlay that arrives only once
		// you are on top of the aerodrome cannot say the aerodrome is
		// there. A level under that it is a smudge, and the map wins.
		expect(at(overLfpl, native - 2)).toEqual([]);
		expect(at(overLfpl, native - 1)).toEqual(['LFPL APP']);
	});

	it('hands over from the approach sheet to the landing sheet as the view closes', async () => {
		await loadPanels([lfplApp, lfplAtt]);
		// Far out: only the approach sheet is big enough.
		expect(at(overLfpl, 10.5)).toEqual(['LFPL APP']);
		// Closer: both, and the layer draws the landing sheet over the other.
		expect(at(overLfpl, 13).sort()).toEqual(['LFPL APP', 'LFPL ATT']);
		// On the ground: the approach sheet is past its ceiling and gone.
		expect(at(overLfpl, 15)).toEqual(['LFPL ATT']);
	});

	it('does not let the ground chart evict the landing sheet as it arrives', async () => {
		// The floor and the ceiling interact through the nearest-scale
		// rule. Admitting the ground chart a level earlier makes it the
		// nearest sheet at that zoom, and a ceiling that had not moved with
		// the floor then dropped the landing sheet: four kilometres of
		// chart replaced by a patch a kilometre wide.
		const lfplGmc = axisRow(
			'LFPL',
			3,
			'GMC',
			[50, 33, 403, 550],
			[48.8176, 2.6154],
			[48.8277, 2.6357],
		);
		await loadPanels([lfplApp, lfplAtt, lfplGmc]);
		expect(at(overLfpl, 14.5).sort()).toEqual(['LFPL ATT', 'LFPL GMC']);
	});

	it('keeps the best-scaled sheet however far past its size the view goes', async () => {
		// There is nothing better to show for that place, and a pilot in
		// the circuit is the reader this is for.
		await loadPanels([lfplApp, lfplAtt]);
		expect(at(overLfpl, 18)).toEqual(['LFPL ATT']);
	});

	it('draws one sheet per family, not both editions of a plate', async () => {
		// A large aerodrome files a plate in each Atlas product, so it has
		// two landing sheets of the same ground at slightly different
		// scales; drawn together they are the quilt in miniature.
		const other = axisRow('LFPL', 2, 'ATT', [14, 352, 367, 550], [48.803, 2.567], [48.847, 2.678]);
		other[1] = 3;
		await loadPanels([lfplAtt, other]);
		expect(at(overLfpl, 13)).toEqual(['LFPL ATT']);
	});

	it('answers nothing for a kind that is switched off', async () => {
		await loadPanels([lfplApp, lfplAtt]);
		expect(at(overLfpl, 13, [])).toEqual([]);
		expect(at(overLfpl, 13, ['GMC'])).toEqual([]);
	});

	it('answers nothing when the view is centred on no sheet at all', async () => {
		await loadPanels([lfplApp, lfplAtt]);
		const brittany = { south: 48.3, west: -4.7, north: 48.5, east: -4.2 };
		expect(at(brittany, 13)).toEqual([]);
	});
});
