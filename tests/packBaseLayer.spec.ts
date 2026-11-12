/* A base map served from its offline pack (map/packBaseLayer.ts), against
 * Leaflet 1.9.4 itself in Node: the pack under the live layer, the live
 * half drawing only above the archive's last zoom, one credit for the two,
 * a tile the archive lacks loaded from the live service, and no zoom jump
 * when the composite comes and goes. */

import { describe, expect, it, vi } from 'vitest';
import { installLeafletNode } from './helpers/leafletNode';

vi.mock('$lib/offline/filePmtiles', () => ({
	pmtilesFromFile: () => ({ getZxy: () => Promise.resolve(undefined) }),
	archiveInfo: () => Promise.resolve({ minZoom: 0, maxZoom: 13, edition: '2026-10-01' }),
}));

const env = installLeafletNode();
const L = (await import('leaflet')).default;
const { BASE_LAYERS } = await import('$lib/map/baseLayers');
const { createPackBaseLayer } = await import('$lib/map/packBaseLayer');

const planign = BASE_LAYERS.find((d) => d.id === 'planign');
if (!planign) {
	throw new Error('no planign base layer');
}

type Halves = { _pack: L.GridLayer & { _miss?: (c: L.Coords) => string }; _live: L.TileLayer };

async function composite() {
	const layer = await createPackBaseLayer(planign!.create(), {} as File, 'basemap:planign');
	return { layer, ...(layer as unknown as Halves) };
}

function map(options: L.MapOptions = {}, zoom = 6): L.Map {
	// No controls: the stand-in DOM cannot host them (the specs' rule).
	return L.map(env.container(800, 600) as unknown as HTMLElement, {
		zoomControl: false,
		attributionControl: false,
		...options,
	}).setView([46.6, 2.5], zoom);
}

const tileZoom = (l: L.GridLayer): number | undefined => (l as unknown as { _tileZoom?: number })._tileZoom;

describe('a base map served from its pack', () => {
	it('draws the pack to its last zoom and the live layer only above it, on top', async () => {
		const { layer, _pack, _live } = await composite();
		expect(_live.options.minZoom).toBe(14);
		expect((_pack.options as L.GridLayerOptions).maxNativeZoom).toBe(13);
		expect(_live.options.zIndex).toBe(2);
		expect((_pack.options as L.GridLayerOptions).zIndex).toBe(1);

		const m = map({ minZoom: 0 }, 13);
		layer.addTo(m);
		expect(tileZoom(_pack)).toBe(13);
		expect(tileZoom(_live)).toBeUndefined(); // below its minZoom: no tiles at all
		m.setZoom(15, { animate: false });
		expect(tileZoom(_live)).toBe(15);
		expect(tileZoom(_pack)).toBe(13); // enlarged underneath, the offline stand-in
		m.remove();
	});

	it('keeps the map where it is when the composite comes and goes, even on a bare map', async () => {
		const { layer } = await composite();
		const m = map({}, 6); // no minZoom: the layers bound the map's zooms
		const setZoom = vi.spyOn(m, 'setZoom');
		layer.addTo(m);
		layer.remove();
		layer.addTo(m);
		expect(m.getZoom()).toBe(6);
		expect(setZoom).not.toHaveBeenCalled();
		layer.remove();
		m.remove();
	});

	it('survives map.remove() with the map\'s minZoom pinned, as MapView pins it', async () => {
		const { layer } = await composite();
		const m = map({ minZoom: 0 }, 6);
		layer.addTo(m);
		const setZoom = vi.spyOn(m, 'setZoom');
		m.remove();
		expect(setZoom).not.toHaveBeenCalled();
	});

	it('credits IGN with one text for the two halves, which the control counts once', async () => {
		// Leaflet's attribution control keys its credits by text, adding each
		// layer's getAttribution() as it arrives: one text is one credit, and
		// the composite itself adds none.
		const { layer, _pack, _live } = await composite();
		const text = _live.getAttribution?.();
		expect(text).toContain('IGN');
		expect(text).toContain('Licence Ouverte');
		expect(_pack.getAttribution?.()).toBe(text);
		expect(layer.getAttribution?.() ?? null).toBeNull();
	});

	it('loads a tile the archive lacks from the live service, at the tile\'s own zoom', async () => {
		const { _pack } = await composite();
		expect(_pack._miss).toBeTypeOf('function');
		const url = _pack._miss!({ x: 2074, y: 1409, z: 12 } as L.Coords);
		expect(url).toContain('LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2');
		expect(url).toContain('TILEMATRIXSET=PM_0_19&TILEMATRIX=12&TILEROW=1409&TILECOL=2074');
	});
});
