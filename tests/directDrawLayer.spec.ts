/* The direct-draw canvas base (map/directDrawLayer.ts), every canvas overlay's
 * lifecycle, run on Leaflet itself in Node (tests/helpers/leafletNode.ts):
 *   - the canvas sits at the viewport's corner in layer points, backed at the
 *     ratio, sized in CSS px to the viewport;
 *   - one paint per task, however many events and redraws the task holds;
 *   - the follow-mode overscan: a pan inside the drawn margin repaints
 *     nothing, one past it does, and a forced redraw always does;
 *   - a margin uneven from side to side places, sizes and covers by each
 *     side;
 *   - the CSS size follows a browser zoom that leaves the backing store as it
 *     was (the ratio and the viewport changing together);
 *   - the recent paints' average leaves out a paint that sized the canvas and
 *     one its _draw set aside. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Map as LeafletMap } from 'leaflet';
import type { Margin } from '$lib/map/canvasPlacement';
import { FakeCanvas, installLeafletNode } from './helpers/leafletNode';

const env = installLeafletNode();
const L = (await import('leaflet')).default;
const { DirectDrawLayer, ensurePane, setDrawOverscan } = await import('$lib/map/directDrawLayer');

const MAP_OPTIONS = {
	zoomControl: false,
	attributionControl: false,
	boxZoom: false,
	doubleClickZoom: false,
	dragging: false,
	keyboard: false,
	scrollWheelZoom: false,
	touchZoom: false,
	trackResize: false,
	fadeAnimation: false,
	zoomAnimation: false,
	markerZoomAnimation: false,
};

class Probe extends DirectDrawLayer {
	protected override readonly canvasClass = 'probe-canvas';
	protected override readonly paneName = 'probe';
	draws = 0;
	protected override _draw(): void {
		this.draws++;
	}
	canvas(): FakeCanvas {
		return this._canvas as unknown as FakeCanvas;
	}
}

/** A probe whose paint takes `cost` ms on the faked clock and may set itself
 *  aside. */
class TimedProbe extends Probe {
	cost = 0;
	aside = false;
	protected override _draw(): void {
		super._draw();
		vi.advanceTimersByTime(this.cost);
		if (this.aside) {
			this._paintAside = true;
		}
	}
	average(): number | null {
		return this._paintAvgMs;
	}
	cheap(): boolean {
		return this._paintsCheaply();
	}
}

class OverscannedProbe extends Probe {
	protected override readonly overscanned = true;
}

class LopsidedProbe extends Probe {
	protected override _marginFor(): Margin {
		return { left: 50, top: 0, right: 10, bottom: 20 };
	}
	extent(map: LeafletMap): { x0: number; y0: number; x1: number; y1: number } {
		return this._paintExtent(map);
	}
}

function mapOf(width = 800, height = 600): LeafletMap {
	const map = L.map(env.container(width, height) as unknown as HTMLElement, MAP_OPTIONS).setView([48.8, 2.3], 9);
	ensurePane(map, 'probe', '400');
	return map;
}

/** Let the layer's coalesced paint (a microtask) run. */
const settle = (): Promise<void> => Promise.resolve();

afterEach(() => {
	setDrawOverscan(0);
	env.window.devicePixelRatio = 1;
});

describe('DirectDrawLayer', () => {
	it('places the canvas at the viewport corner, backed at the ratio and sized in CSS px', async () => {
		env.window.devicePixelRatio = 2;
		const map = mapOf();
		const p = new Probe().addTo(map);
		await settle();
		const c = p.canvas();
		expect([c.width, c.height]).toEqual([1600, 1200]);
		expect([c.style.width, c.style.height]).toEqual(['800px', '600px']);
		map.panBy([120, -40], { animate: false });
		const at = (c as unknown as { _leaflet_pos: { x: number; y: number } })._leaflet_pos;
		expect([at.x, at.y]).toEqual([120, -40]);
		expect(map.layerPointToContainerPoint([at.x, at.y])).toEqual(L.point(0, 0));
	});

	it('paints once per task, however many events and redraws it holds', async () => {
		const map = mapOf();
		const p = new Probe().addTo(map);
		await settle();
		expect(p.draws).toBe(1);
		// A view reset fires zoomend, moveend and viewreset in one call.
		map.setView([48.9, 2.5], 10, { animate: false });
		p.redraw();
		p.redraw();
		expect(p.draws).toBe(1);
		await settle();
		expect(p.draws).toBe(2);
	});

	it('repaints nothing for a pan inside the overscan margin, and repaints past it or when forced', async () => {
		setDrawOverscan(96);
		const map = mapOf();
		const p = new OverscannedProbe().addTo(map);
		await settle();
		const c = p.canvas();
		expect([c.style.width, c.style.height]).toEqual([`${800 + 192}px`, `${600 + 192}px`]);
		const before = p.draws;
		map.panBy([60, -30], { animate: false });
		await settle();
		expect(p.draws).toBe(before);
		p.redraw();
		await settle();
		expect(p.draws).toBe(before + 1);
		map.panBy([200, 0], { animate: false });
		await settle();
		expect(p.draws).toBe(before + 2);
		// Without the margin, every pan repaints.
		setDrawOverscan(0);
		map.panBy([5, 0], { animate: false });
		await settle();
		expect(p.draws).toBe(before + 3);
		map.panBy([5, 0], { animate: false });
		await settle();
		expect(p.draws).toBe(before + 4);
	});

	it('places, sizes and covers by each side of an uneven margin', async () => {
		const map = mapOf();
		const p = new LopsidedProbe().addTo(map);
		await settle();
		const c = p.canvas();
		expect([c.style.width, c.style.height]).toEqual([`${800 + 60}px`, `${600 + 20}px`]);
		const at = (c as unknown as { _leaflet_pos: { x: number; y: number } })._leaflet_pos;
		expect([at.x, at.y]).toEqual([-50, 0]);
		const e = p.extent(map);
		// (+ 0: a margin of none negates to -0.)
		expect([e.x0, e.y0 + 0, e.x1, e.y1]).toEqual([-50, 0, 810, 620]);
		const before = p.draws;
		// West 40 px: inside the left margin, nothing to paint.
		map.panBy([-40, 0], { animate: false });
		await settle();
		expect(p.draws).toBe(before);
		// 20 more: past it.
		map.panBy([-20, 0], { animate: false });
		await settle();
		expect(p.draws).toBe(before + 1);
		// East 20 px from there: past the right margin's 10.
		map.panBy([20, 0], { animate: false });
		await settle();
		expect(p.draws).toBe(before + 2);
		// South 15: inside the bottom margin; north 1: past the top's none.
		map.panBy([0, 15], { animate: false });
		await settle();
		expect(p.draws).toBe(before + 2);
		map.panBy([0, -16], { animate: false });
		await settle();
		expect(p.draws).toBe(before + 3);
	});

	it('sizes the box at the backing store over the ratio, so the painting is never resampled', async () => {
		// 1001 x 500 at 1.2 with 60 px of margin across and 20 down: 1061 CSS
		// px are 1273.2 device px, backed by 1274 and shown in 1274 / 1.2;
		// 520 are 624 exactly.
		env.window.devicePixelRatio = 1.2;
		const map = mapOf(1001, 500);
		const p = new LopsidedProbe().addTo(map);
		await settle();
		const c = p.canvas();
		expect([c.width, c.height]).toEqual([1274, 624]);
		expect([c.style.width, c.style.height]).toEqual([`${Math.round((1274 / 1.2) * 1e6) / 1e6}px`, '520px']);
		// Never short of the extent it paints.
		expect(parseFloat(c.style.width ?? '')).toBeGreaterThanOrEqual(1061);
		env.window.devicePixelRatio = 1;
	});

	it('keeps the CSS size true when a browser zoom leaves the backing store as it was', async () => {
		// 1250 x 500 at 1 and 1000 x 400 at 1.25 both back 1250 x 500.
		const map = mapOf(1250, 500);
		const p = new Probe().addTo(map);
		await settle();
		const c = p.canvas();
		expect([c.width, c.height]).toEqual([1250, 500]);
		const writes = c.sizeWrites;
		env.window.devicePixelRatio = 1.25;
		const el = map.getContainer() as unknown as { clientWidth: number; clientHeight: number };
		el.clientWidth = 1000;
		el.clientHeight = 400;
		map.invalidateSize();
		await settle();
		expect(c.sizeWrites).toBe(writes);
		expect([c.style.width, c.style.height]).toEqual(['1000px', '400px']);
	});

	it('leaves a sizing paint and a paint set aside out of the recent paints\' average', async () => {
		vi.useFakeTimers({ toFake: ['performance'] });
		try {
			const map = mapOf();
			const p = new TimedProbe();
			// The first paint sizes the canvas: left out.
			p.cost = 40;
			p.addTo(map);
			await settle();
			expect(p.average()).toBeNull();
			expect(p.cheap()).toBe(true);
			p.cost = 2;
			p.redraw();
			await settle();
			expect(p.average()).toBe(2);
			// Dear, but set aside: the average stands, the gate stays open.
			p.cost = 30;
			p.aside = true;
			p.redraw();
			await settle();
			expect(p.average()).toBe(2);
			expect(p.cheap()).toBe(true);
			// The flag is the one paint's: the next, as dear, is taken.
			p.aside = false;
			p.redraw();
			await settle();
			expect(p.average()).toBe(2 + (30 - 2) * 0.25);
			expect(p.cheap()).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
