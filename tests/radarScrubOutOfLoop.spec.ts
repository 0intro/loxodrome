/* A scrub whose frame has left the loop: radarLoop() draws the loop's newest
 * frame instead, and the fetch, the decode's repaint and the eviction now ask
 * the same question (shownIn). They read `shownT ?? newest`, so the frame
 * actually drawn never raised paintSeq when its tiles decoded, and stayed
 * blank until the next minute tick. */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { display } from '$lib/state/display.svelte';
import { ui } from '$lib/state/ui.svelte';
import {
	ensureRadar,
	radar,
	radarFrameHeld,
	radarLoop,
	radarTileAt,
	refreshRadar,
	setRadarLoop,
	setRadarShownFrame,
	setShowRadarOnMap,
	shownRadarFrame,
	type RadarView,
} from '$lib/state/radar.svelte';
import { frameSlot } from '$lib/weather/opera';
import { MIN, frameBody, indexResponse, settle, stubStorage } from './helpers/radarProxy';

const VIEW: RadarView = { product: 'DBZH', tiles: [30], p: 1 };
let slots: string[] = [];

beforeAll(() => {
	stubStorage();
	vi.stubGlobal('fetch', (input: string): Promise<Response> => {
		const url = new URL(input);
		if (url.pathname === '/opera/frames') return Promise.resolve(indexResponse('DBZH', slots, Date.now()));
		const m = /^\/opera\/(\d{8}T\d{4})\/DBZH\.tiff$/.exec(url.pathname);
		if (!m) return Promise.resolve(new Response('no', { status: 404 }));
		return Promise.resolve(new Response(frameBody(url.searchParams.get('tiles')!.split(',').map(Number), 'DBZH'), { status: 200 }));
	});
	display.liveWeather = true;
	ui.isMobile = false;
});

async function fill(): Promise<void> {
	for (let pass = 0; pass < 10; pass++) {
		ensureRadar(VIEW, Date.now());
		await settle();
	}
	for (const f of radarLoop().frames) radarTileAt(f.t, 30, 1);
	await settle();
}

describe('a scrub that has left the loop', () => {
	it('still repaints the frame the map actually shows when its tiles decode', async () => {
		setRadarLoop(30);
		setShowRadarOnMap(true);
		const now = Date.now();
		slots = Array.from({ length: 7 }, (_, i) => frameSlot(now - (40 - 5 * i) * MIN));
		await fill();
		expect(radarLoop().frames.map((f) => f.t)).toEqual(slots);
		// On the ground: the pilot scrubs to the oldest frame and leaves it.
		setRadarShownFrame(slots[0]);
		// The next frame lands; the scrubbed one leaves the 30-minute window.
		const fresh = frameSlot(now - 5 * MIN);
		slots = [...slots, fresh];
		refreshRadar();
		ensureRadar(VIEW, Date.now());
		await settle();
		expect(radar.shownT).toBe(slots[0]);
		expect(radarLoop().frames.some((f) => f.t === slots[0])).toBe(false);
		// What the map draws (MapView's paint effect reads shownRadarFrame()).
		expect(shownRadarFrame()!.t).toBe(fresh);
		const seq = radar.paintSeq;
		for (let pass = 0; pass < 4; pass++) {
			ensureRadar(VIEW, Date.now());
			await settle();
		}
		expect(radarFrameHeld(fresh)).toBe(true);
		const painted = radar.paintSeq;
		// The tile is decoded (radarTileAt reads tier B without bumping).
		expect(radarTileAt(fresh, 30, 1)).not.toBeNull();
		// A tile of the SHOWN frame became ready: the paint must be told.
		expect(painted, 'paintSeq after the shown frame decoded').toBeGreaterThan(seq);
	});
});
