/* A frame's body still streaming when the layer is hidden: the check before
 * the body read passed, and the bytes landed in tier A afterwards, a hidden
 * layer holding tiles. Re-checked once the body is read. */
import { describe, expect, it, vi } from 'vitest';
import { display } from '$lib/state/display.svelte';
import { ui } from '$lib/state/ui.svelte';
import { ensureRadar, radar, radarFrameHeld, setShowRadarOnMap, type RadarView } from '$lib/state/radar.svelte';
import { frameSlot } from '$lib/weather/opera';
import { MIN, frameBody, indexResponse, settle, stubStorage } from './helpers/radarProxy';

const VIEW: RadarView = { product: 'DBZH', tiles: [30], p: 1 };

describe('a body still streaming at the switch-off', () => {
	it('is not stored once the layer is hidden', async () => {
		stubStorage();
		const now = Date.now();
		const slots = [frameSlot(now - 10 * MIN)];
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		vi.stubGlobal('fetch', (input: string): Promise<Response> => {
			const url = new URL(input);
			if (url.pathname === '/opera/frames') return Promise.resolve(indexResponse('DBZH', slots, Date.now()));
			const body = frameBody(url.searchParams.get('tiles')!.split(',').map(Number), 'DBZH');
			// The headers arrive at once; the body streams in two parts, the
			// second after the gate (a slow phone link).
			const stream = new ReadableStream<Uint8Array>({
				async start(c) {
					c.enqueue(body.subarray(0, 100));
					await gate;
					c.enqueue(body.subarray(100));
					c.close();
				},
			});
			return Promise.resolve(new Response(stream, { status: 200 }));
		});
		display.liveWeather = true;
		ui.isMobile = false;
		setShowRadarOnMap(true);
		ensureRadar(VIEW, Date.now());
		await settle();
		ensureRadar(VIEW, Date.now());
		await settle();
		// Response in hand, body streaming: the pilot hides the layer.
		setShowRadarOnMap(false);
		ensureRadar(VIEW, Date.now());
		expect(radar.status).toBe('idle');
		release();
		await settle();
		expect(radarFrameHeld(slots[0]), 'tier A holds the frame while hidden').toBe(false);
	});
});
