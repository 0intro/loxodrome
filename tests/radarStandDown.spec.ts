/* During a 429 stand-down the strip still follows the view
 * (state/radar.svelte.ts ensureRadar, radarFrameHeld, radarLoop). The
 * stand-down branch returned before the view's figures were written, and the
 * held flags and the loop tracked nothing a pan moves with nothing fetched:
 * panned to tiles not held, the readout still read the picture as whole over
 * a blank area, and panned off the composite it kept a two-frame loop and
 * its age, for a stand-down of up to 15 minutes. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { display } from '$lib/state/display.svelte';
import { ui } from '$lib/state/ui.svelte';
import {
	ensureRadar,
	radar,
	radarFrameHeld,
	radarLoop,
	refreshRadar,
	resetRadarForTest,
	setShowRadarOnMap,
	shownRadarFrame,
	type RadarView,
} from '$lib/state/radar.svelte';
import { frameSlot } from '$lib/weather/opera';
import { MIN, frameBody, indexResponse, stubStorage } from './helpers/radarProxy';

const A: RadarView = { product: 'DBZH', tiles: [30], p: 1 };
const B: RadarView = { product: 'DBZH', tiles: [38], p: 1 };

async function settleFake(): Promise<void> {
	for (let i = 0; i < 12; i++) {
		await vi.advanceTimersByTimeAsync(15);
	}
}

beforeEach(() => {
	vi.useFakeTimers();
	stubStorage();
	resetRadarForTest();
	display.liveWeather = true;
	ui.isMobile = false;
});

afterEach(async () => {
	setShowRadarOnMap(false);
	await vi.advanceTimersByTimeAsync(2_000_000);
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('a pan during a stand-down', () => {
	it('moves the loop, the held flags and the status with the view', async () => {
		const now = Date.now();
		const slots = [frameSlot(now - 10 * MIN), frameSlot(now - 5 * MIN)];
		let refuseIndex = false;
		vi.stubGlobal('fetch', (input: string): Promise<Response> => {
			const url = new URL(input);
			if (url.pathname === '/opera/frames') {
				return Promise.resolve(
					refuseIndex
						? new Response('busy', { status: 429, headers: { 'retry-after': '600' } })
						: indexResponse('DBZH', slots, Date.now()),
				);
			}
			return Promise.resolve(
				new Response(frameBody(url.searchParams.get('tiles')!.split(',').map(Number), 'DBZH'), { status: 200 }),
			);
		});
		setShowRadarOnMap(true);
		for (let k = 0; k < 3; k++) {
			ensureRadar(A, Date.now());
			await settleFake();
		}
		const shown = shownRadarFrame()!;
		expect(radarFrameHeld(shown.t)).toBe(true);
		// The index poll is refused for ten minutes: the stand-down begins
		// with every frame of A held.
		refuseIndex = true;
		refreshRadar();
		ensureRadar(A, Date.now());
		await settleFake();
		expect(radar.error?.()).toContain('busy');
		// Panned to tiles not held: the view's figures follow.
		const seq = radar.viewSeq;
		await vi.advanceTimersByTimeAsync(5 * MIN);
		ensureRadar(B, Date.now());
		expect(radar.viewSeq).toBe(seq + 1);
		expect(radarFrameHeld(shown.t)).toBe(false);
		expect({ loaded: radar.loaded, wanted: radar.wanted }).toEqual({ loaded: 0, wanted: 2 });
		// Off the composite: no loop to read a frame off, and it says so.
		ensureRadar(null, Date.now());
		expect(radarLoop().frames).toEqual([]);
		expect(radar.status).toBe('outside');
		expect(radar.wanted).toBe(0);
		// Back over it, the stand-down is said again, its own timer still the
		// only way back to the network.
		ensureRadar(A, Date.now());
		expect(radar.status).toBe('error');
		expect(radar.error?.()).toContain('busy');
		expect(radarLoop().frames).toHaveLength(2);
	});

	it('is what the strip\'s readers track, the view moving with nothing fetched', () => {
		// Reactivity is not observable under the node test environment (the
		// runes compile for the server), so the reads are pinned at the source.
		const src = readFileSync('src/lib/state/radar.svelte.ts', 'utf8');
		const body = (name: string): string => {
			const at = src.indexOf(`function ${name}(`);
			expect(at, name).toBeGreaterThan(0);
			return src.slice(at, src.indexOf('\n}\n', at));
		};
		expect(body('radarFrameHeld')).toContain('void radar.viewSeq;');
		expect(body('loopForView')).toContain('void radar.viewSeq;');
	});
});
