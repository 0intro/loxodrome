/* Pins the shared symbol primitives of symbolBase.ts against a recording
 * 2D-context stub: the halo-under-colour stroke ordering both symbol
 * families rely on for basemap contrast, and the NOTAM cue ring geometry
 * (radius = half-extent + 5, the red #cb2026). centreDot constructs a
 * Path2D and needs a canvas runtime, so it stays untested here. */

import { describe, expect, it } from 'vitest';
import { HALO, drawCue, haloFill, haloStroke } from '$lib/map/symbolBase';

interface StrokeCall {
	strokeStyle: string;
	lineWidth: number;
}

interface ArcCall {
	x: number;
	y: number;
	r: number;
}

/** Minimal recording stand-in for CanvasRenderingContext2D: records each
 *  stroke/fill with the style state in force at the call. */
function stubCtx() {
	const strokes: StrokeCall[] = [];
	const fills: string[] = [];
	const arcs: ArcCall[] = [];
	const ctx = {
		strokeStyle: '',
		fillStyle: '',
		lineWidth: 0,
		lineJoin: '',
		beginPath: () => {},
		arc: (x: number, y: number, r: number) => {
			arcs.push({ x, y, r });
		},
		stroke: () => {
			strokes.push({ strokeStyle: String(ctx.strokeStyle), lineWidth: ctx.lineWidth });
		},
		fill: () => {
			fills.push(String(ctx.fillStyle));
		},
	};
	return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes, fills, arcs };
}

// haloStroke / haloFill only pass the path through to the context, so a
// bare object stands in for the Path2D the node runtime lacks.
const path = {} as Path2D;

describe('haloStroke', () => {
	it('strokes the halo 2 px wider underneath, then the colour on top', () => {
		const { ctx, strokes } = stubCtx();
		haloStroke(ctx, path, '#164194', 1.6);
		expect(strokes).toEqual([
			{ strokeStyle: HALO, lineWidth: 3.6 },
			{ strokeStyle: '#164194', lineWidth: 1.6 },
		]);
	});
});

describe('haloFill', () => {
	it('outlines with the thin halo, then fills with the colour', () => {
		const { ctx, strokes, fills } = stubCtx();
		haloFill(ctx, path, '#df0051');
		expect(strokes).toEqual([{ strokeStyle: HALO, lineWidth: 2 }]);
		expect(fills).toEqual(['#df0051']);
	});
});

describe('drawCue', () => {
	it('rings the symbol at half-extent + 5 in the NOTAM red', () => {
		const { ctx, strokes, arcs } = stubCtx();
		drawCue(ctx, 40, -12, 8);
		expect(arcs).toEqual([{ x: 40, y: -12, r: 13 }]);
		expect(strokes).toEqual([{ strokeStyle: '#cb2026', lineWidth: 2 }]);
	});
});
