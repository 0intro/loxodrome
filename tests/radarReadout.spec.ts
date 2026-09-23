/* What the radar's readouts say (components/RadarTimeline.svelte, the hover
 * badge in MapView.svelte through state/radar.svelte.ts radarReadingFrame):
 *
 * - the age is printed floored, as the tiers compare it: rounded, 14.6 min
 *   read "15 min ago" in the fresh ink and 29.6 "30 min ago" over echoes
 *   the expiry had not withdrawn;
 * - the shown frame's tier is in words beside its ink, a title being out of
 *   reach on a strip that takes no pointer outside its controls;
 * - the polite live region carries the FEED's tier and the notices, never
 *   the shown frame's time and age, which the play loop changes twice a
 *   second;
 * - the badge's reading, taken at the last move of the pointer, is dropped
 *   once the map no longer draws it: under a resting pointer it outlived the
 *   feed's expiry and the layer's switch-off. */
import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RadarTimeline from '$lib/components/RadarTimeline.svelte';
import { display } from '$lib/state/display.svelte';
import { ui } from '$lib/state/ui.svelte';
import {
	ensureRadar,
	radarLoop,
	radarReadingFrame,
	resetRadarForTest,
	setRadarPlaying,
	setRadarShownFrame,
	setShowRadarOnMap,
	type RadarView,
} from '$lib/state/radar.svelte';
import { frameSlot, slotMs } from '$lib/weather/opera';
import { MIN, frameBody, indexResponse, stubStorage } from './helpers/radarProxy';

const VIEW: RadarView = { product: 'DBZH', tiles: [30], p: 1 };

async function settleFake(): Promise<void> {
	for (let i = 0; i < 12; i++) {
		await vi.advanceTimersByTimeAsync(15);
	}
}

/** The text inside the first element matching `open`, tags stripped. */
function textOf(html: string, open: RegExp): string | null {
	const m = open.exec(html);
	if (!m) {
		return null;
	}
	const rest = html.slice(m.index + m[0].length);
	const tag = /^<(\w+)/.exec(m[0])![1];
	const close = rest.indexOf(`</${tag}>`);
	return rest
		.slice(0, close)
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Four frames, the newest `newestAgeMin` old at the instant the index is
 *  served, all fetched. */
async function loadFrames(newestAgeMin: number): Promise<string[]> {
	// A 5-minute slot, then the clock `newestAgeMin` past it.
	const newest = Math.floor(Date.now() / (5 * MIN)) * 5 * MIN - 60 * MIN;
	vi.setSystemTime(newest + newestAgeMin * MIN);
	const slots = [3, 2, 1, 0].map((k) => frameSlot(newest - k * 5 * MIN));
	vi.stubGlobal('fetch', (input: string): Promise<Response> => {
		const url = new URL(input);
		if (url.pathname === '/opera/frames') {
			return Promise.resolve(indexResponse('DBZH', slots, Date.now()));
		}
		return Promise.resolve(
			new Response(frameBody(url.searchParams.get('tiles')!.split(',').map(Number), 'DBZH'), { status: 200 }),
		);
	});
	setShowRadarOnMap(true);
	for (let k = 0; k < 4; k++) {
		ensureRadar(VIEW, Date.now());
		await settleFake();
	}
	expect(slotMs(slots[3])).toBe(newest);
	return slots;
}

beforeEach(() => {
	vi.useFakeTimers();
	stubStorage();
	resetRadarForTest();
	display.liveWeather = true;
	ui.isMobile = false;
});

afterEach(async () => {
	setRadarPlaying(false);
	setShowRadarOnMap(false);
	await vi.advanceTimersByTimeAsync(2_000_000);
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('the strip', () => {
	it('prints the age floored, as the tiers compare it', async () => {
		await loadFrames(14.6);
		const readout = textOf(render(RadarTimeline).body, /<div class="readout[^"]*"[^>]*>/)!;
		expect(readout).toContain('14 min ago');
		expect(readout).not.toContain('15 min ago');
	});

	it('names the shown frame\'s tier in words, not by ink alone', async () => {
		await loadFrames(17);
		const readout = textOf(render(RadarTimeline).body, /<div class="readout[^"]*"[^>]*>/)!;
		expect(readout).toContain('Aging frame');
	});

	it('announces the feed\'s tier and the notices, never the frame the loop steps through', async () => {
		await loadFrames(6);
		setRadarPlaying(true);
		const live: string[] = [];
		for (const f of radarLoop().frames) {
			// What the 500 ms interval does, beat by beat.
			setRadarShownFrame(f.t);
			const html = render(RadarTimeline).body;
			expect(html.match(/aria-live="polite"/g) ?? []).toHaveLength(1);
			live.push(textOf(html, /<\w+ [^>]*aria-live="polite"[^>]*>/)!);
		}
		expect(live).toHaveLength(4);
		expect(new Set(live)).toEqual(new Set(['Recent frame']));
	});
});

describe('the play loop', () => {
	it('stops with the strip, whichever half of its gate went false', () => {
		// Effects do not run under the node test environment (the runes
		// compile for the server), so the two gates are pinned at the source:
		// Live weather turned off left the loop stepping every 500 ms behind
		// the hidden strip, to resume by itself when the weather came back.
		const src = readFileSync('src/lib/components/RadarTimeline.svelte', 'utf8');
		expect(src).toMatch(/if \(!shown && radar\.playing\) \{\s*setRadarPlaying\(false\);/);
		expect(src).toContain('if (!radar.playing || !shown) {');
	});
});

describe('the badge\'s reading', () => {
	it('stands on its frame only while the map draws the radar', async () => {
		const slots = await loadFrames(6);
		const newest = slots[3];
		expect(radarReadingFrame(newest)?.t).toBe(newest);
		expect(radarReadingFrame(slots[0])?.t).toBe(slots[0]);
		expect(radarReadingFrame('20200101T0000')).toBeNull();
		// The layer off: nothing drawn, nothing read.
		setShowRadarOnMap(false);
		expect(radarReadingFrame(newest)).toBeNull();
		setShowRadarOnMap(true);
		expect(radarReadingFrame(newest)?.t).toBe(newest);
		// The feed past its expiry: the echoes are withdrawn, and so is the
		// reading a resting pointer took before.
		vi.setSystemTime(Date.now() + 30 * MIN);
		expect(radarReadingFrame(newest)).toBeNull();
	});

	it('is what the badge prints, and a badge left with nothing to say is not drawn', () => {
		const src = readFileSync('src/lib/components/MapView.svelte', 'utf8');
		const at = src.indexOf('function tipLines(');
		const body = src.slice(at, src.indexOf('\n\t}\n', at));
		expect(body).toContain('radarReadingFrame(tip.radar.t)');
		expect(src).toContain('{#if windTip && windTipLines.length > 0}');
	});
});
