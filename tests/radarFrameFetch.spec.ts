/* How a frame is fetched (state/radar.svelte.ts fetchFrame), over a stubbed
 * relay, under fake timers:
 *
 * - its HEADERS are timed, its BODY read against a stall timer: under one
 *   20 s deadline a frame on a slow link (one request for every tile in
 *   view, 850 KB on a rainy day) was aborted part-read and began again from
 *   byte zero a minute later, for as long as the link stayed slow, and the
 *   newest frame never drew;
 * - another object behind a slot is settled past the browser's cache: its
 *   day-long copy of the dropped tiles' URL answered with the old object,
 *   and the two evicted each other at the ensure pace, the frame never
 *   whole;
 * - a 429 landing after the layer was hidden still stands the fetches
 *   down: read as a straggler it was forgotten, and the show asked again
 *   inside the proxy's own window. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { display } from '$lib/state/display.svelte';
import { ui } from '$lib/state/ui.svelte';
import {
	ensureRadar,
	radar,
	radarFrameHeld,
	resetRadarForTest,
	setShowRadarOnMap,
	type RadarView,
} from '$lib/state/radar.svelte';
import { frameSlot } from '$lib/weather/opera';
import { MIN, frameBody, indexResponse, stubStorage } from './helpers/radarProxy';

async function settleFake(): Promise<void> {
	for (let i = 0; i < 12; i++) {
		await vi.advanceTimersByTimeAsync(15);
	}
}

/** A tile that inflates to the layout's 2 MiB and compresses to about
 *  `bytes`: `bytes` of noise, then zeros. */
function heavyTile(bytes: number): Uint8Array {
	const raw = new Uint8Array(512 * 512 * 2 * 4);
	let x = 2654435761;
	for (let i = 0; i < bytes; i++) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		raw[i] = x >>> 24;
	}
	return new Uint8Array(deflateSync(Buffer.from(raw.buffer)));
}

/** An answer served at `bytesPerS`, a chunk every 100 ms, erroring with the
 *  signal's reason when the fetch is aborted (a real fetch's body does);
 *  nothing more comes past `stallAt` bytes. */
function trickle(body: Uint8Array, bytesPerS: number, signal: AbortSignal | null | undefined, stallAt = Infinity): Response {
	let tick: ReturnType<typeof setInterval> | null = null;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			let at = 0;
			tick = setInterval(() => {
				if (at >= stallAt) {
					return;
				}
				const n = Math.min(Math.floor(bytesPerS / 10), body.length - at);
				c.enqueue(body.slice(at, at + n));
				at += n;
				if (at >= body.length) {
					clearInterval(tick!);
					c.close();
				}
			}, 100);
			signal?.addEventListener('abort', () => {
				clearInterval(tick!);
				c.error(signal.reason);
			});
		},
	});
	return new Response(stream, { status: 200 });
}

beforeEach(() => {
	vi.useFakeTimers();
	// AbortSignal.timeout runs on a clock fake timers do not move: the
	// module's own timeouts are asked of the faked setTimeout instead, so a
	// deadline on the whole answer shows under the fake clock.
	vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
		const c = new AbortController();
		setTimeout(() => c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
		return c.signal;
	});
	stubStorage();
	resetRadarForTest();
	display.liveWeather = true;
	ui.isMobile = true;
});

afterEach(async () => {
	setShowRadarOnMap(false);
	await vi.advanceTimersByTimeAsync(2_000_000);
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('a frame on a slow link', () => {
	const VIEW: RadarView = { product: 'DBZH', tiles: [19, 20, 27, 28], p: 2 };
	const TILE = heavyTile(100_000);

	it('is delivered whole while bytes keep coming, whatever the whole takes', async () => {
		const now = Date.now();
		const slots = [frameSlot(now - 10 * MIN), frameSlot(now - 5 * MIN)];
		const starts: number[] = [];
		vi.stubGlobal('fetch', (input: string, init?: RequestInit): Promise<Response> => {
			const url = new URL(input);
			if (url.pathname === '/opera/frames') {
				return Promise.resolve(indexResponse('DBZH', slots, Date.now()));
			}
			starts.push(Date.now());
			const body = frameBody(url.searchParams.get('tiles')!.split(',').map(Number), 'DBZH', () => TILE);
			// 6 KB/s: about 400 KB, over a minute of steady bytes.
			return Promise.resolve(trickle(body, 6_000, init?.signal));
		});
		setShowRadarOnMap(true);
		ensureRadar(VIEW, Date.now());
		await settleFake();
		ensureRadar(VIEW, Date.now());
		await settleFake();
		expect(starts).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(90_000);
		ensureRadar(VIEW, Date.now());
		await settleFake();
		expect(radarFrameHeld(slots[1])).toBe(true);
		expect(radarFrameHeld(slots[0])).toBe(true);
		expect(radar.error).toBeNull();
		// Delivered once each, never begun again from byte zero.
		expect(starts).toHaveLength(2);
	});

	it('is aborted once its bytes stop, the failure said, and asked again after the minute', async () => {
		const now = Date.now();
		const slots = [frameSlot(now - 5 * MIN)];
		let asks = 0;
		vi.stubGlobal('fetch', (input: string, init?: RequestInit): Promise<Response> => {
			const url = new URL(input);
			if (url.pathname === '/opera/frames') {
				return Promise.resolve(indexResponse('DBZH', slots, Date.now()));
			}
			asks++;
			const body = frameBody(url.searchParams.get('tiles')!.split(',').map(Number), 'DBZH', () => TILE);
			return Promise.resolve(trickle(body, 6_000, init?.signal, asks === 1 ? 50_000 : Infinity));
		});
		setShowRadarOnMap(true);
		ensureRadar(VIEW, Date.now());
		await settleFake();
		ensureRadar(VIEW, Date.now());
		await settleFake();
		// 50 KB in about 8 s, then nothing: aborted 20 s after the last byte.
		await vi.advanceTimersByTimeAsync(30_000);
		await settleFake();
		ensureRadar(VIEW, Date.now());
		expect(radar.status).toBe('error');
		expect(radar.error?.()).toContain('timeout');
		expect(radarFrameHeld(slots[0])).toBe(false);
		expect(asks).toBe(1);
		// A minute past the abort (about 28 s in), it is asked again.
		await vi.advanceTimersByTimeAsync(61_000);
		ensureRadar(VIEW, Date.now());
		await settleFake();
		expect(asks).toBe(2);
		await vi.advanceTimersByTimeAsync(90_000);
		ensureRadar(VIEW, Date.now());
		await settleFake();
		expect(radarFrameHeld(slots[0])).toBe(true);
	});
});

describe('another object behind a slot', () => {
	it('is settled past the browser\'s cache, never evicting the frame in turn with the old one', async () => {
		/** A tile of object `v`, its own byte count per version. */
		const tileOf = (v: number, i: number): Uint8Array => {
			const f = new Float32Array(512 * 512 * 2);
			for (let k = 0; k < 512 * 512; k++) {
				f[k * 2] = k < (v === 1 ? 100 : 3000) ? 20 + i + (k % 5) : 20 + i;
				f[k * 2 + 1] = 1;
			}
			return new Uint8Array(deflateSync(Buffer.from(f.buffer)));
		};
		const now = Date.now();
		const slots = [frameSlot(now - 5 * MIN)];
		const asks: string[] = [];
		// The browser: the first answer for a URL is kept (private,
		// immutable), a 'reload' asks the network again and keeps that.
		const httpCache = new Map<string, Uint8Array>();
		let upstream = 1;
		vi.stubGlobal('fetch', (input: string, init?: RequestInit): Promise<Response> => {
			const url = new URL(input);
			if (url.pathname === '/opera/frames') {
				return Promise.resolve(indexResponse('DBZH', slots, Date.now()));
			}
			const tiles = url.searchParams.get('tiles')!;
			asks.push(`${tiles}${init?.cache === 'reload' ? ' (reload)' : ''}`);
			let body = httpCache.get(tiles);
			if (!body || init?.cache === 'reload') {
				const v = upstream;
				body = frameBody(tiles.split(',').map(Number), 'DBZH', (i) => tileOf(v, i));
				httpCache.set(tiles, body);
			}
			return Promise.resolve(new Response(body.slice(), { status: 200 }));
		});
		ui.isMobile = false;
		setShowRadarOnMap(true);
		const A: RadarView = { product: 'DBZH', tiles: [30], p: 1 };
		for (let k = 0; k < 3; k++) {
			ensureRadar(A, Date.now());
			await settleFake();
		}
		expect(radarFrameHeld(slots[0])).toBe(true);
		// Re-published upstream; the pilot pans so the view needs 38 too.
		upstream = 2;
		const B: RadarView = { product: 'DBZH', tiles: [30, 38], p: 1 };
		const before = asks.length;
		for (let k = 0; k < 20; k++) {
			ensureRadar(B, Date.now());
			await settleFake();
		}
		expect(radarFrameHeld(slots[0])).toBe(true);
		expect(asks.slice(before)).toEqual(['38', '30 (reload)']);
	});
});

describe('a refusal landing while the layer is hidden', () => {
	it('still stands the fetches down for the window the proxy asked', async () => {
		const now = Date.now();
		const slots = [frameSlot(now - 10 * MIN), frameSlot(now - 5 * MIN)];
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const frameAsks: number[] = [];
		vi.stubGlobal('fetch', async (input: string): Promise<Response> => {
			const url = new URL(input);
			if (url.pathname === '/opera/frames') {
				return indexResponse('DBZH', slots, Date.now());
			}
			frameAsks.push(Date.now());
			await gate;
			return new Response('busy', { status: 429, headers: { 'retry-after': '300' } });
		});
		ui.isMobile = false;
		setShowRadarOnMap(true);
		const VIEW: RadarView = { product: 'DBZH', tiles: [30], p: 1 };
		ensureRadar(VIEW, Date.now());
		await settleFake();
		ensureRadar(VIEW, Date.now());
		await settleFake();
		expect(frameAsks).toHaveLength(2);
		// The pilot hides the layer; the refusals land meanwhile.
		setShowRadarOnMap(false);
		ensureRadar(VIEW, Date.now());
		release();
		await settleFake();
		// Shown again ten seconds later, inside the proxy's 300 s.
		await vi.advanceTimersByTimeAsync(10_000);
		setShowRadarOnMap(true);
		ensureRadar(VIEW, Date.now());
		await settleFake();
		ensureRadar(VIEW, Date.now());
		await settleFake();
		expect(frameAsks).toHaveLength(2);
		expect(radar.status).toBe('error');
		expect(radar.error?.()).toContain('busy');
	});
});
