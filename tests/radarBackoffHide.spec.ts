/* A rate limit across a hide and a show: the backoff timer is the only way
 * back to the network, and the notice says so for the whole stand-down. The
 * hidden branch cleared it, and the show returned early on the timer before
 * writing any status: "loading" for up to 15 minutes with nothing fetching. */
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

describe('a rate limit across a hide and show', () => {
	it('keeps saying the proxy is busy while the timer is the only way back', async () => {
		vi.useFakeTimers();
		try {
			stubStorage();
			const now = Date.now();
			const slots = [frameSlot(now - 15 * MIN), frameSlot(now - 10 * MIN)];
			let calls = 0;
			vi.stubGlobal('fetch', (input: string): Promise<Response> => {
				calls++;
				const url = new URL(input);
				if (url.pathname === '/opera/frames') return Promise.resolve(indexResponse('DBZH', slots, Date.now()));
				void frameBody;
				return Promise.resolve(new Response('busy', { status: 429, headers: { 'retry-after': '300' } }));
			});
			display.liveWeather = true;
			ui.isMobile = false;
			setShowRadarOnMap(true);
			ensureRadar(VIEW, Date.now());
			await settleFake();
			ensureRadar(VIEW, Date.now());
			await settleFake();
			expect(radar.status).toBe('error');
			expect(radar.error!()).toContain('300');
			// The pilot toggles the layer off and on (Layers tab), as one does
			// when something looks stuck.
			setShowRadarOnMap(false);
			ensureRadar(VIEW, Date.now());
			setShowRadarOnMap(true);
			ensureRadar(VIEW, Date.now());
			await settleFake();
			const before = calls;
			await vi.advanceTimersByTimeAsync(120_000);
			ensureRadar(VIEW, Date.now());
			// Nothing fetched: the backoff timer still stands...
			expect(calls).toBe(before);
			// ...so the notice must still say why.
			expect(radar.status, 'status two minutes into the 300 s stand-down').toBe('error');
			expect(radar.error).not.toBeNull();
		} finally {
			await vi.advanceTimersByTimeAsync(400_000);
			vi.useRealTimers();
		}
	});
});
