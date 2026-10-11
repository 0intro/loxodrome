/* The point layers' canvas (map/pointLayerFactory.ts over
 * map/directDrawLayer.ts), on Leaflet itself in Node with a recording
 * canvas (tests/helpers/leafletNode.ts). What it pins:
 *   - the extent painted is queried padded by how far a symbol reaches, so
 *     one whose position is just past the edge still draws, one beyond its
 *     reach does not;
 *   - while the map moves, the layer paints ahead of the view on the side it
 *     goes toward, through the margin (the transform places container
 *     points, a lead on the left moving them in, and the painters are handed
 *     that transform, which a stamped symbol places itself by), and a settle
 *     its newest painting covers paints nothing more;
 *   - a layer whose recent paints average more than 8 ms paints at the
 *     settles only; one slow paint among cheap ones does not make it so, a
 *     paint that sized the canvas is left out, and cheap paints open it
 *     again;
 *   - the lead never shrinks while the view keeps going its way, so a drag
 *     whose speed wavers does not size the canvas back and forth; a new drag
 *     starts afresh, a key pan's glide keeps it across its settles;
 *   - below an airport-style zoom floor nothing draws, the highlight
 *     included. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as LeafletMap, Point } from 'leaflet';
import type { DeviceFrame } from '$lib/map/symbolSprites';
import { FakeCanvas, FakeElement, installLeafletNode } from './helpers/leafletNode';

const env = installLeafletNode({ any3d: true });
const L = (await import('leaflet')).default;
const { createPointLayer } = await import('$lib/map/pointLayerFactory');

interface Pt {
	id: string;
	lat: number;
	lon: number;
}

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

const tick = (): Promise<void> => Promise.resolve();

/** A drawn symbol: which, where (container px), and the transform it was
 *  drawn under. */
interface Drawn {
	id: string;
	x: number;
	y: number;
	transform: number[];
	dev: DeviceFrame;
}

let map: LeafletMap | null = null;
let clear: (() => void) | null = null;

/** A point layer on an 800 x 600 map at Paris z9 over points placed at the
 *  given container positions; each symbol drawn is recorded, and a paint can
 *  be made to take `slowMs` on the clock. */
function mount(
	at: Record<string, [number, number]>,
	floor?: number,
): { drawn: Drawn[]; canvas: () => FakeCanvas; slow: { ms: number }; highlight: (id: string | null) => void; redraw: () => void } {
	const m = L.map(env.container(800, 600) as unknown as HTMLElement, MAP_OPTIONS).setView([48.8, 2.3], 9);
	map = m;
	const items: Pt[] = Object.entries(at).map(([id, [x, y]]) => {
		const ll = m.containerPointToLatLng([x, y]);
		return { id, lat: ll.lat, lon: ll.lng };
	});
	const drawn: Drawn[] = [];
	const slow = { ms: 0 };
	const inst = createPointLayer<Pt>({
		pane: 'pts',
		paneZ: '400',
		canvasClass: 'pts-canvas',
		keyOf: (p) => p.id,
		posOf: (p) => ({ lat: p.lat, lon: p.lon }),
		bulkVisible: () => true,
		drawnAt: () => true,
		anyVisible: () => true,
		drawSymbol: (ctx, p, x, y, o) => {
			drawn.push({ id: p.id, x, y, transform: [...(ctx as unknown as { transform: number[] }).transform], dev: o.dev });
			if (slow.ms > 0) {
				vi.advanceTimersByTime(slow.ms);
			}
		},
		...(floor === undefined ? {} : { zoomFloorHidesHighlight: floor }),
		interactZoomOk: () => true,
		hitWindowPx: 14,
		hitRadiusPx: () => 10,
	});
	inst.build(m, items);
	inst.sync(m);
	clear = () => {
		inst.clear(m);
	};
	const pane = m.getPane('pts') as unknown as FakeElement;
	return {
		drawn,
		canvas: () => pane.childNodes[0] as FakeCanvas,
		slow,
		highlight: (id) => {
			inst.highlight(id);
		},
		redraw: () => {
			inst.redraw();
		},
	};
}

/** Repaint `n` times at the view as it stands: paints that size nothing. */
async function repaint(redraw: () => void, n: number): Promise<void> {
	for (let i = 0; i < n; i++) {
		redraw();
		await tick();
	}
}

/** A drag of `frames` frames eastward at 1 px per ms from a still view:
 *  how many symbols it drew before its settle. */
async function drag(drawn: Drawn[], frames: number): Promise<number> {
	vi.advanceTimersByTime(500);
	const before = drawn.length;
	map?.fire('movestart');
	for (let i = 0; i < frames; i++) {
		await frame(16);
	}
	const during = drawn.length - before;
	map?.fire('moveend');
	await tick();
	return during;
}

/** One frame of a drag: the pane moved and a `move`, as Leaflet's drag does. */
async function frame(dx: number): Promise<void> {
	vi.advanceTimersByTime(16);
	(map as unknown as { _rawPanBy(offset: Point): void })._rawPanBy(L.point(dx, 0));
	map?.fire('move');
	await tick();
}

const ids = (drawn: Drawn[]): string[] => [...new Set(drawn.map((d) => d.id))].sort();

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(() => {
	clear?.();
	clear = null;
	map?.remove();
	map = null;
	vi.useRealTimers();
});

describe('the point layers’ canvas', () => {
	it('draws a symbol whose position is just past the edge, not one beyond its reach', async () => {
		const { drawn } = mount({ in: [400, 300], edge: [-10, 300], far: [-30, 300], right: [900, 300] });
		await tick();
		expect(ids(drawn)).toEqual(['edge', 'in']);
		const edge = drawn.find((d) => d.id === 'edge');
		expect(edge?.x).toBeCloseTo(-10, 6);
		// At rest, no margin: container points are canvas points.
		expect(edge?.transform).toEqual([1, 0, 0, 1, 0, 0]);
	});

	it('paints ahead of a moving view, through the margin, and a covered settle paints nothing more', async () => {
		const { drawn, canvas } = mount({ in: [400, 300], ahead: [900, 300], behind: [-100, 300] });
		await tick();
		expect(ids(drawn)).toEqual(['in']);
		vi.advanceTimersByTime(500);
		drawn.length = 0;
		// Eastward at 1 px per ms: the view goes east, the lead on the right.
		map?.fire('movestart');
		await frame(16);
		expect(ids(drawn)).toEqual(['ahead', 'in']);
		const ahead = drawn.find((d) => d.id === 'ahead');
		expect(ahead?.x).toBeCloseTo(900 - 16, 6);
		// The canvas reaches past the view's right edge, and starts at its left.
		const c = canvas();
		expect(parseFloat(c.style.width ?? '')).toBeGreaterThan(800 + 84);
		expect(ahead?.transform).toEqual([1, 0, 0, 1, 0, 0]);
		const painted = drawn.length;
		for (let i = 0; i < 3; i++) {
			await frame(16);
		}
		// Covered well ahead: nothing more while it lasts, nor at the settle.
		expect(drawn).toHaveLength(painted);
		map?.fire('moveend');
		await tick();
		expect(drawn).toHaveLength(painted);
	});

	it('draws a lead on the left through the transform, the margin moving container points in', async () => {
		const { drawn, canvas } = mount({ in: [400, 300], behind: [-100, 300] });
		await tick();
		vi.advanceTimersByTime(500);
		drawn.length = 0;
		map?.fire('movestart');
		await frame(-16);
		const behind = drawn.find((d) => d.id === 'behind');
		expect(behind?.x).toBeCloseTo(-100 + 16, 6);
		// The canvas starts the margin left of the view: container x is drawn
		// that far in, so the symbol lands inside the canvas.
		const t = behind?.transform ?? [];
		expect(t[4]).toBeGreaterThanOrEqual(84);
		expect(t[4] + (behind?.x ?? 0)).toBeGreaterThan(0);
		expect(parseFloat(canvas().style.width ?? '')).toBeCloseTo(800 + t[4], 6);
		// What a symbol stamped from a sprite places itself by: the same.
		expect(behind?.dev).toEqual({ ratio: t[0], x: t[4], y: t[5] });
	});

	it('paints at the settles only while its recent paints average more than 8 ms', async () => {
		const { drawn, slow, redraw } = mount({ in: [400, 300], ahead: [900, 300] });
		await tick();
		slow.ms = 12;
		await repaint(redraw, 3);
		const before = drawn.length;
		expect(await drag(drawn, 6)).toBe(0);
		// The settle painted.
		expect(drawn.length).toBeGreaterThan(before);
	});

	it('keeps painting through a drag when one paint among cheap ones was slow', async () => {
		const { drawn, slow, redraw } = mount({ in: [400, 300], ahead: [900, 300] });
		await tick();
		await repaint(redraw, 3);
		slow.ms = 20;
		await repaint(redraw, 1);
		slow.ms = 0;
		expect(await drag(drawn, 1)).toBeGreaterThan(0);
	});

	it('paints through a drag again once its paints are cheap', async () => {
		const { drawn, slow, redraw } = mount({ in: [400, 300], ahead: [900, 300] });
		await tick();
		slow.ms = 12;
		await repaint(redraw, 2);
		slow.ms = 0;
		// 12, then a quarter of the way down at each cheap paint: 9, 6.75.
		await repaint(redraw, 1);
		expect(await drag(drawn, 6)).toBe(0);
		// The drag's settle, cheap, took it under.
		expect(await drag(drawn, 1)).toBeGreaterThan(0);
	});

	it('leaves out of the average a paint that sized the canvas', async () => {
		const { drawn, slow } = mount({ in: [400, 300], ahead: [900, 300] });
		// The first paint sizes the canvas from its default 300 x 150: slow,
		// and no measure of what the symbols cost.
		slow.ms = 30;
		await tick();
		expect(drawn.length).toBeGreaterThan(0);
		slow.ms = 0;
		expect(await drag(drawn, 1)).toBeGreaterThan(0);
	});

	it('grows its canvas through a drag whose speed drops, and never shrinks it', async () => {
		const { canvas } = mount({ in: [400, 300] });
		await tick();
		vi.advanceTimersByTime(500);
		map?.fire('movestart');
		const widths: number[] = [];
		let fastPaints = 0;
		// 2 px per ms for a while, then 0.5, long enough to paint again.
		for (let i = 0; i < 72; i++) {
			await frame(i < 12 ? 32 : 8);
			widths.push(canvas().width);
			if (i === 11) {
				fastPaints = canvas().ctx.clears.length;
			}
		}
		expect(Math.max(...widths)).toBeGreaterThan(800 + 128);
		for (let k = 1; k < widths.length; k++) {
			expect(widths[k], `frame ${k}`).toBeGreaterThanOrEqual(widths[k - 1]);
		}
		// It painted again in the slow stretch, at the lead the fast one set.
		expect(canvas().ctx.clears.length).toBeGreaterThan(fastPaints);
	});

	it("starts a new drag's lead afresh", async () => {
		const { canvas } = mount({ in: [400, 300] });
		await tick();
		vi.advanceTimersByTime(500);
		map?.fire('movestart');
		for (let i = 0; i < 12; i++) {
			await frame(32);
		}
		const fast = canvas().width;
		map?.fire('moveend');
		await tick();
		vi.advanceTimersByTime(500);
		// Slower, and long enough to run past what the fast drag painted.
		map?.fire('movestart');
		const paints = canvas().ctx.clears.length;
		for (let i = 0; i < 72; i++) {
			await frame(8);
		}
		expect(canvas().ctx.clears.length).toBeGreaterThan(paints);
		expect(canvas().width).toBeGreaterThan(800);
		expect(canvas().width).toBeLessThan(fast);
	});

	it("keeps a key pan's lead across the settles of its glide", async () => {
		const { canvas } = mount({ in: [400, 300] });
		await tick();
		vi.advanceTimersByTime(500);
		map?.fire('movestart', { keyPan: true });
		for (let i = 0; i < 12; i++) {
			await frame(32);
		}
		const fast = canvas().width;
		// Each half viewport, a key pan settles and starts again: slower now.
		map?.fire('moveend', { keyPan: true });
		await tick();
		map?.fire('movestart', { keyPan: true });
		const paints = canvas().ctx.clears.length;
		for (let i = 0; i < 72; i++) {
			await frame(8);
		}
		expect(canvas().ctx.clears.length).toBeGreaterThan(paints);
		expect(canvas().width).toBe(fast);
	});

	it('draws nothing below a zoom floor, the highlight included', async () => {
		const { drawn, highlight } = mount({ in: [400, 300] }, 9);
		highlight('in');
		await tick();
		expect(drawn).toHaveLength(0);
	});
});
