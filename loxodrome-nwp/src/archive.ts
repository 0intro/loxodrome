/* What a block archive holds (internal/nwp's Descriptor) and how a tile turns
 * into values: the payload layout of internal/nwp/tile.go, the nearest grid
 * point in microdegrees (GridDesc.Nearest, rounding half up so both readers
 * pick the same point), the coarse levels aligned to the map lattice. */

import { inflateRaw } from './pmtiles.ts';

export const MISSING = -32768;
export const SEGMENTS = ['static', 'sfc', 'ps', 'uvt', 'z', 'cloud'] as const;
export type SegmentName = (typeof SEGMENTS)[number];

export interface GridDesc {
	ni: number;
	nj: number;
	northE6: number;
	westE6: number;
	diE6: number;
	djE6: number;
	wraps: boolean;
}

export interface Level {
	z: number;
	factor: number;
	i0: number;
	j0: number;
	ni: number;
	nj: number;
	tx: number;
	ty: number;
}

export interface Var {
	name: string;
	level?: number;
	scale: number;
	offset?: number;
}

export interface SegmentDesc {
	name: SegmentName;
	steps: number[];
	vars: Var[];
}

export interface Descriptor {
	format: string;
	version: number;
	model: string;
	run: string;
	first: number;
	last: number;
	grid: GridDesc;
	tile: number;
	missing: number;
	levels: Level[];
	segments: SegmentDesc[];
	gustPeriod: number[];
}

export function checkDescriptor(d: unknown): Descriptor {
	const x = d as Descriptor;
	if (!x || x.format !== 'loxodrome-nwp' || x.version !== 1 || x.missing !== MISSING) {
		throw new Error('nwp: not a version 1 block archive');
	}
	if (x.segments.length !== SEGMENTS.length || x.segments.some((s, i) => s.name !== SEGMENTS[i])) {
		throw new Error('nwp: unexpected segment layout');
	}
	return x;
}

export function varKey(v: Var): string {
	return v.level ? `${v.name}@${v.level}` : v.name;
}

function floorDiv(a: number, b: number): number {
	return Math.floor(a / b);
}

/** The native point nearest (lat, lon), or null outside the grid. */
export function nearest(g: GridDesc, lat: number, lon: number): { i: number; j: number } | null {
	const latE6 = Math.round(lat * 1e6);
	const lonE6 = Math.round(lon * 1e6);
	const j = floorDiv(g.northE6 - latE6 + g.djE6 / 2, g.djE6);
	let x = lonE6 - g.westE6;
	if (g.wraps) {
		x = ((x % 360e6) + 360e6) % 360e6;
	} else if (x < -g.diE6 / 2) {
		x += 360e6;
	}
	let i = floorDiv(x + g.diE6 / 2, g.diE6);
	if (g.wraps) {
		i %= g.ni;
	}
	if (i < 0 || j < 0 || i >= g.ni || j >= g.nj) {
		return null;
	}
	return { i, j };
}

/** The point's coordinates in degrees. */
export function pointLatLon(g: GridDesc, i: number, j: number): { lat: number; lon: number } {
	let lon = g.westE6 + i * g.diE6;
	if (lon >= 180e6) {
		lon -= 360e6;
	}
	return { lat: (g.northE6 - j * g.djE6) / 1e6, lon: lon / 1e6 };
}

/** The coarsest pyramid level holding EVERY given native point exactly,
 *  the native level when none does. A map lattice's points all sit on a
 *  coarse level (its steps are the lattice's), so a whole lattice reads a
 *  handful of tiles; a route's points read the native level. */
export function chooseLevel(levels: Level[], points: readonly { i: number; j: number }[]): Level {
	for (let k = levels.length - 1; k > 0; k--) {
		const l = levels[k];
		const holds = points.every(({ i, j }) => {
			const di = i - l.i0;
			const dj = j - l.j0;
			return di >= 0 && dj >= 0 && di % l.factor === 0 && dj % l.factor === 0 && di / l.factor < l.ni && dj / l.factor < l.nj;
		});
		if (holds && points.length > 0) {
			return l;
		}
	}
	return levels[0];
}

/** Where native point (i, j) lies on a level: its tile and its index in
 *  the tile's row-major points. */
export function tileOf(level: Level, tile: number, i: number, j: number): { x: number; y: number; at: number } {
	const a = (i - level.i0) / level.factor;
	const b = (j - level.j0) / level.factor;
	return { x: Math.floor(a / tile), y: Math.floor(b / tile), at: (b % tile) * tile + (a % tile) };
}

/** Inflates one segment of a tile payload into int16 values. */
export async function decodeSegment(payload: Uint8Array, segment: number): Promise<Int16Array> {
	if (payload.length < 1 || payload[0] <= segment) {
		throw new Error('nwp: tile payload lacks the segment');
	}
	const n = payload[0];
	const head = 1 + 4 * n;
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	let off = head;
	for (let k = 0; k < segment; k++) {
		off += view.getUint32(1 + 4 * k, true);
	}
	const len = view.getUint32(1 + 4 * segment, true);
	if (off + len > payload.length) {
		throw new Error('nwp: segment overruns the tile');
	}
	const raw = await inflateRaw(payload.subarray(off, off + len));
	if (raw.length % 2 !== 0) {
		throw new Error('nwp: odd segment length');
	}
	const out = new Int16Array(raw.length / 2);
	const rv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	for (let k = 0; k < out.length; k++) {
		out[k] = rv.getInt16(2 * k, true);
	}
	return out;
}

/** A variable's values at one point of a decoded segment, by step, null
 *  where missing. */
export function seriesAt(seg: SegmentDesc, data: Int16Array, varIndex: number, at: number, tile: number): (number | null)[] {
	const ns = seg.name === 'static' ? 1 : seg.steps.length;
	const pp = tile * tile;
	if (data.length !== seg.vars.length * ns * pp) {
		throw new Error(`nwp: segment ${seg.name} holds ${data.length} values, the descriptor ${seg.vars.length * ns * pp}`);
	}
	const v = seg.vars[varIndex];
	const out: (number | null)[] = [];
	for (let s = 0; s < ns; s++) {
		const q = data[(varIndex * ns + s) * pp + at];
		out.push(q === MISSING ? null : q * v.scale + (v.offset ?? 0));
	}
	return out;
}
