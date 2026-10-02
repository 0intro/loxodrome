/* A recording 2d surface for the paint specs (decoPaint, decoWorkerCore):
 * a Path2D that keeps what is built, formatted by content so two identical
 * paintings log identically, and a context that records every call and every
 * property it is given. Node has neither. */

import type { Paint2D } from '$lib/map/symbolBase';

/** Path2D, recording what is built. */
export class FakePath {
	readonly ops: string[] = [];
	/** The SVG path data it was built from, if any. */
	readonly d: string | undefined;
	constructor(d?: string) {
		this.d = d;
		if (d) {
			this.ops.push(`d:${d.length}`);
		}
	}
	moveTo(x: number, y: number): void {
		this.ops.push(`M${x},${y}`);
	}
	lineTo(x: number, y: number): void {
		this.ops.push(`L${x},${y}`);
	}
	closePath(): void {
		this.ops.push('Z');
	}
	arc(...a: number[]): void {
		this.ops.push(`A${a.join(',')}`);
	}
	rect(...a: number[]): void {
		this.ops.push(`R${a.join(',')}`);
	}
	arcTo(...a: number[]): void {
		this.ops.push(`T${a.join(',')}`);
	}
}

export function fmt(v: unknown): string {
	if (v instanceof FakePath) {
		return `path(${v.ops.join(' ')})`;
	}
	if (typeof v === 'number') {
		return String(Math.round(v * 1e6) / 1e6);
	}
	if (typeof v === 'string') {
		return JSON.stringify(v);
	}
	if (Array.isArray(v)) {
		return `[${v.map(fmt).join(',')}]`;
	}
	if (v && typeof v === 'object') {
		return 'scratch' in v ? 'scratch' : 'obj';
	}
	return String(v);
}

/** A 2d context that records every call and every property it is given.
 *  `measureText` answers 6 px a character, `createPattern` an opaque token,
 *  and `getImageData` ink wherever text was filled. */
export function recorder(): { ctx: Paint2D; ops: string[] } {
	const ops: string[] = [];
	const props = new Map<string, unknown>();
	let inked = false;
	const ctx = new Proxy(
		{},
		{
			get(_t, prop: string) {
				if (props.has(prop)) {
					return props.get(prop);
				}
				if (prop === 'measureText') {
					return (t: string) => ({ width: t.length * 6 });
				}
				if (prop === 'createPattern') {
					return () => {
						ops.push('createPattern');
						return { pattern: true };
					};
				}
				if (prop === 'getImageData') {
					return (_x: number, _y: number, w: number, h: number) => {
						const data = new Uint8ClampedArray(w * h * 4);
						if (inked) {
							data[3] = 255;
						}
						return { data, width: w, height: h };
					};
				}
				return (...args: unknown[]) => {
					if (prop === 'fillText') {
						inked = true;
					}
					ops.push(`${prop}(${args.map(fmt).join(',')})`);
				};
			},
			set(_t, prop: string, value: unknown) {
				props.set(prop, value);
				ops.push(`${prop}=${fmt(value)}`);
				return true;
			},
		},
	);
	return { ctx: ctx as unknown as Paint2D, ops };
}

/** How far what a painter draws reaches from its anchor on each side, CSS
 *  px, for a sprite's reach (map/symbolSprites.ts): every vertex of every
 *  path through the transform (translate and scale, as the glyphs are drawn;
 *  a rotation is refused), a circle's centre plus its radius, a rectangle's
 *  corners, plus half the line a stroke draws it with, round every vertex
 *  and across every end alike. */
export function extentOf(draw: (ctx: Paint2D) => void): { left: number; top: number; right: number; bottom: number } {
	let t = { x: 0, y: 0, k: 1 };
	const stack: (typeof t)[] = [];
	let lineWidth = 1;
	const e = { left: 0, top: 0, right: 0, bottom: 0 };
	const reach = (x: number, y: number, pad: number) => {
		e.left = Math.max(e.left, -(x - pad));
		e.right = Math.max(e.right, x + pad);
		e.top = Math.max(e.top, -(y - pad));
		e.bottom = Math.max(e.bottom, y + pad);
	};
	const points = (p: FakePath): [number, number][] => {
		const out: [number, number][] = [];
		if (p.d) {
			const nums = (p.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
			for (let i = 0; i + 1 < nums.length; i += 2) {
				out.push([nums[i], nums[i + 1]]);
			}
		}
		for (const op of p.ops) {
			const n = op.slice(1).split(',').map(Number);
			switch (op[0]) {
				case 'M':
				case 'L':
					out.push([n[0], n[1]]);
					break;
				case 'A':
					out.push([n[0] - n[2], n[1] - n[2]], [n[0] + n[2], n[1] + n[2]]);
					break;
				case 'R':
					out.push([n[0], n[1]], [n[0] + n[2], n[1] + n[3]]);
					break;
				case 'T':
					out.push([n[0], n[1]], [n[2], n[3]]);
					break;
				default:
					break;
			}
		}
		return out;
	};
	const paint = (p: FakePath, pad: number) => {
		for (const [x, y] of points(p)) {
			reach(t.x + t.k * x, t.y + t.k * y, pad);
		}
	};
	const ctx = new Proxy(
		{},
		{
			get(_t, prop) {
				switch (prop) {
					case 'save':
						return () => stack.push({ ...t });
					case 'restore':
						return () => {
							t = stack.pop() ?? t;
						};
					case 'translate':
						return (x: number, y: number) => {
							t = { x: t.x + t.k * x, y: t.y + t.k * y, k: t.k };
						};
					case 'scale':
						return (k: number) => {
							t = { ...t, k: t.k * k };
						};
					case 'rotate':
						return () => {
							throw new Error('extentOf reads no rotation');
						};
					case 'fill':
						return (p: FakePath) => paint(p, 0);
					case 'stroke':
						// Half the line, round the vertex or across a butt end.
						return (p: FakePath) => paint(p, (lineWidth * t.k) / 2);
					default:
						return () => {};
				}
			},
			set(_t, prop, v) {
				if (prop === 'lineWidth') {
					lineWidth = v as number;
				}
				return true;
			},
		},
	);
	draw(ctx as unknown as Paint2D);
	return e;
}
