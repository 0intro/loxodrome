/* A 200 answer shorter than the head is a frame whose bytes do not read, and
 * like the layout and truncated-tile refusals it is retried past the browser's
 * cache: it was read back from that cache (the slice is private, immutable)
 * every minute. */
import { describe, expect, it, vi } from 'vitest';
import { display } from '$lib/state/display.svelte';
import { ui } from '$lib/state/ui.svelte';
import { ensureRadar, radar, setShowRadarOnMap, type RadarView } from '$lib/state/radar.svelte';
import { frameSlot } from '$lib/weather/opera';
import { MIN, frameBody, indexResponse, settle, stubStorage } from './helpers/radarProxy';

const VIEW: RadarView = { product: 'DBZH', tiles: [30], p: 1 };

describe('a short answer', () => {
	it('is retried past the browser cache, like the other unreadable answers', async () => {
		stubStorage();
		const now = Date.now();
		const slots = [frameSlot(now - 10 * MIN)];
		const modes: string[] = [];
		let short = true;
		vi.stubGlobal('fetch', (input: string, init?: RequestInit): Promise<Response> => {
			const url = new URL(input);
			if (url.pathname === '/opera/frames') return Promise.resolve(indexResponse('DBZH', slots, Date.now()));
			modes.push(init?.cache ?? 'default');
			const body = frameBody(url.searchParams.get('tiles')!.split(',').map(Number), 'DBZH');
			return Promise.resolve(new Response(short ? body.subarray(0, 4000) : body, { status: 200 }));
		});
		display.liveWeather = true;
		ui.isMobile = false;
		setShowRadarOnMap(true);
		ensureRadar(VIEW, Date.now());
		await settle();
		ensureRadar(VIEW, Date.now());
		await settle();
		expect(radar.status).toBe('error');
		short = false;
		ensureRadar(VIEW, Date.now() + 61_000);
		await settle();
		expect(modes).toHaveLength(2);
		expect(modes[1], 'the retry of a short answer').toBe('reload');
	});
});
