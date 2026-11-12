/* A canvas layer whose paintings are made off screen and shown whole
 * (map/bitmapDrawLayer.ts), on Leaflet itself in Node with an OffscreenCanvas
 * and a bitmaprenderer context stood in (tests/helpers/leafletNode.ts). The
 * paintings land when the spec says, as a worker's would. What it pins:
 *   - a painting shows in one go: the canvas sized to the bitmap before the
 *     transfer, the CSS size, the corner, the view recorded;
 *   - a painting that lands after a pan shows at once, riding the pane;
 *   - a zoom holds: a painting that lands mid-zoom is dropped and its bitmap
 *     closed, the one on screen is placed scaled for the settled view until
 *     its successor lands, and hides past four times;
 *   - a redraw asked for mid-zoom waits for the settle;
 *   - whenIdle waits for the painting on its way;
 *   - a painting landing after the layer left the map is closed;
 *   - a painting that draws nothing shows as a hidden pixel, the canvas
 *     shrunk and the null handed over once, its latency not counted, and
 *     the next painting shows whole;
 *   - without the platform's support, the layer paints its canvas directly;
 *   - a layer that paints off the main thread paints while the map moves:
 *     at most once per interval, each painting reaching ahead of the view
 *     on the side it goes toward, the view covered by the painting on screen
 *     at every frame once the first of them has landed, through a keyPan
 *     glide's periodic settle too, whether a painting takes less than the
 *     interval or twice as long; nothing while a zoom holds, for a re-centre
 *     inside the follow margin, while the newest painting covers the view
 *     well ahead, or at a settle it covers, and no lead once the map is at
 *     rest; a drag measured from its start, asking at its first move, and a
 *     new movement led on its own side whatever the last one did; a speed
 *     measured over 8 ms at least, a drag's first jump left out of it; no
 *     velocity measured across a zoom, nor lost at a glide's own settle; a
 *     jittery drag led at its mean speed; one slow painting not
 *     setting the pace; a request the interval held back dropped at a settle
 *     or when the layer leaves, answered by a painting sent meanwhile, and
 *     waited for by whenIdle. A layer painting on the page, or its canvas
 *     directly, paints at the settles only;
 *   - on a screen denser than 2, a fast movement's paintings are made at 2,
 *     and the view never comes to rest on one: a slower view takes a
 *     painting at the full ratio, the settle then painting nothing more, and
 *     a drag held still takes one once the view has stopped; a screen at 2
 *     and the page painting keep their own ratio. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as LeafletMap, Point } from 'leaflet';
import { FakeBitmap, FakeCanvas, installLeafletNode } from './helpers/leafletNode';

const env = installLeafletNode({ any3d: true, bitmap: true });
const L = (await import('leaflet')).default;
const { BitmapDrawLayer } = await import('$lib/map/bitmapDrawLayer');
const { ensurePane, MOTION_INTERVAL_MS, setDrawOverscan } = await import('$lib/map/directDrawLayer');
type CanvasTarget = import('$lib/map/directDrawLayer').CanvasTarget;
type Paint2D = import('$lib/map/symbolBase').Paint2D;

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

/** A layer whose paintings land when `land()` says, recording what it was
 *  asked to paint and what it handed back. */
class Probe extends BitmapDrawLayer {
	protected override readonly canvasClass = 'probe-canvas';
	protected override readonly paneName = 'probe';
	deferred = true;
	readonly waiting: { seq: number; t: CanvasTarget }[] = [];
	readonly made: FakeBitmap[] = [];
	painted = 0;

	protected override _paintTarget(ctx: Paint2D, _canvas: { width: number; height: number }, _t: CanvasTarget): void {
		this.painted++;
		ctx.fillRect(0, 0, 1, 1);
	}

	protected override _paint(seq: number, t: CanvasTarget): void {
		if (this.deferred) {
			this.waiting.push({ seq, t });
			return;
		}
		super._paint(seq, t);
	}

	/** Land the oldest painting waiting. */
	land(): FakeBitmap {
		const w = this.waiting.shift();
		if (!w) {
			throw new Error('nothing waiting');
		}
		const b = new FakeBitmap(w.t.w, w.t.h);
		this.made.push(b);
		this._scheduler.arrived(w.seq, { bitmap: b, target: w.t });
		return b;
	}

	canvas(): FakeCanvas {
		return this._canvas as unknown as FakeCanvas;
	}
}

/** A probe whose paintings draw nothing while `empty` holds. */
class EmptyProbe extends Probe {
	empty = true;
	protected override _paint(seq: number, t: CanvasTarget): void {
		if (this.empty) {
			this._scheduler.arrived(seq, { bitmap: null, target: t });
			return;
		}
		super._paint(seq, t);
	}
	latency(): number {
		return this._latencyMs;
	}
}

function mapOf(): LeafletMap {
	const map = L.map(env.container(800, 600) as unknown as HTMLElement, MAP_OPTIONS).setView([48.8, 2.3], 9);
	ensurePane(map, 'probe', '400');
	return map;
}

const tick = (): Promise<void> => Promise.resolve();

/** The layer-point position the canvas was last placed at, and its scale. */
function placement(c: FakeCanvas): { x: number; y: number; scale: number } {
	const m = /translate3d\((-?[\d.e-]+)px,\s*(-?[\d.e-]+)px/.exec(c.style.transform ?? '');
	const s = /scale\(([\d.e-]+)\)/.exec(c.style.transform ?? '');
	return { x: m ? Number(m[1]) : NaN, y: m ? Number(m[2]) : NaN, scale: s ? Number(s[1]) : 1 };
}

describe('BitmapDrawLayer', () => {
	it('shows a painting in one go: sized, transferred, placed, recorded', async () => {
		env.window.devicePixelRatio = 2;
		const map = mapOf();
		const p = new Probe().addTo(map);
		expect(p.mode).toBe('bitmap');
		await tick();
		expect(p.waiting).toHaveLength(1);
		const b = p.land();
		const c = p.canvas();
		expect(c.renderer?.shown).toBe(b);
		expect([c.width, c.height]).toEqual([1600, 1200]);
		expect([c.style.width, c.style.height]).toEqual(['800px', '600px']);
		expect(placement(c)).toEqual({ x: 0, y: 0, scale: 1 });
		env.window.devicePixelRatio = 1;
	});

	it('shows a painting that draws nothing as a hidden pixel, once, and the next one whole', async () => {
		const map = mapOf();
		const p = new EmptyProbe().addTo(map);
		await tick();
		const c = p.canvas();
		expect([c.width, c.height]).toEqual([1, 1]);
		expect(c.style.visibility).toBe('hidden');
		expect(c.renderer?.shown).toBeNull();
		const transfers = c.renderer?.transfers;
		const writes = c.sizeWrites;
		const latency = p.latency();
		// Another, after a pan: nothing reallocated, nothing handed over.
		map.panBy([300, 0], { animate: false });
		p.redraw();
		await tick();
		expect(c.renderer?.transfers).toBe(transfers);
		expect(c.sizeWrites).toBe(writes);
		expect(c.style.visibility).toBe('hidden');
		expect(p.latency()).toBe(latency);
		// Something to draw: sized, handed over, shown.
		p.empty = false;
		p.redraw();
		await tick();
		const b = p.land();
		expect(c.renderer?.shown).toBe(b);
		expect([c.width, c.height]).toEqual([800, 600]);
		expect(c.style.visibility).toBe('');
	});

	it('shows a painting that lands after a pan at once, riding the pane', async () => {
		const map = mapOf();
		const p = new Probe().addTo(map);
		await tick();
		map.panBy([150, 0], { animate: false });
		await tick();
		// Made for the view before the pan, it lands and shows where it was made.
		p.land();
		const c = p.canvas();
		expect(placement(c)).toMatchObject({ x: 0, y: 0 });
		// The pan's own painting was owed, and goes now.
		expect(p.waiting).toHaveLength(1);
		p.land();
		expect(placement(c)).toMatchObject({ x: 150, y: 0 });
	});

	it('drops what lands mid-zoom, and shows the old painting scaled until its successor lands', async () => {
		const map = mapOf();
		const p = new Probe().addTo(map);
		await tick();
		p.land();
		const c = p.canvas();
		map.panBy([40, 0], { animate: false });
		await tick();
		expect(p.waiting).toHaveLength(1);
		map.fire('zoomstart');
		const stale = p.land();
		expect(stale.closed).toBe(true);
		expect(c.renderer?.shown).not.toBe(stale);
		map.setView(map.getCenter(), 10, { animate: false });
		await tick();
		// The painting on screen, placed for the new view: twice as large.
		expect(placement(c).scale).toBe(2);
		expect(c.style.visibility).toBe('');
		expect(p.waiting).toHaveLength(1);
		const fresh = p.land();
		expect(c.renderer?.shown).toBe(fresh);
		expect(placement(c).scale).toBe(1);
	});

	it('hides a painting scaled past four times until its successor lands', async () => {
		const map = mapOf();
		const p = new Probe().addTo(map);
		await tick();
		p.land();
		map.setView(map.getCenter(), 12, { animate: false });
		const c = p.canvas();
		expect(c.style.visibility).toBe('hidden');
		await tick();
		p.land();
		expect(c.style.visibility).toBe('');
	});

	it('waits for the settle before painting a redraw asked for mid-zoom', async () => {
		const map = mapOf();
		const p = new Probe().addTo(map);
		await tick();
		p.land();
		map.fire('zoomstart');
		p.redraw();
		await tick();
		expect(p.waiting).toHaveLength(0);
		map.fire('zoomend');
		await tick();
		expect(p.waiting).toHaveLength(1);
	});

	it('resolves whenIdle once the painting on its way has shown', async () => {
		const map = mapOf();
		const p = new Probe().addTo(map);
		let idle = false;
		void p.whenIdle().then(() => {
			idle = true;
		});
		await tick();
		await tick();
		expect(idle).toBe(false);
		p.land();
		await tick();
		expect(idle).toBe(true);
	});

	it('closes a painting that lands after the layer left the map', async () => {
		const map = mapOf();
		const p = new Probe().addTo(map);
		await tick();
		const w = p.waiting[0];
		p.remove();
		const late = new FakeBitmap(w.t.w, w.t.h);
		(p as unknown as { _scheduler: { arrived(seq: number, f: unknown): void } })._scheduler.arrived(w.seq, {
			bitmap: late,
			target: w.t,
		});
		expect(late.closed).toBe(true);
	});

	it('is not wedged by a paint that throws: the next request paints', async () => {
		const map = mapOf();
		const p = new Probe();
		p.deferred = false;
		let fail = true;
		const paint = p['_paintTarget'].bind(p);
		(p as unknown as { _paintTarget: typeof paint })._paintTarget = (ctx, canvas, t) => {
			if (fail) {
				fail = false;
				throw new Error('paint failed');
			}
			paint(ctx, canvas, t);
		};
		const errors: unknown[] = [];
		const onError = (e: unknown): void => {
			errors.push(e);
		};
		process.on('uncaughtException', onError);
		try {
			p.addTo(map);
			await tick();
			await tick();
		} finally {
			process.off('uncaughtException', onError);
		}
		expect(errors).toHaveLength(1);
		p.redraw();
		await tick();
		expect(p.painted).toBe(1);
		expect(p.canvas().renderer?.transfers).toBe(1);
	});

	it('paints on the page at once when nothing defers it', async () => {
		const map = mapOf();
		const p = new Probe();
		p.deferred = false;
		p.addTo(map);
		await tick();
		expect(p.painted).toBe(1);
		expect(p.canvas().renderer?.transfers).toBe(1);
	});
});

/** A probe painting off the main thread, as the worker-backed layer does:
 *  it paints while the map moves. Records when each painting was asked
 *  for. */
class MotionProbe extends Probe {
	readonly sent: { seq: number; t: CanvasTarget; at: number }[] = [];

	protected override paintsInMotion(): boolean {
		return true;
	}

	protected override _paint(seq: number, t: CanvasTarget): void {
		this.sent.push({ seq, t, at: performance.now() });
		super._paint(seq, t);
	}

	/** Land every painting asked for `ms` ago or more, as a worker taking
	 *  that long would. */
	landDue(ms: number): void {
		for (;;) {
			const w = this.waiting[0];
			const at = w ? this.sent.find((s) => s.seq === w.seq)?.at : undefined;
			if (at === undefined || at + ms > performance.now()) {
				return;
			}
			this.land();
		}
	}
}

/** A motion probe drawing the follow-mode margin, as the airspace layer does. */
class FollowProbe extends MotionProbe {
	protected override readonly overscanned = true;
}

/** One frame of a drag: the pane moved by (dx, dy) and a `move`, as Leaflet's
 *  drag handler does it; the view goes the same way over the map. */
function drag(map: LeafletMap, dx: number, dy: number): void {
	(map as unknown as { _rawPanBy(offset: Point): void })._rawPanBy(L.point(dx, dy));
	map.fire('move');
}

interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** What the painting on screen covers, in layer points. */
function shownRect(c: FakeCanvas): Rect {
	const at = placement(c);
	return { x: at.x, y: at.y, w: parseFloat(c.style.width ?? ''), h: parseFloat(c.style.height ?? '') };
}

/** The view, in layer points. */
function viewRect(map: LeafletMap): Rect {
	const tl = map.containerPointToLayerPoint([0, 0]);
	const size = map.getSize();
	return { x: tl.x, y: tl.y, w: size.x, h: size.y };
}

function covers(a: Rect, b: Rect): boolean {
	return a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;
}

const NONE = { left: 0, top: 0, right: 0, bottom: 0 };

describe('BitmapDrawLayer while the map moves', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** A layer on a map, its first painting landed, a while ago. */
	async function settled<P extends Probe>(probe: P): Promise<{ map: LeafletMap; p: P }> {
		const map = mapOf();
		const p = probe.addTo(map);
		await tick();
		p.land();
		vi.advanceTimersByTime(500);
		return { map, p };
	}

	/** One frame: time goes by, the paintings due land, the map moves. */
	async function frame(map: LeafletMap, p: Probe, dx: number, dy: number): Promise<void> {
		vi.advanceTimersByTime(16);
		await tick();
		if (p instanceof MotionProbe) {
			p.landDue(40);
		}
		drag(map, dx, dy);
		await tick();
	}

	for (const latency of [40, 150]) {
		it(`paints ahead of a glide, at most once per interval, the view covered all along (${latency} ms a painting)`, async () => {
			const { map, p } = await settled(new MotionProbe());
			// The paintings at rest took as long: the layer has measured it.
			for (let i = 0; i < 12; i++) {
				p.redraw();
				await tick();
				vi.advanceTimersByTime(latency);
				p.landDue(latency);
			}
			vi.advanceTimersByTime(500);
			const c = p.canvas();
			const made = p.made.length;
			const sent = p.sent.length;
			let checked = 0;
			// 1 px per ms eastward, with a keyPan glide's settle partway.
			for (let i = 0; i < 60; i++) {
				if (i === 30) {
					map.fire('moveend');
					await tick();
				}
				vi.advanceTimersByTime(16);
				await tick();
				p.landDue(latency);
				drag(map, 16, 0);
				await tick();
				if (p.made.length > made) {
					expect(covers(shownRect(c), viewRect(map)), `frame ${i}`).toBe(true);
					checked++;
				}
			}
			expect(checked).toBeGreaterThan(40);
			const motion = p.sent.slice(sent);
			expect(motion.length).toBeGreaterThanOrEqual(3);
			for (let k = 1; k < motion.length; k++) {
				expect(motion[k].at - motion[k - 1].at).toBeGreaterThanOrEqual(MOTION_INTERVAL_MS);
			}
			for (const s of motion) {
				// Whole steps of 32 px, or the cap, half the viewport.
				expect(s.t.margin.right).toBeGreaterThan(0);
				expect(s.t.margin.right % 32 === 0 || s.t.margin.right === 400, `${s.t.margin.right}`).toBe(true);
				expect([s.t.margin.left, s.t.margin.top, s.t.margin.bottom]).toEqual([0, 0, 0]);
			}
			// The glide ends: what was asked for lands, and the settle, the view
			// covered, paints nothing more.
			vi.advanceTimersByTime(200);
			await tick();
			vi.advanceTimersByTime(latency);
			p.landDue(latency);
			const asked = p.sent.length;
			map.fire('moveend');
			await tick();
			expect(p.sent).toHaveLength(asked);
			expect(covers(shownRect(c), viewRect(map))).toBe(true);
			// At rest, a painting reaches no further than the view.
			p.redraw();
			await tick();
			expect(p.sent.at(-1)?.t.margin).toEqual(NONE);
		});
	}

	it('leads on the side the view goes toward', async () => {
		const { map, p } = await settled(new MotionProbe());
		for (let i = 0; i < 12; i++) {
			await frame(map, p, -8, 8);
		}
		const motion = p.sent.slice(1);
		expect(motion.length).toBeGreaterThan(0);
		for (const s of motion) {
			expect(s.t.margin.left).toBeGreaterThan(0);
			expect(s.t.margin.bottom).toBeGreaterThan(0);
			expect([s.t.margin.right, s.t.margin.top]).toEqual([0, 0]);
		}
	});

	it("measures a drag from its start, and a new movement's lead owes nothing to the last", async () => {
		const { map, p } = await settled(new MotionProbe());
		// Leaflet's drag fires movestart as it begins: its first move asks.
		map.fire('movestart');
		await frame(map, p, 16, 0);
		expect(p.sent).toHaveLength(2);
		expect(p.sent[1].t.margin.right).toBeGreaterThan(0);
		await frame(map, p, 16, 0);
		await frame(map, p, 16, 0);
		map.fire('moveend');
		p.landDue(0);
		// Straight back the other way, the last velocity still fresh and the
		// interval passed: its first move asks, leading on the left, where a
		// velocity carried over would have averaged to nothing.
		vi.advanceTimersByTime(70);
		map.fire('movestart');
		await frame(map, p, -16, 0);
		expect(p.sent).toHaveLength(3);
		expect(p.sent[2].t.margin.left).toBeGreaterThan(0);
		expect(p.sent[2].t.margin.right).toBe(0);
	});

	it("measures speed over 8 ms at least, leaving a drag's first jump out", async () => {
		const { map, p } = await settled(new MotionProbe());
		// The drag begins with a jump a millisecond after its movestart, then
		// goes on at 1 px per ms.
		map.fire('movestart');
		vi.advanceTimersByTime(1);
		drag(map, 30, 0);
		await tick();
		expect(p.sent).toHaveLength(1);
		for (let i = 0; i < 3; i++) {
			await frame(map, p, 16, 0);
		}
		expect(p.sent.length).toBeGreaterThan(1);
		// A lead for 1 px per ms (192 at the guessed latency), not for the
		// 30 the jump would have measured, which the cap would have met.
		expect(p.sent[1].t.margin.right).toBeLessThanOrEqual(224);
		expect(p.sent[1].t.margin.right).toBeGreaterThan(0);
	});

	it('asks for nothing while a zoom holds, and paints at its settle without a lead', async () => {
		const { map, p } = await settled(new MotionProbe());
		// A pinch moves the map too, and its moves measure no velocity.
		map.fire('zoomstart');
		for (let i = 0; i < 10; i++) {
			await frame(map, p, 16, 0);
		}
		expect(p.sent).toHaveLength(1);
		map.fire('zoomend');
		await tick();
		expect(p.sent).toHaveLength(2);
		expect(p.sent[1].t.margin).toEqual(NONE);
	});

	it('measures no velocity across a zoom', async () => {
		const { map, p } = await settled(new MotionProbe());
		await frame(map, p, 16, 0);
		await frame(map, p, 16, 0);
		expect(p.sent).toHaveLength(2);
		p.land();
		// A zoom that does not animate: zoomstart to moveend in one call, the
		// pixel origin moved under the last sample.
		map.setView(map.getCenter(), 10, { animate: false });
		await tick();
		expect(p.sent).toHaveLength(3);
		expect(p.sent[2].t.margin).toEqual(NONE);
	});

	it('asks for nothing while the newest painting covers the view well ahead', async () => {
		const { map, p } = await settled(new MotionProbe());
		await frame(map, p, 16, 0);
		await frame(map, p, 16, 0);
		expect(p.sent).toHaveLength(2);
		// Nothing needed on the side the view leaves either.
		for (let i = 0; i < 3; i++) {
			await frame(map, p, 16, 0);
			expect(vi.getTimerCount()).toBe(0);
		}
		expect(p.sent).toHaveLength(2);
	});

	it("keeps the pace through a keyPan glide's settle", async () => {
		const { map, p } = await settled(new MotionProbe());
		// 4 px per ms: a request held back by the interval.
		for (let i = 0; i < 6; i++) {
			await frame(map, p, 64, 0);
		}
		expect(vi.getTimerCount()).toBe(1);
		expect(p.sent).toHaveLength(2);
		// The glide settles (a key pan's, each half viewport), the view still
		// covered: nothing to paint.
		map.fire('moveend', { keyPan: true });
		await tick();
		expect(p.sent).toHaveLength(2);
		// It goes on: its next move asks at once, the velocity known.
		await frame(map, p, 64, 0);
		expect(p.sent).toHaveLength(3);
	});

	it('follows a jittery drag at its mean speed, never shrinking its lead', async () => {
		const { map, p } = await settled(new MotionProbe());
		// 1 px per ms on average, 1.5 and 0.5 frame by frame.
		for (let i = 0; i < 30; i++) {
			await frame(map, p, i % 2 === 0 ? 24 : 8, 0);
		}
		const rights = p.sent.slice(1).map((s) => s.t.margin.right);
		expect(rights.length).toBeGreaterThanOrEqual(3);
		// Each at least the one before, the lead growing as the speed and the
		// latency are learnt, never back: no painting sizes the canvas down
		// only to size it up again. What the mean speed asks, not the fastest
		// frame.
		for (let k = 1; k < rights.length; k++) {
			expect(rights[k]).toBeGreaterThanOrEqual(rights[k - 1]);
		}
		expect(rights.at(-1)).toBeGreaterThanOrEqual(128);
		expect(rights.at(-1)).toBeLessThanOrEqual(224);
	});

	it('keeps the lead a drag reached while it slows, going the same way', async () => {
		const { map, p } = await settled(new MotionProbe());
		for (let i = 0; i < 12; i++) {
			await frame(map, p, 32, 0);
		}
		const fast = p.sent.at(-1)?.t.margin.right ?? 0;
		expect(fast).toBeGreaterThan(128);
		const n = p.sent.length;
		for (let i = 0; i < 72; i++) {
			await frame(map, p, 8, 0);
		}
		const slow = p.sent.slice(n);
		expect(slow.length).toBeGreaterThan(0);
		for (const s of slow) {
			expect(s.t.margin.right).toBe(fast);
		}
	});

	it('does not let one slow painting set the pace', async () => {
		const { map, p } = await settled(new MotionProbe());
		// A zoom's first painting, making its lines: two seconds.
		p.redraw();
		await tick();
		vi.advanceTimersByTime(2000);
		p.landDue(2000);
		vi.advanceTimersByTime(500);
		await frame(map, p, 16, 0);
		await frame(map, p, 16, 0);
		expect(p.sent).toHaveLength(3);
		expect(p.sent[2].t.margin.right).toBeLessThanOrEqual(256);
	});

	it('lets a painting sent meanwhile answer a request the interval held back', async () => {
		const { map, p } = await settled(new MotionProbe());
		for (let i = 0; i < 6; i++) {
			await frame(map, p, 64, 0);
		}
		expect(vi.getTimerCount()).toBe(1);
		expect(p.sent).toHaveLength(2);
		// A hover repaints, the painting reaching ahead of the view.
		p.redraw();
		await tick();
		expect(p.sent).toHaveLength(3);
		p.land();
		vi.advanceTimersByTime(MOTION_INTERVAL_MS);
		await tick();
		expect(p.sent).toHaveLength(3);
	});

	it('drops a request the interval held back when the layer leaves the map', async () => {
		const { map, p } = await settled(new MotionProbe());
		for (let i = 0; i < 6; i++) {
			await frame(map, p, 64, 0);
		}
		expect(vi.getTimerCount()).toBe(1);
		let idle = false;
		void p.whenIdle().then(() => {
			idle = true;
		});
		p.remove();
		for (let i = 0; i < 5; i++) {
			await tick();
		}
		expect(vi.getTimerCount()).toBe(0);
		expect(idle).toBe(true);
	});

	it('paints nothing for a re-centre inside the follow margin', async () => {
		setDrawOverscan(96);
		try {
			const { map, p } = await settled(new FollowProbe());
			expect(p.sent[0].t.margin).toEqual({ left: 96, top: 96, right: 96, bottom: 96 });
			// 30 px over a quarter of a second, as the follow mode's panTo.
			for (let i = 0; i < 15; i++) {
				await frame(map, p, 2, 0);
			}
			map.fire('moveend');
			await tick();
			expect(p.sent).toHaveLength(1);
		} finally {
			setDrawOverscan(0);
		}
	});

	it('drops a request the interval held back at a settle, which decides for itself', async () => {
		const { map, p } = await settled(new MotionProbe());
		await frame(map, p, 64, 0);
		await frame(map, p, 64, 0);
		p.land();
		for (let frames = 0; vi.getTimerCount() === 0; frames++) {
			expect(frames).toBeLessThan(5);
			await frame(map, p, 64, 0);
		}
		const asked = p.sent.length;
		map.fire('moveend');
		await tick();
		expect(vi.getTimerCount()).toBe(0);
		// The painting sent last reaches past the view: nothing to paint.
		expect(p.sent).toHaveLength(asked);
		let idle = false;
		void p.whenIdle().then(() => {
			idle = true;
		});
		await tick();
		expect(idle).toBe(true);
	});

	it('holds whenIdle until a request the interval held back has painted', async () => {
		const { map, p } = await settled(new MotionProbe());
		// 4 px per ms: the second sample measures it and asks at once, the
		// lead capped at half the viewport.
		await frame(map, p, 64, 0);
		await frame(map, p, 64, 0);
		expect(p.sent).toHaveLength(2);
		expect(p.sent[1].t.margin.right).toBe(400);
		p.land();
		// The view outruns that lead before the interval has passed: the next
		// request waits for it.
		for (let frames = 0; vi.getTimerCount() === 0; frames++) {
			expect(frames).toBeLessThan(5);
			await frame(map, p, 64, 0);
		}
		expect(p.sent).toHaveLength(2);
		let idle = false;
		void p.whenIdle().then(() => {
			idle = true;
		});
		for (let i = 0; i < 5; i++) {
			await tick();
		}
		expect(idle).toBe(false);
		vi.advanceTimersByTime(MOTION_INTERVAL_MS);
		await tick();
		expect(p.sent).toHaveLength(3);
		for (let i = 0; i < 5; i++) {
			await tick();
		}
		expect(idle).toBe(false);
		p.land();
		for (let i = 0; i < 5; i++) {
			await tick();
		}
		expect(idle).toBe(true);
	});

	it('paints at the settles only while the page paints', async () => {
		const { map, p } = await settled(new Probe());
		for (let i = 0; i < 20; i++) {
			await frame(map, p, 16, 0);
		}
		vi.advanceTimersByTime(200);
		await tick();
		expect(p.waiting).toHaveLength(0);
		map.fire('moveend');
		await tick();
		expect(p.waiting).toHaveLength(1);
		expect(p.waiting[0].t.margin).toEqual(NONE);
	});

	it('paints at the settles only on a canvas painted directly', async () => {
		const offscreen = Reflect.get(globalThis, 'OffscreenCanvas') as unknown;
		Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
		try {
			const map = mapOf();
			const p = new MotionProbe().addTo(map);
			expect(p.mode).toBe('direct');
			await tick();
			expect(p.painted).toBe(1);
			for (let i = 0; i < 20; i++) {
				await frame(map, p, 16, 0);
			}
			vi.advanceTimersByTime(200);
			await tick();
			expect(p.painted).toBe(1);
			map.fire('moveend');
			await tick();
			expect(p.painted).toBe(2);
			expect(p.sent).toHaveLength(0);
		} finally {
			Reflect.set(globalThis, 'OffscreenCanvas', offscreen);
		}
	});
});

describe('BitmapDrawLayer while the map moves fast on a dense screen', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
		env.window.devicePixelRatio = 2.75;
	});
	afterEach(() => {
		env.window.devicePixelRatio = 1;
		vi.useRealTimers();
	});

	async function settledAt<P extends Probe>(probe: P): Promise<{ map: LeafletMap; p: P }> {
		const map = mapOf();
		const p = probe.addTo(map);
		await tick();
		p.land();
		vi.advanceTimersByTime(500);
		return { map, p };
	}

	async function frame(map: LeafletMap, p: MotionProbe, dx: number): Promise<void> {
		vi.advanceTimersByTime(16);
		await tick();
		p.landDue(40);
		drag(map, dx, 0);
		await tick();
	}

	it('paints a fast movement at 2, and comes to rest on a painting at the full ratio', async () => {
		const { map, p } = await settledAt(new MotionProbe());
		expect(p.sent[0].t.dpr).toBe(2.75);
		map.fire('movestart');
		for (let i = 0; i < 12; i++) {
			await frame(map, p, 16);
		}
		const fast = p.sent.slice(1);
		expect(fast.length).toBeGreaterThan(0);
		for (const s of fast) {
			expect(s.t.dpr).toBe(2);
			expect([s.t.w, s.t.h]).toEqual([Math.ceil(s.t.cssW * 2 - 1e-6), Math.ceil(s.t.cssH * 2 - 1e-6)]);
		}
		// Slowing down, as a flick's inertia does: the painting that takes
		// over is sharp.
		const before = p.sent.length;
		for (let i = 0; i < 12; i++) {
			await frame(map, p, 4);
		}
		const slow = p.sent.slice(before);
		expect(slow.length).toBeGreaterThan(0);
		expect(slow.at(-1)?.t.dpr).toBe(2.75);
		// At rest on it: the settle paints nothing more.
		vi.advanceTimersByTime(300);
		await tick();
		p.landDue(40);
		const asked = p.sent.length;
		map.fire('moveend');
		await tick();
		expect(p.sent).toHaveLength(asked);
	});

	it('settles a fast drag that stops without inertia on a painting at rest', async () => {
		const { map, p } = await settledAt(new MotionProbe());
		map.fire('movestart');
		for (let i = 0; i < 6; i++) {
			await frame(map, p, 16);
		}
		p.landDue(0);
		expect(p.sent.at(-1)?.t.dpr).toBe(2);
		// Released at once, the velocity still fresh: no inertia, the view has
		// stopped, and what the settle paints is sharp and reaches no further.
		const asked = p.sent.length;
		map.fire('moveend');
		await tick();
		expect(p.sent).toHaveLength(asked + 1);
		expect(p.sent.at(-1)?.t.dpr).toBe(2.75);
		expect(p.sent.at(-1)?.t.margin).toEqual(NONE);
	});

	it('repaints at the full ratio once a fast drag held still has stopped', async () => {
		const { map, p } = await settledAt(new MotionProbe());
		map.fire('movestart');
		for (let i = 0; i < 6; i++) {
			await frame(map, p, 16);
		}
		expect(p.sent.at(-1)?.t.dpr).toBe(2);
		// The finger rests: no move says so.
		const asked = p.sent.length;
		vi.advanceTimersByTime(40);
		await tick();
		p.landDue(40);
		vi.advanceTimersByTime(400);
		await tick();
		expect(p.sent).toHaveLength(asked + 1);
		expect(p.sent.at(-1)?.t.dpr).toBe(2.75);
	});

	it('keeps its own ratio on a screen at 2, and while the page paints', async () => {
		env.window.devicePixelRatio = 2;
		const { map, p } = await settledAt(new MotionProbe());
		map.fire('movestart');
		for (let i = 0; i < 12; i++) {
			await frame(map, p, 16);
		}
		expect(p.sent.length).toBeGreaterThan(1);
		expect(p.sent.every((s) => s.t.dpr === 2)).toBe(true);
		env.window.devicePixelRatio = 2.75;
		const page = await settledAt(new Probe());
		page.map.fire('movestart');
		for (let i = 0; i < 12; i++) {
			vi.advanceTimersByTime(16);
			drag(page.map, 16, 0);
			await tick();
		}
		page.map.fire('moveend');
		await tick();
		expect(page.p.waiting).toHaveLength(1);
		expect(page.p.waiting[0].t.dpr).toBe(2.75);
	});
});
