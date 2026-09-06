/* The VAC panel georeference as the app reads it, and the committed dataset
 * as a cross-language pin: cmd/vacgeo writes the rows, src/lib/data/vacgeo.ts
 * decodes them, and the two have to agree about what a row means. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
	loadFrVacGeo,
	panelContains,
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

describe('panelContains', () => {
	it('answers for the chart, not for the box the map culls on', () => {
		// A ground chart is ROTATED, LFPL's by about 75 degrees, so its
		// envelope is the box round a tilted quad and the corners of that
		// box are map rather than chart. A click there belongs to whatever
		// is under it, not to the chart.
		const turned = {
			ident: 'LFPL',
			section: 2,
			page: 3,
			kind: 'GMC',
			clip: [0, 0, 100, 100],
			// a quarter turn: lon runs with the page's y, lat with its x
			aff: [0, 0.001, 0.001, 0, 2.6, 48.8],
			south: 48.8,
			north: 48.9,
			west: 2.6,
			east: 2.7,
		} as unknown as VacPanel;
		// the middle of the quad
		expect(panelContains(turned, 48.85, 2.65)).toBe(true);
		// inside the envelope, outside the clip: x = (lat - 48.8)/0.001 is
		// 120, past the page's 100
		expect(panelContains(turned, 48.92, 2.65)).toBe(false);
	});

	it('holds the edges of the panel itself', () => {
		const p = panelOf('LFPL', 1, 'APP', [50, 33, 403, 484], [48.766, 2.543], [48.912, 2.717]);
		expect(panelContains(p, 48.84, 2.63)).toBe(true);
		// just inside each corner, and just outside each edge
		expect(panelContains(p, 48.7661, 2.5431)).toBe(true);
		expect(panelContains(p, 48.9119, 2.7169)).toBe(true);
		expect(panelContains(p, 48.765, 2.63)).toBe(false);
		expect(panelContains(p, 48.913, 2.63)).toBe(false);
		expect(panelContains(p, 48.84, 2.542)).toBe(false);
		expect(panelContains(p, 48.84, 2.718)).toBe(false);
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
	const held = (view: typeof overLfpl, z: number, drawn: string[]) =>
		vacPanelsIn(view, ['APP', 'ATT', 'GMC'], z, panelNativeZoom, drawn).map(
			(p) => `${p.ident} ${p.kind}`,
		);

	it('answers with the aerodrome under the middle of the view first', async () => {
		// The list is in priority order and the layer paints it back to
		// front, so the first entry is the one that ends on top. The
		// aerodrome the view is centred on leads it.
		await loadPanels([lfplApp, lfplAtt, lfpoApp]);
		const wide = { south: 48.5, west: 2.1, north: 48.85, east: 2.56 };
		expect(at(wide, 12)[0]).toBe('LFPO APP');
		expect(at(overLfpl, 13).slice(0, 2)).toEqual(['LFPL ATT', 'LFPL APP']);
	});

	it('answers nothing when nothing legible is in view', async () => {
		// Over Lognes at a zoom where Lognes' own sheets are thumbnails and
		// no other sheet reaches the screen.
		await loadPanels([lfplApp, lfplAtt, lfpoApp]);
		expect(at(overLfpl, 10)).toEqual([]);
	});

	it('draws a legible neighbour when the centred field has nothing to show', async () => {
		// The middle of the view is asked first and the rest of the screen
		// after it. Asking ONLY the middle blanked a third of all views:
		// when no panel containing the centre had a sheet legible at this
		// zoom the answer was nothing at all, however many legible charts
		// lay around it. Sliding 1.5 km north of Le Bourget put the centre
		// inside one landing panel engraved for zoom 13 and took five
		// legible landing charts off the map.
		//
		// This reverses an earlier rule, and the stacking is why. When one
		// chart drew alone, a neighbour's across a map centred elsewhere
		// read as an answer about the centre. Drawn as a mosaic, each sheet
		// sits on its own ground inside its own neatline and claims nothing
		// about the middle of the screen.
		const wide = { south: 48.7, west: 2.4, north: 48.9, east: 2.75 };
		await loadPanels([lfplApp, lfplAtt, lfpoApp]);
		// Centred on Lognes' panels, which are thumbnails at this zoom;
		// Orly's reaches the screen and is legible.
		expect(at(wide, 11)).toContain('LFPO APP');
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

	it('keeps the chart being read while it is still on screen', async () => {
		// A sheet is often wider than the screen at a legible zoom, so
		// panning across it IS how it is read, and the view centre leaves
		// it long before the chart does. Without this, sliding right to
		// see a chart's eastern half handed the map to whichever
		// neighbour's panel the centre landed on, with half the chart the
		// pilot was reading still in front of them.
		await loadPanels([lfplApp, lfpoApp]);
		// A view east of Lognes' sheet: its centre is on Orly's panel, but
		// Lognes' is still on screen.
		const east = { south: 48.8, west: 2.5, north: 48.84, east: 2.56 };
		expect(held(east, 12, [])[0]).toBe('LFPO APP');
		expect(held(east, 12, ['LFPL'])[0]).toBe('LFPL APP');
	});

	it('lets go once the view has moved on to another aerodrome', async () => {
		// The hold is for reading a sheet wider than the screen, not for
		// carrying an aerodrome around. Panning from Le Touquet to Calais
		// kept Le Touquet's chart on top the whole way, on a tenth of the
		// view at the edge, while Calais sat under the middle covering
		// forty per cent of it.
		await loadPanels([lfplApp, lfpoApp]);
		// Deep in Orly's sheet, with a corner of Lognes' still on screen.
		const corner = { south: 48.5, west: 2.15, north: 48.85, east: 2.6 };
		expect(held(corner, 12, ['LFPL'])[0]).toBe('LFPO APP');
		// And it is still drawn, under Orly's, rather than gone.
		expect(held(corner, 12, ['LFPL'])).toContain('LFPL APP');
	});

	it('lets go once the chart it was holding has left the screen', async () => {
		// Held while visible, and not one pan longer.
		await loadPanels([lfplApp, lfpoApp]);
		// Deep inside Orly's sheet, with Lognes' nowhere on screen.
		const away = { south: 48.5, west: 2.1, north: 48.6, east: 2.2 };
		expect(held(away, 12, ['LFPL'])).toEqual(['LFPO APP']);
	});

	it('stacks a neighbour that covers the same ground rather than hiding it', async () => {
		// Hiding the lower chart was the first rule, and it made charts
		// vanish from the middle of the screen while panning: which one was
		// hidden depended on where the view was centred. Both are drawn
		// now, the more relevant one on top, and the seam is that chart's
		// own neatline.
		const far = axisRow('LFXX', 1, 'APP', [50, 33, 403, 484], [48.9, 3.0], [49.04, 3.17]);
		await loadPanels([lfplApp, far, lfpoApp]);
		// Centred on Lognes, wide enough to reach the far sheet as well.
		const wide = { south: 48.7, west: 2.06, north: 48.98, east: 3.2 };
		const got = at(wide, 12);
		expect(got[0]).toBe('LFPL APP');
		// Orly's sheet covers the same ground as Lognes' and is drawn UNDER
		// it; the distant sheet, touching neither, is drawn too.
		expect(got.slice(1).sort()).toEqual(['LFPO APP', 'LFXX APP']);
	});

	it('never draws a sheet another would hide completely', async () => {
		// Stacking answers what to do where charts OVERLAP. A chart wholly
		// inside another is not overlapped, it is invisible, and it still
		// costs a plate to fetch and a bitmap to hold. Swept over every
		// aerodrome at eight zooms, 498 panels were drawn where nothing of
		// them could be seen, 1.6 GB of bitmap; the SIA files one regional
		// approach chart under several hospital helipads, so a good many
		// panels coincide exactly.
		const inside = axisRow('LFZZ', 1, 'APP', [50, 33, 403, 484], [48.56, 2.17], [48.62, 2.25]);
		await loadPanels([lfpoApp, inside]);
		const over = { south: 48.55, west: 2.15, north: 48.75, east: 2.45 };
		expect(at(over, 12)).toEqual(['LFPO APP']);
	});

	it('does not take a rotated sheet for a cover', async () => {
		// Only an axis-aligned panel covers its own envelope. A ground
		// chart is rotated, LFPL's by about 75 degrees, so its bounds are
		// the box round a tilted quad and the corners of that box are map
		// rather than chart.
		const turned = [
			'LFYY', 2, 1, 'APP', [0, 0, 100, 100], [48.55, 2.15], [48.75, 2.45],
			// a quarter turn: lon runs with y, lat with x
			[0, 0.002, 0.003, 0, 2.15, 48.55],
		];
		const inside = axisRow('LFZZ', 1, 'APP', [50, 33, 403, 484], [48.6, 2.2], [48.66, 2.28]);
		await loadPanels([turned, inside]);
		const over = { south: 48.5, west: 2.1, north: 48.8, east: 2.5 };
		expect(at(over, 12)).toContain('LFZZ APP');
	});

	it('spends a budget on the nearest sheets and turns the rest away', async () => {
		// Drawing every sheet in view is not affordable: 112 MB of bitmap
		// over Creteil at zoom 13, each panel a separate plate to fetch.
		// The budget drops the FARTHEST, at the edge of the view where a
		// chart is least missed and mostly off screen already.
		const far = axisRow('LFXX', 1, 'APP', [50, 33, 403, 484], [48.9, 3.0], [49.04, 3.17]);
		await loadPanels([lfplApp, far, lfpoApp]);
		const wide = { south: 48.7, west: 2.06, north: 48.98, east: 3.2 };
		const two = vacPanelsIn(wide, ['APP', 'ATT', 'GMC'], 12, panelNativeZoom, [], {
			costOf: () => 1,
			budget: 2,
		});
		expect(two.map((p) => p.ident)).toEqual(['LFPL', 'LFPO']);
	});

	it('lets a pinned chart lead whatever the view is centred on', async () => {
		// Which sheet leads is otherwise a heuristic: the aerodrome under
		// the middle of the view. A pin says "this one".
		await loadPanels([lfplApp, lfplAtt, lfpoApp]);
		// Centred on Lognes, with Orly's sheet reaching the screen too.
		const wide = { south: 48.7, west: 2.06, north: 48.98, east: 3.2 };
		expect(at(wide, 12)[0]).toBe('LFPL ATT');
		const pinned = vacPanelsIn(wide, ['APP', 'ATT', 'GMC'], 12, panelNativeZoom, [], {
			pinned: 'LFPO',
		});
		expect(pinned[0]?.ident).toBe('LFPO');
	});

	it('holds a pin where a hold would have lapsed', async () => {
		// A pin is an instruction, not a hold, so it does not have to earn
		// its place under the middle of the view or across a fifth of the
		// screen.
		await loadPanels([lfplApp, lfpoApp]);
		const corner = { south: 48.5, west: 2.15, north: 48.85, east: 2.6 };
		expect(held(corner, 12, ['LFPL'])[0]).toBe('LFPO APP');
		const pinned = vacPanelsIn(corner, ['APP', 'ATT', 'GMC'], 12, panelNativeZoom, [], {
			pinned: 'LFPL',
		});
		expect(pinned[0]?.ident).toBe('LFPL');
	});

	it('ignores a pin it cannot honour', async () => {
		// Out of view, and below the legibility floor: the caller reads the
		// leader back and lets the pin go, so it never becomes a mode.
		await loadPanels([lfplApp, lfplAtt, lfpoApp]);
		const away = { south: 43.5, west: 5.2, north: 43.7, east: 5.5 };
		expect(
			vacPanelsIn(away, ['APP', 'ATT', 'GMC'], 12, panelNativeZoom, [], { pinned: 'LFPL' }),
		).toEqual([]);
		const tiny = vacPanelsIn(overLfpl, ['APP', 'ATT', 'GMC'], 8, panelNativeZoom, [], {
			pinned: 'LFPL',
		});
		expect(tiny.map((p) => p.ident)).not.toContain('LFPL');
	});

	it('keeps the sheets already drawn ahead of any newcomer', async () => {
		// Otherwise the panel at the edge of the budget changes hands as
		// the distances reorder, and it blinks while panning exactly as the
		// hidden ones used to.
		const far = axisRow('LFXX', 1, 'APP', [50, 33, 403, 484], [48.9, 3.0], [49.04, 3.17]);
		await loadPanels([lfplApp, far, lfpoApp]);
		const wide = { south: 48.7, west: 2.06, north: 48.98, east: 3.2 };
		const two = vacPanelsIn(wide, ['APP', 'ATT', 'GMC'], 12, panelNativeZoom, ['LFPL', 'LFXX'], {
			costOf: () => 1,
			budget: 2,
		});
		expect(two.map((p) => p.ident)).toEqual(['LFPL', 'LFXX']);
	});

	it('draws a neighbour at the size it would draw the chosen field at', async () => {
		// Holding a neighbour to its full printed size while the chosen
		// field is held back a level below produces an answer nobody can
		// explain. The Paris basin's approach sheets all engrave at about
		// zoom 11.5, so at zoom 11 the field that happened to be picked
		// drew at seven tenths of printed size while its identical
		// neighbours, on the same screen and at the same scale, were
		// refused. What keeps the quilt away is the overlap rule.
		const far = axisRow('LFXX', 1, 'APP', [50, 33, 403, 484], [48.9, 3.0], [49.04, 3.17]);
		await loadPanels([lfplApp, far]);
		const native = panelNativeZoom(
			panelOf('LFXX', 1, 'APP', [50, 33, 403, 484], [48.9, 3.0], [49.04, 3.17]),
		);
		const wide = { south: 48.7, west: 2.06, north: 48.98, east: 3.2 };
		expect(at(wide, native - 1)).toEqual(['LFPL APP', 'LFXX APP']);
		// And the floor is a floor for both: a level lower it is a smudge
		// and the map wins, neighbour and chosen field alike.
		expect(at(wide, native - 2)).toEqual([]);
	});

	it('looks past a field that has nothing legible to show', async () => {
		// East of Le Plessis-Belleville at zoom 11 the nearest panel is a
		// hospital helipad whose approach sheet is engraved for zoom 12.4.
		// Letting it answer for the screen, and so answering nothing,
		// blanked every approach chart in the basin.
		const helipad = axisRow('LF282', 1, 'APP', [50, 33, 200, 250], [48.86, 2.85], [48.88, 2.87]);
		await loadPanels([lfplApp, helipad]);
		const gap = { south: 48.79, west: 2.6, north: 48.89, east: 2.92 };
		expect(at(gap, 11)).toEqual(['LFPL APP']);
	});

	it('answers nothing for a kind that is switched off', async () => {
		await loadPanels([lfplApp, lfplAtt]);
		expect(at(overLfpl, 13, [])).toEqual([]);
		expect(at(overLfpl, 13, ['GMC'])).toEqual([]);
	});

	it('keeps drawing a sheet the middle of the view has slipped off the edge of', async () => {
		// Lognes' approach panel ends at 2.717 E. A view centred a little
		// past that still has most of the sheet on screen, and it is the
		// ordinary way a chart wider than the window is read. Requiring an
		// answer under the middle blanked it a whole screen early.
		await loadPanels([lfplApp, lfplAtt]);
		const pastTheEdge = { south: 48.8, west: 2.7, north: 48.83, east: 2.8 };
		expect(at(pastTheEdge, 12)).toEqual(['LFPL APP']);
	});

	it('answers nothing when no sheet is in view at all', async () => {
		await loadPanels([lfplApp, lfplAtt]);
		const brittany = { south: 48.3, west: -4.7, north: 48.5, east: -4.2 };
		expect(at(brittany, 13)).toEqual([]);
	});
});
