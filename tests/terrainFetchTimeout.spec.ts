/* A terrain tile read is bounded (offline/passiveStore.ts TILE_FETCH_TIMEOUT_MS,
 * headers and body). It was a bare fetch(url): a request a fading mobile link
 * left open held its load for good, and six of them held every one of the six
 * connections the terrain reads share (map/terrain.ts), so no read anywhere in
 * the app completed: the shading, the alert's corridor, the ground under the
 * aircraft, the route's MSA and profile. The store's network is stubbed: a
 * stalled request answers nothing until its signal aborts it. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

const stall = new Set<string>();

function tileBytes(url: string): Uint8Array {
	const parts = url.split('/');
	const raw = gunzipSync(readFileSync('tests/fixtures/terrain-12-2125-1464.tile'));
	const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	view.setUint8(8, Number(parts.at(-3)));
	view.setUint32(12, Number(parts.at(-2)), true);
	view.setUint32(16, Number(parts.at(-1)), true);
	return new Uint8Array(gzipSync(raw));
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('fetch', (url: string, init?: RequestInit): Promise<Response> => {
		const tail = url.split('/terrain/')[1] ?? url;
		if (stall.has(tail)) {
			return new Promise((_, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
			});
		}
		return Promise.resolve(new Response(new Uint8Array(tileBytes(url))));
	});
});

afterEach(() => {
	stall.clear();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('a terrain tile read', () => {
	it('fails once its budget runs out, rather than waiting for good', async () => {
		const { passiveFetchBlob, TILE_FETCH_TIMEOUT_MS } = await import('$lib/offline/passiveStore');
		stall.add('12/2000/1400');
		const read = passiveFetchBlob('https://charts.example/terrain/12/2000/1400');
		const settled = read.then(
			() => 'answered',
			() => 'failed',
		);
		await vi.advanceTimersByTimeAsync(TILE_FETCH_TIMEOUT_MS - 1_000);
		let state = 'pending';
		void settled.then((s) => (state = s));
		await vi.advanceTimersByTimeAsync(0);
		expect(state).toBe('pending');
		await vi.advanceTimersByTimeAsync(2_000);
		expect(await settled).toBe('failed');
	});

	it('leaves the next read of the ground able to complete behind six stalled ones', async () => {
		// Only the timers are faked here: the tile's decode is real I/O.
		vi.useRealTimers();
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const { TILE_FETCH_TIMEOUT_MS } = await import('$lib/offline/passiveStore');
		const { elevationAt, visitTiles } = await import('$lib/map/terrain');
		for (let x = 0; x < 6; x++) {
			stall.add(`12/${2000 + x}/1400`);
			void visitTiles([{ z: 12, x: 2000 + x, y: 1400 }], () => {});
		}
		let ground: number | null | 'pending' = 'pending';
		const read = elevationAt(45.63, 6.79).then((m) => (ground = m));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(ground).toBe('pending'); // queued behind the six
		await vi.advanceTimersByTimeAsync(TILE_FETCH_TIMEOUT_MS + 1_000);
		vi.useRealTimers();
		await Promise.race([read, new Promise((r) => setTimeout(r, 5_000))]);
		expect(typeof ground).toBe('number');
	});
});
