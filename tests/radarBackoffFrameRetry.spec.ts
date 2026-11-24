/* An index refused (429) while an earlier frame's failure stood: that frame's
 * retry, landing in the same pass, cleared the busy notice although the
 * backoff timer still stood, and the strip read "loading" with nothing
 * fetching. */
import { describe, expect, it, vi } from 'vitest';
import { display } from '$lib/state/display.svelte';
import { ui } from '$lib/state/ui.svelte';
import { ensureRadar, radar, setShowRadarOnMap, type RadarView } from '$lib/state/radar.svelte';
import { frameSlot } from '$lib/weather/opera';
import { MIN, frameBody, indexResponse, stubStorage } from './helpers/radarProxy';

const VIEW: RadarView = { product: 'DBZH', tiles: [30], p: 1 };

async function settleFake(): Promise<void> {
	for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(15);
}

describe('a frame retry landing inside an index backoff', () => {
	it('leaves the busy notice standing', async () => {
		vi.useFakeTimers();
		try {
			stubStorage();
			const now = Date.now();
			const slots = [frameSlot(now - 15 * MIN), frameSlot(now - 10 * MIN)];
			const status: Record<string, number> = { index: 200, [slots[1]]: 502 };
			let calls = 0;
			vi.stubGlobal('fetch', (input: string): Promise<Response> => {
				calls++;
				const url = new URL(input);
				if (url.pathname === '/opera/frames') {
					return Promise.resolve(
						status.index === 200
							? indexResponse('DBZH', slots, Date.now())
							: new Response('busy', { status: status.index, headers: { 'retry-after': '300' } }),
					);
				}
				const m = /^\/opera\/(\d{8}T\d{4})\/DBZH\.tiff$/.exec(url.pathname)!;
				const s = status[m[1]] ?? 200;
				if (s !== 200) return Promise.resolve(new Response('boom', { status: s }));
				return Promise.resolve(new Response(frameBody(url.searchParams.get('tiles')!.split(',').map(Number), 'DBZH'), { status: 200 }));
			});
			display.liveWeather = true;
			ui.isMobile = false;
			setShowRadarOnMap(true);
			ensureRadar(VIEW, Date.now());
			await settleFake();
			ensureRadar(VIEW, Date.now());
			await settleFake();
			ensureRadar(VIEW, Date.now());
			expect(radar.status).toBe('error'); // the 502 of the newest frame
			// A minute on: the index poll is due and the proxy refuses it
			// (Retry-After 300); the frame's retry in the same pass succeeds.
			await vi.advanceTimersByTimeAsync(61_000);
			status.index = 429;
			delete status[slots[1]];
			ensureRadar(VIEW, Date.now());
			await settleFake();
			ensureRadar(VIEW, Date.now());
			await settleFake();
			const before = calls;
			await vi.advanceTimersByTimeAsync(120_000);
			ensureRadar(VIEW, Date.now());
			expect(calls, 'nothing fetched inside the stand-down').toBe(before);
			expect(radar.status, 'status two minutes into the 300 s stand-down').toBe('error');
			expect(radar.error).not.toBeNull();
		} finally {
			await vi.advanceTimersByTimeAsync(400_000);
			vi.useRealTimers();
		}
	});
});
