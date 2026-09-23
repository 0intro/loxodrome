/* The backoff doubles through an incident: 66 s, then 132. A success that is
 * not a fresh listing (a frame answered by a request already in flight when
 * the refusal landed, or a slice out of the browser's cache) reset it to its
 * first step, and a sustained refusal was retried every 66 s. Only an index
 * listed by a request started after the refusal resets it. */
import { describe, expect, it, vi } from 'vitest';
import { display } from '$lib/state/display.svelte';
import { ui } from '$lib/state/ui.svelte';
import { ensureRadar, radar, setShowRadarOnMap, type RadarView } from '$lib/state/radar.svelte';
import { frameSlot } from '$lib/weather/opera';
import { MIN, frameBody, indexResponse, stubStorage } from './helpers/radarProxy';

const VIEW: RadarView = { product: 'DBZH', tiles: [30], p: 1 };

async function settleFake(): Promise<void> {
	for (let i = 0; i < 12; i++) {
		await vi.advanceTimersByTimeAsync(15);
	}
}

describe('a sustained refusal', () => {
	it('doubles its wait, whatever lands inside the incident', async () => {
		vi.useFakeTimers();
		try {
			stubStorage();
			const now = Date.now();
			const slots = [frameSlot(now - 15 * MIN), frameSlot(now - 10 * MIN)];
			let release!: () => void;
			const held = new Promise<void>((r) => (release = r));
			vi.stubGlobal('fetch', async (input: string) => {
				const url = new URL(input);
				if (url.pathname === '/opera/frames') {
					return indexResponse('DBZH', slots, Date.now());
				}
				const m = /^\/opera\/(\d{8}T\d{4})\/DBZH\.tiff$/.exec(url.pathname)!;
				if (m[1] === slots[0]) {
					// In flight when the refusal lands, answered inside it.
					await held;
					return new Response(frameBody(url.searchParams.get('tiles')!.split(',').map(Number), 'DBZH'), { status: 200 });
				}
				return new Response('busy', { status: 429 });
			});
			display.liveWeather = true;
			ui.isMobile = false;
			setShowRadarOnMap(true);
			ensureRadar(VIEW, Date.now());
			await settleFake();
			ensureRadar(VIEW, Date.now());
			await settleFake();
			expect(radar.error?.()).toContain('66');
			release();
			await settleFake();
			// The timer fires; the newest frame is refused again.
			await vi.advanceTimersByTimeAsync(66_000);
			ensureRadar(VIEW, Date.now());
			await settleFake();
			expect(radar.status).toBe('error');
			expect(radar.error?.()).toContain('132');
		} finally {
			await vi.advanceTimersByTimeAsync(1_000_000);
			vi.useRealTimers();
		}
	});
});
