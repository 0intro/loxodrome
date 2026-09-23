/* A frame's failure stamp holds it back for the retry minute
 * (state/radar.svelte.ts ensureRadar). Two ways it held a frame back with
 * nothing said:
 *
 * - a stamp on the DEVICE clock, which a step back (NTP, NITZ, a pilot's
 *   correction) put ahead of the clock: the frame was not asked again until
 *   the clock had made up the whole step, its slot drawn with no tiles and
 *   a hole in the loop (the index poll re-anchors on the same step already);
 * - a stamp kept across a hide and a show, while the notice that said so
 *   went with the hide: "loading", nothing fetching, for the rest of the
 *   minute. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { display } from '$lib/state/display.svelte';
import { ui } from '$lib/state/ui.svelte';
import {
	ensureRadar,
	radar,
	radarFrameHeld,
	radarLoop,
	resetRadarForTest,
	setRadarProduct,
	setShowRadarOnMap,
	shownRadarFrame,
	type RadarView,
} from '$lib/state/radar.svelte';
import { frameSlot } from '$lib/weather/opera';
import { MIN, frameBody, indexResponse, settle, stubStorage } from './helpers/radarProxy';

async function settleFake(): Promise<void> {
	for (let i = 0; i < 12; i++) {
		await vi.advanceTimersByTimeAsync(15);
	}
}

beforeEach(() => {
	stubStorage();
	resetRadarForTest();
	display.liveWeather = true;
	ui.isMobile = false;
});

afterEach(() => {
	setShowRadarOnMap(false);
	setRadarProduct('DBZH');
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('a clock stepped back after a frame failed', () => {
	const VIEW: RadarView = { product: 'RATE', tiles: [9], p: 1 };

	it('asks for the frame again at the next pass, never after the whole step', async () => {
		vi.useFakeTimers();
		try {
			// The proxy's (true) clock: the device's plus what the step took off.
			let behind = 0;
			const trueNow = (): number => Date.now() + behind;
			// RATE, a 15-minute cadence published 10 min after nominal.
			const listed = (): string[] => {
				const last = Math.floor((trueNow() - 10.1 * MIN) / (15 * MIN)) * 15 * MIN;
				return [last - 45 * MIN, last - 30 * MIN, last - 15 * MIN, last].map((ms) => frameSlot(ms, 15));
			};
			const now0 = Date.now();
			const nextPub = Math.ceil((now0 - 10.1 * MIN) / (15 * MIN)) * 15 * MIN + 10.1 * MIN;
			vi.setSystemTime(nextPub + 30_000);
			const first = listed();
			const failed = first[first.length - 1];
			let fail = true;
			const asks: string[] = [];
			vi.stubGlobal('fetch', (input: string): Promise<Response> => {
				const url = new URL(input);
				if (url.pathname === '/opera/frames') {
					return Promise.resolve(indexResponse('RATE', listed(), trueNow()));
				}
				const m = /^\/opera\/(\d{8}T\d{4})\/RATE\.tiff$/.exec(url.pathname)!;
				asks.push(m[1]);
				if (m[1] === failed && fail) {
					fail = false;
					// One transient failure (the relay's memory budget, say).
					return Promise.resolve(new Response('server busy', { status: 503 }));
				}
				return Promise.resolve(
					new Response(frameBody(url.searchParams.get('tiles')!.split(',').map(Number), 'RATE'), { status: 200 }),
				);
			});
			setShowRadarOnMap(true);
			setRadarProduct('RATE');
			ensureRadar(VIEW, Date.now());
			await settleFake();
			ensureRadar(VIEW, Date.now());
			await settleFake();
			expect(radarFrameHeld(failed)).toBe(false);
			// The device clock is stepped back half an hour.
			vi.setSystemTime(Date.now() - 30 * MIN);
			behind = 30 * MIN;
			let blank = 0;
			for (let k = 0; k < 20; k++) {
				await vi.advanceTimersByTimeAsync(MIN);
				ensureRadar(VIEW, Date.now());
				await settleFake();
				const shown = shownRadarFrame();
				if (shown && !radarFrameHeld(shown.t)) {
					blank++;
				}
			}
			expect(asks.filter((t) => t === failed)).toHaveLength(2);
			expect(blank).toBeLessThanOrEqual(1);
			expect(radarLoop().frames.every((f) => radarFrameHeld(f.t))).toBe(true);
		} finally {
			setShowRadarOnMap(false);
			await vi.advanceTimersByTimeAsync(1_000_000);
		}
	});
});

describe('a frame failure across a hide and a show', () => {
	it('is asked again at the show, so its failure is said again, never "loading" with nothing fetching', async () => {
		const VIEW: RadarView = { product: 'DBZH', tiles: [30], p: 1 };
		const now = Date.now();
		const slots = [frameSlot(now - 10 * MIN), frameSlot(now - 5 * MIN)];
		let frameCalls = 0;
		vi.stubGlobal('fetch', (input: string): Promise<Response> => {
			const url = new URL(input);
			if (url.pathname === '/opera/frames') {
				return Promise.resolve(indexResponse('DBZH', slots, Date.now()));
			}
			frameCalls++;
			const m = /^\/opera\/(\d{8}T\d{4})\/DBZH\.tiff$/.exec(url.pathname)!;
			if (m[1] === slots[1]) {
				return Promise.resolve(new Response('bad gateway', { status: 502 }));
			}
			return Promise.resolve(
				new Response(frameBody(url.searchParams.get('tiles')!.split(',').map(Number), 'DBZH'), { status: 200 }),
			);
		});
		setShowRadarOnMap(true);
		ensureRadar(VIEW, Date.now());
		await settle();
		ensureRadar(VIEW, Date.now());
		await settle();
		ensureRadar(VIEW, Date.now());
		expect(radar.status).toBe('error');
		expect(radar.error?.()).toContain('502');
		// Live weather off and on again, inside the minute.
		display.liveWeather = false;
		ensureRadar(VIEW, Date.now());
		display.liveWeather = true;
		const before = frameCalls;
		ensureRadar(VIEW, Date.now());
		await settle();
		ensureRadar(VIEW, Date.now());
		await settle();
		ensureRadar(VIEW, Date.now());
		expect(frameCalls).toBeGreaterThan(before);
		expect(radar.status).toBe('error');
		expect(radar.error?.()).toContain('502');
	});
});
