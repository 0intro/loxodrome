/* The route's lines follow a moving view (map/svgMotion.ts), on Leaflet's own
 * SVG renderer in Node (tests/helpers/leafletNode.ts, its `svg` option): a
 * renderer's viewBox is the rectangle it draws, in layer points, and a line's
 * d what it draws there. What it pins:
 *   - a line on a following pane redraws nothing until the view has used its
 *     share of the margin, then draws around the view where it went, the line
 *     reaching the new edge, with no settle;
 *   - through long drags east, west, north and south, what is drawn holds the
 *     view and what it keeps ahead after every move, at no more than one
 *     redraw per share of the margin travelled;
 *   - nothing while every line it holds lies inside what it drew, which shows
 *     them whole wherever the view goes, until one reaches past;
 *   - the glide after a flick is followed frame by frame before its settle;
 *   - a pane outside the family keeps Leaflet's way: nothing while the map
 *     moves, all at the settle;
 *   - nothing at a frame of a pinch or a flight, even one back at the view it
 *     drew with a line set meanwhile, nor at a move whose pixel origin or zoom
 *     has changed;
 *   - a renderer follows with no line, so a line given it mid-drag draws
 *     around the view at once;
 *   - its move handler goes with it;
 *   - one install, made by padSvgRenderers for the renderers made after it on
 *     the panes it names, each drawing a whole screen beyond each side where
 *     the others draw half, and each still a pane a map module draws a line
 *     on. */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LatLng, LatLngExpression, Map as LeafletMap, Point, Polyline, Renderer } from 'leaflet';
import { FakeElement, installLeafletNode } from './helpers/leafletNode';

const env = installLeafletNode({ any3d: true, svg: true });
const L = (await import('leaflet')).default;
// Made before the install, as svgPadding.spec's is: Leaflet's own.
const early = new L.SVG({ pane: 'route' });
const { padSvgRenderers } = await import('$lib/map/svgPadding');
const { FOLLOWING_PANES, FOLLOW_PADDING, REDRAW_SHARE, followMovingView } = await import('$lib/map/svgMotion');
// What each map view does before it makes its map.
padSvgRenderers();

const W = 800;
const H = 600;
/** One drag frame's travel, CSS px. */
const STEP = 24;

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

interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

interface Axes {
	x: number;
	y: number;
}

let map: LeafletMap | null = null;

afterEach(() => {
	map?.remove();
	map = null;
});

/** A cross: a line along the view's middle row and one down its middle
 *  column, each reaching ten views beyond it both ways. */
function cross(m: LeafletMap): LatLngExpression[][] {
	const at = (x: number, y: number): LatLng => m.containerPointToLatLng([x, y]);
	return [
		[at(-10 * W, H / 2), at(11 * W, H / 2)],
		[at(W / 2, -10 * H), at(W / 2, 11 * H)],
	];
}

/** An 800 x 600 map at Paris z9, a cross drawn on `pane`, its renderer, and a
 *  count of that renderer's redraws from now on. */
function mount(pane: string): { m: LeafletMap; line: Polyline; renderer: Renderer; redraws: () => number } {
	const m = L.map(env.container(W, H) as unknown as HTMLElement, MAP_OPTIONS).setView([48.8, 2.3], 9);
	map = m;
	m.createPane(pane);
	const line = L.polyline(cross(m), { pane }).addTo(m);
	const renderer = m.getRenderer(line);
	let n = 0;
	renderer.on('update', () => {
		n++;
	});
	return { m, line, renderer, redraws: () => n };
}

/** The pane moved by (dx, dy), and no event. */
function panOnly(m: LeafletMap, dx: number, dy: number): void {
	(m as unknown as { _rawPanBy(offset: Point): void })._rawPanBy(L.point(dx, dy));
}

/** One frame of a drag: the pane moved and a `move`, as Leaflet's drag
 *  handler makes it; the view goes the same way over the map. */
function drag(m: LeafletMap, dx: number, dy: number): void {
	panOnly(m, dx, dy);
	m.fire('move');
}

/** Leaflet's own step of a view (Map._move): a pinch's frame, a flight's, a
 *  view reset's. */
function step(m: LeafletMap, center: LatLng, zoom: number, data?: object): void {
	(m as unknown as { _move(c: LatLng, z: number, d?: object): void })._move(center, zoom, data);
}

/** What a renderer draws, in layer points: its SVG's viewBox. */
function drawn(renderer: Renderer): Rect {
	const svg = (renderer as unknown as { _container: FakeElement })._container;
	const [x, y, w, h] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
	return { x, y, w, h };
}

/** A renderer's margin on each axis: its padding times the view. */
function margin(renderer: Renderer): Axes {
	const p = renderer.options.padding ?? 0;
	return { x: W * p, y: H * p };
}

/** How far east the view must go, from where a renderer last drew, for it to
 *  redraw: a step past its share of the margin. */
function pastShare(renderer: Renderer): number {
	return Math.ceil(margin(renderer).x * REDRAW_SHARE) + STEP;
}

/** What a following renderer keeps ahead of the view on each axis. */
function kept(renderer: Renderer): Axes {
	const mg = margin(renderer);
	return { x: mg.x * (1 - REDRAW_SHARE), y: mg.y * (1 - REDRAW_SHARE) };
}

function viewRect(m: LeafletMap): Rect {
	const tl = m.containerPointToLayerPoint([0, 0]);
	const size = m.getSize();
	return { x: tl.x, y: tl.y, w: size.x, h: size.y };
}

function grown(r: Rect, by: Axes): Rect {
	return { x: r.x - by.x, y: r.y - by.y, w: r.w + 2 * by.x, h: r.h + 2 * by.y };
}

function covers(a: Rect, b: Rect): boolean {
	return a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;
}

/** How far east a line's path reaches, from its d. */
function eastmost(line: Polyline): number {
	const d = (line.getElement() as unknown as FakeElement).getAttribute('d') ?? '';
	const xs = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number).filter((_, i) => i % 2 === 0);
	return Math.max(...xs);
}

describe('an SVG renderer of the route family while the map moves', () => {
	it('redraws nothing until the view has used its share of the margin, then draws around the view where it went', () => {
		const { m, line, renderer, redraws } = mount('route');
		const first = drawn(renderer);
		const due = margin(renderer).x * REDRAW_SHARE;
		const short = Math.floor(due / STEP);
		for (let i = 0; i < short; i++) {
			drag(m, STEP, 0);
		}
		expect(redraws()).toBe(0);
		expect(drawn(renderer)).toEqual(first);
		expect(eastmost(line)).toBe(first.x + first.w);
		drag(m, STEP, 0);
		expect(redraws()).toBe(1);
		const view = viewRect(m);
		expect(drawn(renderer)).toEqual(grown(view, margin(renderer)));
		expect(eastmost(line)).toBe(view.x + W + margin(renderer).x);
	});

	it('holds the view and what it keeps ahead after every move of a long drag, whichever way it goes', () => {
		for (const [dx, dy] of [
			[STEP, 0],
			[-STEP, 0],
			[0, STEP],
			[0, -STEP],
		]) {
			const { m, renderer, redraws } = mount('nav-trace');
			for (let i = 0; i < 100; i++) {
				drag(m, dx, dy);
				expect(covers(drawn(renderer), grown(viewRect(m), kept(renderer))), `${dx},${dy} frame ${i}`).toBe(true);
			}
			const axis = dx !== 0 ? margin(renderer).x : margin(renderer).y;
			expect(redraws()).toBeGreaterThan(0);
			expect(redraws()).toBeLessThanOrEqual(Math.ceil((100 * STEP) / (axis * REDRAW_SHARE)));
			m.remove();
			map = null;
		}
	});

	it('follows the glide after a flick, frame by frame, before its settle', () => {
		// PosAnimation times the glide with Date.
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const { m, renderer, redraws } = mount('route-casing');
			let settled = false;
			let before = -1;
			m.once('moveend', () => {
				settled = true;
				before = redraws();
			});
			// What Map.Drag's inertia runs after a flick east.
			m.panBy([1500, 0], { animate: true, duration: 1.5, easeLinearity: 0.2, noMoveStart: true });
			for (let i = 0; i < 200 && !settled; i++) {
				vi.advanceTimersByTime(16);
				env.runFrame();
				expect(covers(drawn(renderer), viewRect(m)), `frame ${i}`).toBe(true);
			}
			expect(settled).toBe(true);
			expect(before).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('redraws nothing while every line it holds lies inside what it drew, wherever the view goes', () => {
		const { m, line, renderer, redraws } = mount('nav-trace');
		// A line inside the view and the margin: drawn whole, it shows the
		// same however far the view goes.
		const at = (x: number, y: number): LatLng => m.containerPointToLatLng([x, y]);
		line.setLatLngs([at(-100, H / 2), at(W + 100, H / 2)]);
		const first = drawn(renderer);
		for (let i = 0; i < 100; i++) {
			drag(m, STEP, 0);
		}
		expect(redraws()).toBe(0);
		expect(drawn(renderer)).toEqual(first);
		// Given a reach past the box, it follows again at the next move.
		line.setLatLngs([at(-100, H / 2), at(10 * W, H / 2)]);
		drag(m, STEP, 0);
		expect(redraws()).toBe(1);
		expect(covers(drawn(renderer), grown(viewRect(m), kept(renderer)))).toBe(true);
	});

	it('leaves a pane outside the family to Leaflet: nothing while the map moves, all at the settle', () => {
		const { m, renderer, redraws } = mount('notams');
		const first = drawn(renderer);
		for (let i = 0; i < 50; i++) {
			drag(m, STEP, 0);
		}
		expect(redraws()).toBe(0);
		expect(drawn(renderer)).toEqual(first);
		expect(covers(drawn(renderer), viewRect(m))).toBe(false);
		m.fire('moveend');
		expect(redraws()).toBe(1);
		expect(covers(drawn(renderer), viewRect(m))).toBe(true);
	});

	it('draws nothing at a frame of a pinch or a flight, even one back at the view it drew with a line set meanwhile', () => {
		for (const flags of [{ pinch: true, round: false }, { flyTo: true }]) {
			const { m, line, renderer, redraws } = mount('nav-trace');
			const origin = m.getPixelOrigin();
			const first = drawn(renderer);
			// Past what the margin keeps, with no move to say so.
			panOnly(m, pastShare(renderer), 0);
			const center = m.getCenter();
			step(m, center, 9.3, flags);
			// A trace fix mid-gesture: the line projected for z9.3.
			line.setLatLngs(line.getLatLngs());
			step(m, center, 9, flags);
			// Back at the drawn zoom and pixel origin: only the flag tells
			// this frame from a pan's.
			expect(m.getZoom()).toBe(9);
			expect(m.getPixelOrigin().equals(origin)).toBe(true);
			expect(redraws(), JSON.stringify(flags)).toBe(0);
			expect(drawn(renderer)).toEqual(first);
			m.remove();
			map = null;
		}
	});

	it('draws nothing at a move whose pixel origin or zoom has changed, and Leaflet redraws at the settle', () => {
		const { m, renderer, redraws } = mount('route');
		panOnly(m, pastShare(renderer), 0);
		step(m, m.containerPointToLatLng([W / 2 + 600, H / 2]), 9);
		expect(redraws()).toBe(0);
		m.fire('moveend');
		expect(redraws()).toBe(1);
		// A zoom a hair off keeps the rounded pixel origin: only the zoom
		// tells the lines were projected for another view.
		const origin = m.getPixelOrigin();
		panOnly(m, pastShare(renderer), 0);
		step(m, m.getCenter(), 9 + 1e-7);
		expect(m.getPixelOrigin().equals(origin)).toBe(true);
		expect(redraws()).toBe(1);
	});

	it('follows with no line, so a line given it mid-drag draws around the view at once', () => {
		const { m, line, renderer } = mount('route-leg');
		line.remove();
		// Past the share of the margin: an empty renderer follows too.
		for (let i = 0; i < pastShare(renderer) / STEP + 2; i++) {
			drag(m, STEP, 0);
		}
		const leg = L.polyline(cross(m), { pane: 'route-leg' }).addTo(m);
		const box = drawn(renderer);
		expect(covers(box, grown(viewRect(m), kept(renderer)))).toBe(true);
		expect(eastmost(leg)).toBe(box.x + box.w);
	});

	it('takes its move handler away with the renderer', () => {
		const { m, line, renderer } = mount('route');
		expect(m.listens('move')).toBe(true);
		line.remove();
		m.removeLayer(renderer);
		expect(m.listens('move')).toBe(false);
	});

	it('is installed once, by padSvgRenderers, for the renderers made after it on the panes it names', () => {
		const hooks = (): number => (L.SVG.prototype as unknown as { _initHooks: unknown[] })._initHooks.length;
		const n = hooks();
		padSvgRenderers();
		followMovingView();
		expect(hooks()).toBe(n);
		expect(early.getEvents?.().move).toBeUndefined();
		for (const pane of FOLLOWING_PANES) {
			const r = new L.SVG({ pane });
			expect(typeof r.getEvents?.().move, pane).toBe('function');
			expect(r.options.padding, pane).toBe(FOLLOW_PADDING);
		}
		expect(FOLLOW_PADDING).toBe(1);
		const notams = new L.SVG({ pane: 'notams' });
		expect(notams.getEvents?.().move).toBeUndefined();
		expect(notams.options.padding).toBe(0.5);
		expect(new L.SVG().getEvents?.().move).toBeUndefined();
		expect(early.options.padding).toBe(0.5);
	});

	it('names only panes a map module still draws a line on', () => {
		const dir = 'src/lib/map';
		const sources = readdirSync(dir)
			.filter((f) => f.endsWith('.ts') && f !== 'svgMotion.ts')
			.map((f) => readFileSync(join(dir, f), 'utf8'));
		for (const pane of FOLLOWING_PANES) {
			const spelled = new RegExp(`(pane: |PANE = )'${pane}'`);
			expect(
				sources.some((s) => spelled.test(s)),
				pane,
			).toBe(true);
		}
	});
});
