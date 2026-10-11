/* Every tile layer the map can show loads its tiles while the map moves, on a
 * phone too, every 100 ms (map/tileMotion.ts), against Leaflet 1.9.4 itself
 * in Node: the option is only worth what Leaflet's GridLayer does with it, a
 * throttled `move` handler.
 *
 * Leaflet decides the default once, at import, from Browser.mobile; Node is
 * no phone, so the spec makes the default a phone's before building any
 * layer, and shows that a layer left to it would wait for the settle. */

import { describe, expect, it, vi } from 'vitest';
import { installLeafletNode } from './helpers/leafletNode';

vi.mock('$lib/offline/filePmtiles', () => ({
	pmtilesFromFile: () => ({}),
	archiveInfo: () => Promise.resolve({ minZoom: 0, maxZoom: 13, edition: null }),
}));

const env = installLeafletNode();
const L = (await import('leaflet')).default;
// What Leaflet sets at import in a mobile browser, the WebView included.
(L.GridLayer.prototype.options as L.GridLayerOptions).updateWhenIdle = true;
const { BASE_LAYERS } = await import('$lib/map/baseLayers');
const { CHART_LAYERS, createChartLayer } = await import('$lib/map/chartOverlays');
const { createPackChartLayer } = await import('$lib/map/packChartLayer');

/** Whether a layer loads tiles while the map moves: Leaflet hooks `move`
 *  only when updateWhenIdle is off. */
function loadsWhileMoving(layer: L.GridLayer): boolean {
	return (layer.options as L.GridLayerOptions).updateWhenIdle === false && typeof layer.getEvents?.().move === 'function';
}

describe('tiles while the map moves', () => {
	it('is what a phone does NOT get from a layer left to the default', () => {
		const plain = L.tileLayer('https://example.test/{z}/{x}/{y}.png');
		expect((plain.options as L.GridLayerOptions).updateWhenIdle).toBe(true);
		expect(plain.getEvents?.().move).toBeUndefined();
	});

	it('is every base map, on the web and in the Android shell', () => {
		const win = env.window as unknown as Record<string, unknown>;
		for (const native of [false, true]) {
			if (native) {
				win.Capacitor = {};
			} else {
				delete win.Capacitor;
			}
			for (const def of BASE_LAYERS) {
				expect(loadsWhileMoving(def.create()), `${def.id} native=${native}`).toBe(true);
			}
		}
		delete win.Capacitor;
	});

	it('is every chart layer, from either source and from a downloaded pack', () => {
		let made = 0;
		for (const def of CHART_LAYERS) {
			for (const source of ['public', 'local'] as const) {
				const layer = createChartLayer(def, source, `chart-${def.id}`);
				if (layer) {
					expect(loadsWhileMoving(layer), `${def.id} ${source}`).toBe(true);
					made++;
				}
			}
			const pack = createPackChartLayer(def, `chart-${def.id}`, {} as File);
			expect(loadsWhileMoving(pack), `${def.id} pack`).toBe(true);
		}
		expect(made).toBeGreaterThan(0);
	});

	it('is both halves of a base map served from its offline pack', async () => {
		const { createPackBaseLayer } = await import('$lib/map/packBaseLayer');
		const def = BASE_LAYERS.find((d) => d.id === 'planign');
		expect(def).toBeDefined();
		const composite = await createPackBaseLayer(def!.create(), {} as File, 'basemap:planign');
		const { _pack, _live } = composite as unknown as { _pack: L.GridLayer; _live: L.TileLayer };
		expect(loadsWhileMoving(_pack), 'pack').toBe(true);
		expect(loadsWhileMoving(_live), 'live').toBe(true);
		expect((_pack.options as L.GridLayerOptions).updateInterval).toBe(100);
	});

	it('looks at the view every 100 ms while it moves, not Leaflet\'s 200', () => {
		for (const def of BASE_LAYERS) {
			expect((def.create().options as L.GridLayerOptions).updateInterval, def.id).toBe(100);
		}
	});
});
