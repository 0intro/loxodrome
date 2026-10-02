/* The sprites the point symbols are stamped from (map/symbolSprites.ts), on a
 * stood-in OffscreenCanvas. What it pins:
 *   - a look is painted once per key and pixel ratio, its anchor on a device
 *     pixel's corner, the sprite sized to the reach with a pixel of fringe;
 *   - a stamp lands the sprite on whole device pixels, its anchor on the
 *     corner nearest the position, at CSS size = device size / ratio, under a
 *     paint's transform with a margin (the lead a moving view paints);
 *   - past the cap the oldest look is dropped and painted again if asked;
 *   - with no OffscreenCanvas it answers false and draws nothing. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Paint2D } from '$lib/map/symbolBase';
import type { DeviceFrame } from '$lib/map/symbolSprites';

interface Drawn {
	image: { id: number; width: number; height: number };
	x: number;
	y: number;
	w: number;
	h: number;
}

/** The surface a sprite is painted on: its size, the transform it was left
 *  at, and bitmaps numbered as made. */
class Surface {
	static made: Surface[] = [];
	static bitmaps = 0;
	width: number;
	height: number;
	transform: number[] = [];
	options: unknown = null;
	constructor(w: number, h: number) {
		this.width = w;
		this.height = h;
		Surface.made.push(this);
	}
	getContext(_kind: string, options?: unknown): unknown {
		this.options = options;
		return {
			setTransform: (...t: number[]) => {
				this.transform = t;
			},
		};
	}
	transferToImageBitmap(): { id: number; width: number; height: number } {
		return { id: ++Surface.bitmaps, width: this.width, height: this.height };
	}
}

/** A page context that records its drawImage calls. */
function page(): { ctx: Paint2D; drawn: Drawn[] } {
	const drawn: Drawn[] = [];
	const ctx = {
		drawImage: (image: Drawn['image'], x: number, y: number, w: number, h: number) => {
			drawn.push({ image, x, y, w, h });
		},
	};
	return { ctx: ctx as unknown as Paint2D, drawn };
}

const REACH = { left: 12.8, top: 12.8, right: 12.8, bottom: 12.8 };

beforeEach(() => {
	vi.resetModules();
	Surface.made = [];
	vi.stubGlobal('OffscreenCanvas', Surface);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

async function sprites(max?: number): Promise<import('$lib/map/symbolSprites').SymbolSprites> {
	const { SymbolSprites } = await import('$lib/map/symbolSprites');
	return new SymbolSprites(max);
}

describe('SymbolSprites', () => {
	it('paints a look once per key and ratio, on a surface kept off the GPU', async () => {
		const s = await sprites();
		const { ctx, drawn } = page();
		let painted = 0;
		const paint = (): void => {
			painted++;
		};
		const dev1: DeviceFrame = { ratio: 1, x: 0, y: 0 };
		const dev2: DeviceFrame = { ratio: 2.75, x: 0, y: 0 };
		expect(s.stamp(ctx, 'a', REACH, paint, 10, 10, dev1)).toBe(true);
		expect(s.stamp(ctx, 'a', REACH, paint, 50, 60, dev1)).toBe(true);
		expect(painted).toBe(1);
		expect(s.stamp(ctx, 'a', REACH, paint, 50, 60, dev2)).toBe(true);
		expect(s.stamp(ctx, 'b', REACH, paint, 50, 60, dev2)).toBe(true);
		expect(painted).toBe(3);
		expect(drawn).toHaveLength(4);
		expect(Surface.made[0].options).toEqual({ willReadFrequently: true });
	});

	it('sizes a sprite to its reach, its anchor on a device pixel corner', async () => {
		const s = await sprites();
		const { ctx } = page();
		const reach = { left: 3, top: 9.2, right: 4.4, bottom: 5 };
		s.stamp(ctx, 'a', reach, () => {}, 0, 0, { ratio: 2.75, x: 0, y: 0 });
		const surface = Surface.made[0];
		// ceil(3 x 2.75) + 1 = 10 and ceil(9.2 x 2.75) + 1 = 27 to the anchor,
		// then ceil(4.4 x 2.75) + 1 = 14 and ceil(5 x 2.75) + 1 = 15 past it.
		expect([surface.width, surface.height]).toEqual([24, 42]);
		expect(surface.transform).toEqual([2.75, 0, 0, 2.75, 10, 27]);
	});

	for (const ratio of [1, 1.25, 2.75]) {
		it(`lands on whole device pixels at ${ratio}, under a margin's translate`, async () => {
			const s = await sprites();
			const { ctx, drawn } = page();
			// A lead of 197 CSS px on the left and 64 on top.
			const dev: DeviceFrame = { ratio, x: 197 * ratio, y: 64 * ratio };
			const at: [number, number][] = [
				[0, 0],
				[10.3, 20.7],
				[-5.5, 399.49],
				[123.456, -7.25],
			];
			for (const [x, y] of at) {
				s.stamp(ctx, 'a', REACH, () => {}, x, y, dev);
			}
			const surface = Surface.made[0];
			const ax = surface.transform[4];
			const ay = surface.transform[5];
			at.forEach(([x, y], i) => {
				const d = drawn[i];
				// Where its corner falls on the canvas, device px: whole.
				const px = ratio * d.x + dev.x;
				const py = ratio * d.y + dev.y;
				expect(Math.abs(px - Math.round(px)), `x ${x}`).toBeLessThan(1e-9);
				expect(Math.abs(py - Math.round(py)), `y ${y}`).toBeLessThan(1e-9);
				// Its anchor on the corner nearest the position.
				expect(Math.round(px) + ax).toBe(Math.round(ratio * x + dev.x));
				expect(Math.round(py) + ay).toBe(Math.round(ratio * y + dev.y));
				// Texel on device pixel.
				expect(d.w * ratio).toBeCloseTo(surface.width, 9);
				expect(d.h * ratio).toBeCloseTo(surface.height, 9);
			});
		});
	}

	it('drops the oldest look past its cap, and paints it again when asked', async () => {
		const s = await sprites(2);
		const { ctx } = page();
		const painted: string[] = [];
		const dev: DeviceFrame = { ratio: 1, x: 0, y: 0 };
		for (const key of ['a', 'b', 'c', 'b', 'a']) {
			s.stamp(ctx, key, REACH, () => painted.push(key), 0, 0, dev);
		}
		// c took a's place, a then took b's.
		expect(painted).toEqual(['a', 'b', 'c', 'a']);
	});

	it('answers false, drawing nothing, with no OffscreenCanvas to paint on', async () => {
		vi.stubGlobal('OffscreenCanvas', undefined);
		const s = await sprites();
		const { ctx, drawn } = page();
		let painted = 0;
		expect(s.stamp(ctx, 'a', REACH, () => painted++, 0, 0, { ratio: 1, x: 0, y: 0 })).toBe(false);
		expect(painted).toBe(0);
		expect(drawn).toHaveLength(0);
	});
});
