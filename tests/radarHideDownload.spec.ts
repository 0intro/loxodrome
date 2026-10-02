/* What a hide, Live weather off or a product switch lets go of
 * (state/radar.svelte.ts dropTiles), over a stubbed relay, under fake timers:
 *
 * - a frame still downloading is ABORTED there, headers or body. A frame's
 *   body is read against a stall timer rather than one deadline, for up to
 *   five minutes on a slow link, and nothing stopped it at a hide: it was
 *   read to its end and thrown away, two frames of up to 850 KB each holding
 *   the link the pilot had hidden the layer to free;
 * - an answer returned from unread (landing after the hide, a 404, a 5xx, a
 *   429) has its body cancelled rather than left open on the link;
 * - a failure landing after the hide, the fetch's or a tile decode's, stamps
 *   nothing: the stamps go with the tiles at the hide, and one put back held
 *   the frame back after a re-show inside the minute, its slot drawn with no
 *   tiles and nothing said. A tile that did not inflate is still asked again
 *   past the browser's cache, whose day-long copy is the bad one. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { display } from '$lib/state/display.svelte';
import { ui } from '$lib/state/ui.svelte';
import {
	ensureRadar,
	radar,
	radarFrameHeld,
	resetRadarForTest,
	setRadarProduct,
	setShowRadarOnMap,
	type RadarView,
} from '$lib/state/radar.svelte';
import { frameSlot } from '$lib/weather/opera';
import { MIN, drainRadar, frameBody, indexResponse, stubStorage } from './helpers/radarProxy';

/** A tile decode the test holds open, then fails: set, the next inflate
 *  waits on it; unset, the real one runs. */
const inflate = vi.hoisted(() => ({
	hold: null as { promise: Promise<Uint8Array>; reject: (e: unknown) => void } | null,
}));

vi.mock('$lib/files/deflate', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/files/deflate')>();
	return {
		...real,
		inflateZlib: (data: Uint8Array, maxBytes: number): Promise<Uint8Array> =>
			inflate.hold ? inflate.hold.promise : real.inflateZlib(data, maxBytes),
	};
});

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

interface Trickle {
	res: Response;
	/** The bytes the reader has asked for so far. */
	state: { pulled: number; aborted: boolean; cancelled: boolean };
	total: number;
}

/** A PULL-driven answer served at `bytesPerS` (a chunk per 100 ms of
 *  demand), so `pulled` counts what was actually read; the fetch's abort
 *  errors it as a real body does, and a cancel is recorded. */
function trickle(body: Uint8Array, bytesPerS: number, signal: AbortSignal | null | undefined, status = 200): Trickle {
	const state = { pulled: 0, aborted: false, cancelled: false };
	let at = 0;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			signal?.addEventListener('abort', () => {
				state.aborted = true;
				c.error(signal.reason);
			});
		},
		async pull(c) {
			await new Promise((r) => setTimeout(r, 100));
			if (state.aborted || state.cancelled) {
				return;
			}
			const n = Math.min(Math.floor(bytesPerS / 10), body.length - at);
			c.enqueue(body.slice(at, at + n));
			at += n;
			state.pulled = at;
			if (at >= body.length) {
				c.close();
			}
		},
		cancel() {
			state.cancelled = true;
		},
	});
	const headers: Record<string, string> = status === 429 ? { 'retry-after': '120' } : {};
	return { res: new Response(stream, { status, headers }), state, total: body.length };
}

beforeEach(() => {
	vi.useFakeTimers();
	// AbortSignal.timeout runs on a clock fake timers do not move: the
	// module's own timeouts are asked of the faked setTimeout instead.
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
	inflate.hold = null;
	setShowRadarOnMap(false);
	// The product is module state a switch leaves behind for the next test.
	setRadarProduct('DBZH');
	await vi.advanceTimersByTimeAsync(2_000_000);
	vi.useRealTimers();
	await drainRadar();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const VIEW: RadarView = { product: 'DBZH', tiles: [19, 20, 27, 28], p: 2 };
const TILE = heavyTile(100_000);

/** One listed frame served over a slow link, its downloads in `bodies`. */
function slowRelay(): { slot: string; bodies: Trickle[] } {
	const slot = frameSlot(Date.now() - 5 * MIN);
	const bodies: Trickle[] = [];
	vi.stubGlobal('fetch', (input: string, init?: RequestInit): Promise<Response> => {
		const url = new URL(input);
		if (url.pathname === '/opera/frames') {
			return Promise.resolve(indexResponse('DBZH', [slot], Date.now()));
		}
		const tiles = url.searchParams.get('tiles')!.split(',').map(Number);
		// 6 KB/s: about 400 KB, over a minute of steady bytes.
		const b = trickle(frameBody(tiles, 'DBZH', () => TILE), 6_000, init?.signal);
		bodies.push(b);
		return Promise.resolve(b.res);
	});
	return { slot, bodies };
}

async function showAndStart(): Promise<void> {
	setShowRadarOnMap(true);
	ensureRadar(VIEW, Date.now());
	await settleFake();
	ensureRadar(VIEW, Date.now());
	await settleFake();
}

describe('a frame still downloading when the radar is let go of', () => {
	it('is aborted at the hide, and asked afresh at the show with nothing said', async () => {
		const { slot, bodies } = slowRelay();
		await showAndStart();
		expect(bodies).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(5_000);
		const atHide = bodies[0].state.pulled;
		expect(atHide).toBeGreaterThan(0);
		expect(atHide).toBeLessThan(bodies[0].total);
		setShowRadarOnMap(false);
		ensureRadar(null, Date.now());
		await vi.advanceTimersByTimeAsync(120_000);
		expect(bodies[0].state.aborted).toBe(true);
		expect(bodies[0].state.pulled, 'read no further than the chunk in hand').toBeLessThanOrEqual(atHide + 600);
		// Let go of, not failed: the show asks for the frame at once, with no
		// stamp holding it back and no error on the strip.
		await showAndStart();
		expect(bodies).toHaveLength(2);
		expect(radar.error).toBeNull();
		await vi.advanceTimersByTimeAsync(90_000);
		ensureRadar(VIEW, Date.now());
		await settleFake();
		expect(radarFrameHeld(slot)).toBe(true);
	});

	it('is aborted when Live weather is switched off', async () => {
		const { bodies } = slowRelay();
		await showAndStart();
		expect(bodies).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(5_000);
		const atOff = bodies[0].state.pulled;
		display.liveWeather = false;
		ensureRadar(VIEW, Date.now());
		await vi.advanceTimersByTimeAsync(120_000);
		expect(bodies[0].state.aborted).toBe(true);
		expect(bodies[0].state.pulled).toBeLessThanOrEqual(atOff + 600);
	});

	it('is aborted at a product switch', async () => {
		const { bodies } = slowRelay();
		await showAndStart();
		expect(bodies).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(5_000);
		const atSwitch = bodies[0].state.pulled;
		setRadarProduct('RATE');
		await vi.advanceTimersByTimeAsync(120_000);
		expect(bodies[0].state.aborted).toBe(true);
		expect(bodies[0].state.pulled).toBeLessThanOrEqual(atSwitch + 600);
	});
});

describe('an answer returned from unread', () => {
	it('has its body cancelled when its headers land after the hide', async () => {
		const slot = frameSlot(Date.now() - 5 * MIN);
		const bodies: Trickle[] = [];
		let answer: ((r: Response) => void) | null = null;
		vi.stubGlobal('fetch', (input: string): Promise<Response> => {
			const url = new URL(input);
			if (url.pathname === '/opera/frames') {
				return Promise.resolve(indexResponse('DBZH', [slot], Date.now()));
			}
			const tiles = url.searchParams.get('tiles')!.split(',').map(Number);
			// Deaf to the abort, as a response already on its way can be:
			// what stops it is the cancel of its body.
			bodies.push(trickle(frameBody(tiles, 'DBZH', () => TILE), 6_000, null));
			return new Promise<Response>((r) => {
				answer = r;
			});
		});
		await showAndStart();
		expect(bodies).toHaveLength(1);
		setShowRadarOnMap(false);
		ensureRadar(null, Date.now());
		await vi.advanceTimersByTimeAsync(3_000);
		answer!(bodies[0].res);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(bodies[0].state.cancelled).toBe(true);
		expect(bodies[0].state.pulled).toBeLessThan(bodies[0].total);
	});

	it('has its body cancelled under a 404, a 5xx and a 429', async () => {
		const now = Date.now();
		const slots = [frameSlot(now - 10 * MIN), frameSlot(now - 5 * MIN)];
		const answers: Trickle[] = [];
		const statuses = [404, 503, 429, 429];
		vi.stubGlobal('fetch', (input: string, init?: RequestInit): Promise<Response> => {
			const url = new URL(input);
			if (url.pathname === '/opera/frames') {
				return Promise.resolve(indexResponse('DBZH', slots, Date.now()));
			}
			const status = statuses[answers.length] ?? 429;
			const a = trickle(new TextEncoder().encode('upstream says no '.repeat(400)), 6_000, init?.signal, status);
			answers.push(a);
			return Promise.resolve(a.res);
		});
		await showAndStart();
		expect(answers.map((a) => a.res.status)).toEqual([404, 503]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(answers.map((a) => a.state.cancelled)).toEqual([true, true]);
		// Past the failures' minute both are asked again, and refused.
		await vi.advanceTimersByTimeAsync(61_000);
		ensureRadar(VIEW, Date.now());
		await settleFake();
		expect(answers.map((a) => a.res.status)).toEqual([404, 503, 429, 429]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(answers.every((a) => a.state.cancelled)).toBe(true);
		expect(radar.error?.()).toContain('busy');
	});
});

describe('a failure landing after the hide', () => {
	it('never holds the frame back after a re-show: the fetch', async () => {
		const slot = frameSlot(Date.now() - 5 * MIN);
		let frameAsks = 0;
		vi.stubGlobal('fetch', (input: string, init?: RequestInit): Promise<Response> => {
			const url = new URL(input);
			if (url.pathname === '/opera/frames') {
				return Promise.resolve(indexResponse('DBZH', [slot], Date.now()));
			}
			frameAsks++;
			// Never answers: it ends on an abort, the headers timer's at 20 s
			// or whatever came first.
			return new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error));
			});
		});
		await showAndStart();
		expect(frameAsks).toBe(1);
		setShowRadarOnMap(false);
		ensureRadar(null, Date.now());
		await vi.advanceTimersByTimeAsync(21_000);
		await showAndStart();
		expect(frameAsks).toBe(2);
		expect(radar.error).toBeNull();
	});

	it('never holds the frame back after a re-show: a tile decode, the reload past the cache kept', async () => {
		const slot = frameSlot(Date.now() - 5 * MIN);
		const caches: (RequestCache | undefined)[] = [];
		vi.stubGlobal('fetch', (input: string, init?: RequestInit): Promise<Response> => {
			const url = new URL(input);
			if (url.pathname === '/opera/frames') {
				return Promise.resolve(indexResponse('DBZH', [slot], Date.now()));
			}
			caches.push(init?.cache);
			const tiles = url.searchParams.get('tiles')!.split(',').map(Number);
			return Promise.resolve(new Response(frameBody(tiles, 'DBZH'), { status: 200 }));
		});
		let reject!: (e: unknown) => void;
		const promise = new Promise<Uint8Array>((_, r) => (reject = r));
		promise.catch(() => {});
		inflate.hold = { promise, reject };
		const view: RadarView = { product: 'DBZH', tiles: [30], p: 1 };
		setShowRadarOnMap(true);
		ensureRadar(view, Date.now());
		await settleFake();
		ensureRadar(view, Date.now());
		await settleFake();
		expect(caches).toEqual(['default']);
		expect(radarFrameHeld(slot)).toBe(true);
		// The pilot hides the layer while the tile inflates; the inflate then
		// fails (a bad copy in the browser's cache).
		setShowRadarOnMap(false);
		ensureRadar(null, Date.now());
		inflate.hold = null;
		reject(new Error('bad zlib stream'));
		await settleFake();
		setShowRadarOnMap(true);
		ensureRadar(view, Date.now());
		await settleFake();
		expect(caches).toEqual(['default', 'reload']);
		expect(radar.error).toBeNull();
	});
});
