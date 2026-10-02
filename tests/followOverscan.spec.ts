/* Follow mode's two savings (map/navLayer.ts, map/directDrawLayer.ts): the
 * deadband a following map re-centres by, and the overscan margin a canvas
 * layer draws while following so a re-centre inside it repaints nothing.
 * Every moveend used to repaint every canvas, and the 1 px rule re-centred on
 * every fix at speed (docs/performance-2026-09.md). The pure halves are
 * pinned here; the layer wiring is driven through the production harness. */

import { describe, expect, it, vi } from 'vitest';

vi.mock('leaflet', () => {
	class Layer {}
	return { default: { Layer, DomUtil: { create: () => ({}) } } };
});

import { FOLLOW_DEADBAND_PX, followNeedsPan } from '$lib/map/navLayer';
import { coversView, keptLead, leadMargins, overscanFor } from '$lib/map/canvasPlacement';

describe('followNeedsPan', () => {
	it('re-centres past the deadband on either axis, and not inside it', () => {
		expect(followNeedsPan({ x: 0, y: 0 }, FOLLOW_DEADBAND_PX)).toBe(false);
		expect(followNeedsPan({ x: FOLLOW_DEADBAND_PX - 0.5, y: -(FOLLOW_DEADBAND_PX - 0.5) }, FOLLOW_DEADBAND_PX)).toBe(false);
		expect(followNeedsPan({ x: FOLLOW_DEADBAND_PX, y: 0 }, FOLLOW_DEADBAND_PX)).toBe(true);
		expect(followNeedsPan({ x: 0, y: -FOLLOW_DEADBAND_PX - 3 }, FOLLOW_DEADBAND_PX)).toBe(true);
	});

	it('is the exact-centre rule at a deadband of 1 (arming, re-arming)', () => {
		expect(followNeedsPan({ x: 0.9, y: -0.9 }, 1)).toBe(false);
		expect(followNeedsPan({ x: 1, y: 0 }, 1)).toBe(true);
	});

	it('keeps the aircraft well inside the view, a fraction of a phone width', () => {
		expect(FOLLOW_DEADBAND_PX).toBeGreaterThanOrEqual(4);
		expect(FOLLOW_DEADBAND_PX).toBeLessThanOrEqual(392 * 0.05);
	});
});

describe('the overscan margin', () => {
	it('caps the margin at a quarter of the viewport', () => {
		const even = (x: number, y: number) => ({ left: x, top: y, right: x, bottom: y });
		expect(overscanFor(96, { x: 1038, y: 898 })).toEqual(even(96, 96));
		expect(overscanFor(96, { x: 392, y: 791 })).toEqual(even(96, 96));
		expect(overscanFor(96, { x: 300, y: 200 })).toEqual(even(75, 50));
		expect(overscanFor(0, { x: 800, y: 600 })).toEqual(even(0, 0));
	});

	it('skips the repaint exactly while the view stays inside what was drawn', () => {
		const drawn = { x: -96, y: -96, w: 800 + 192, h: 600 + 192 };
		expect(coversView(drawn, { x: 0, y: 0, w: 800, h: 600 })).toBe(true);
		expect(coversView(drawn, { x: 96, y: -96, w: 800, h: 600 })).toBe(true);
		expect(coversView(drawn, { x: 97, y: 0, w: 800, h: 600 })).toBe(false);
		expect(coversView(drawn, { x: 0, y: -97, w: 800, h: 600 })).toBe(false);
	});
});

describe('the lead margins', () => {
	const SIZE = { x: 1400, y: 900 };
	it('lead on the sides the view moves toward, by speed times the lead, in whole steps', () => {
		// East at 1000 px/s over 150 ms: 150 px, 160 in steps of 32.
		expect(leadMargins({ x: 1, y: 0 }, 150, SIZE, 0.5, 32)).toEqual({ left: 0, top: 0, right: 160, bottom: 0 });
		// North-west.
		expect(leadMargins({ x: -0.5, y: -0.25 }, 150, SIZE, 0.5, 32)).toEqual({ left: 96, top: 64, right: 0, bottom: 0 });
		// A steady glide asks for the same margin from one painting to the next.
		expect(leadMargins({ x: 1.02, y: 0 }, 150, SIZE, 0.5, 32)).toEqual(leadMargins({ x: 0.98, y: 0 }, 150, SIZE, 0.5, 32));
	});

	it('never lead past the cap, nor below the least speed', () => {
		expect(leadMargins({ x: 20, y: -20 }, 150, SIZE, 0.5, 32)).toEqual({ left: 0, top: 450, right: 700, bottom: 0 });
		expect(leadMargins({ x: 0.04, y: 0 }, 150, SIZE, 0.5, 32, 0.05)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
		expect(leadMargins({ x: 0, y: 0 }, 150, SIZE, 0.5, 32)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
	});
});

describe('the lead a movement keeps', () => {
	const SIZE = { x: 1400, y: 900 };
	const lead = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

	it('is what the speed asks at the start of a movement', () => {
		expect(keptLead(null, lead(0, 0, 160, 0), SIZE, 0.5)).toEqual(lead(0, 0, 160, 0));
	});

	it('grows with the speed, and holds while it drops, the view still going that way', () => {
		expect(keptLead(lead(0, 0, 96, 0), lead(0, 0, 160, 0), SIZE, 0.5)).toEqual(lead(0, 0, 160, 0));
		expect(keptLead(lead(0, 0, 160, 0), lead(0, 0, 96, 0), SIZE, 0.5)).toEqual(lead(0, 0, 160, 0));
		// A diagonal keeps each side it still goes toward.
		expect(keptLead(lead(0, 64, 160, 0), lead(0, 32, 96, 0), SIZE, 0.5)).toEqual(lead(0, 64, 160, 0));
	});

	it('drops a side the view no longer goes toward, so a reversal keeps one lead', () => {
		expect(keptLead(lead(0, 0, 160, 0), lead(96, 0, 0, 0), SIZE, 0.5)).toEqual(lead(96, 0, 0, 0));
		// Stopped: nothing ahead.
		expect(keptLead(lead(0, 64, 160, 0), lead(0, 0, 0, 0), SIZE, 0.5)).toEqual(lead(0, 0, 0, 0));
	});

	it('stays within the cap of a viewport grown smaller since', () => {
		expect(keptLead(lead(0, 0, 700, 450), lead(0, 0, 32, 32), { x: 800, y: 600 }, 0.5)).toEqual(lead(0, 0, 400, 300));
	});
});
