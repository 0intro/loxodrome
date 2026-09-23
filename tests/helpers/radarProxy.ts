/* A stubbed OPERA relay for the radar state specs that need their own module
 * instance (the radar module is a singleton): a frame answer cut the way the
 * relay cuts it, the index answer, a settle and a localStorage. The fuller
 * proxy stays in tests/radarState.spec.ts. */
import { deflateSync } from 'node:zlib';
import { radarIdleForTest } from '$lib/state/radar.svelte';
import { OPERA_GRID, OPERA_GRID_2KM, type OperaGrid } from '$lib/weather/laea';
import { OPERA_HEAD_BYTES, type OperaProduct } from '$lib/weather/opera';

export const MIN = 60_000;

export function tileOf(value: number): Uint8Array {
	const cells = 512 * 512;
	const f = new Float32Array(cells * 2);
	for (let k = 0; k < cells; k++) {
		f[k * 2] = value;
		f[k * 2 + 1] = 1;
	}
	return new Uint8Array(deflateSync(Buffer.from(f.buffer)));
}

export const TILE_BYTES = tileOf(30);

export function operaHead(grid: OperaGrid, count: (i: number) => number): Uint8Array {
	const tiles = grid.tileCount;
	const tags: [number, number, number[]][] = [
		[256, 4, [grid.cols]],
		[257, 4, [grid.rows]],
		[258, 3, [32, 32]],
		[259, 3, [8]],
		[277, 3, [2]],
		[317, 3, [1]],
		[322, 4, [512]],
		[323, 4, [512]],
		[324, 4, []],
		[325, 4, []],
		[339, 3, [3, 3]],
	];
	const ifdAt = 8;
	const ifdBytes = 2 + tags.length * 12 + 4;
	let valuesAt = ifdAt + ifdBytes;
	const dataAt = valuesAt + 2 * 4 * tiles + 4 * 2 * 2;
	const counts = Array.from({ length: tiles }, (_, i) => count(i));
	let at = dataAt;
	tags[8][2] = counts.map((n) => {
		const o = at;
		at += n;
		return o;
	});
	tags[9][2] = counts;
	const head = new Uint8Array(OPERA_HEAD_BYTES);
	const dv = new DataView(head.buffer);
	head[0] = 0x49;
	head[1] = 0x49;
	dv.setUint16(2, 42, true);
	dv.setUint32(4, ifdAt, true);
	dv.setUint16(ifdAt, tags.length, true);
	let e = ifdAt + 2;
	for (const [tag, type, values] of tags) {
		const size = type === 3 ? 2 : 4;
		dv.setUint16(e, tag, true);
		dv.setUint16(e + 2, type, true);
		dv.setUint32(e + 4, values.length, true);
		let p = e + 8;
		if (values.length * size > 4) {
			p = valuesAt;
			dv.setUint32(e + 8, valuesAt, true);
			valuesAt += values.length * size;
		}
		values.forEach((v, k) => {
			if (type === 3) dv.setUint16(p + k * 2, v, true);
			else dv.setUint32(p + k * 4, v, true);
		});
		e += 12;
	}
	return head;
}

export function frameBody(
	tiles: number[],
	product: OperaProduct,
	bytesOf: (i: number) => Uint8Array = () => TILE_BYTES,
): Uint8Array<ArrayBuffer> {
	const grid = product === 'RATE' ? OPERA_GRID_2KM : OPERA_GRID;
	const head = operaHead(grid, (i) => bytesOf(i).length);
	const parts = tiles.map((i) => bytesOf(i));
	const body = new Uint8Array(OPERA_HEAD_BYTES + parts.reduce((n, b) => n + b.length, 0));
	body.set(head, 0);
	let at = OPERA_HEAD_BYTES;
	for (const b of parts) {
		body.set(b, at);
		at += b.length;
	}
	return body;
}

export function indexResponse(product: OperaProduct, slots: string[], now: number): Response {
	return new Response(
		JSON.stringify({
			product,
			frames: slots.map((t) => ({ t, bytes: 3_000_000, publishedAt: new Date(now).toISOString() })),
			now: new Date(now).toISOString(),
		}),
		{ status: 200, headers: { 'content-type': 'application/json', 'x-opera-now': new Date(now).toISOString() } },
	);
}

/** Let the fetches, the decodes and their macrotasks settle: until the
 *  product shown has nothing in flight or queued (radarIdleForTest), a few
 *  macrotask turns at least and three seconds at most. Timed by the work
 *  rather than a fixed 180 ms, which a loaded machine overran. */
export async function settle(): Promise<void> {
	const t0 = Date.now();
	for (let i = 0; ; i++) {
		await new Promise((r) => setTimeout(r, 15));
		if ((i >= 2 && radarIdleForTest()) || Date.now() - t0 > 3_000) {
			return;
		}
	}
}

export function stubStorage(): void {
	const store = new Map<string, string>();
	(globalThis as unknown as { localStorage: Storage }).localStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, String(v)),
		removeItem: (k: string) => void store.delete(k),
	} as unknown as Storage;
}
