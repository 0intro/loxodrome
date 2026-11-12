/* The replay strip (state/replayStrip.svelte.ts, components/ReplayStrip.svelte;
 * docs/nav-live.md "The replay strip"): the replay's transport on the map, on
 * both layouts, up whenever a finished trace is loaded. Its close FOLDS it
 * into a chip and never unloads the trace (the trace profile reads it over
 * time too); the fold is scoped to the trace ARRAY, the terrain inhibit's
 * idiom, so a new trace shows its controls with no hook while a resumed
 * flight, appending in place, keeps the fold. Its rendering is read through
 * the server renderer (radarReadout's idiom: the node project runs no
 * effect), and the wiring the node project cannot drive is pinned at the
 * source. */

import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackPoint } from '$lib/nav/trace';

const events = vi.hoisted(() => ({ list: [] as { ms: number; kind: string; label: string }[] }));
vi.mock('$lib/state/navLive.svelte', async (orig) => ({
	...(await orig<typeof import('$lib/state/navLive.svelte')>()),
	replayEvents: () => events.list,
}));

const { nav, clearTrace, importTrace, restoreOuting, setPlayhead, togglePlay, traceReplayable } = await import(
	'$lib/state/navRecording.svelte'
);
const { ui } = await import('$lib/state/ui.svelte');
const strip = await import('$lib/state/replayStrip.svelte');
const ReplayStrip = (await import('$lib/components/ReplayStrip.svelte')).default;

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** 09:15:27Z, a wall-clock trace; `timeless` runs from 0 like a GPX without
 *  times. */
const T0 = Date.UTC(2026, 8, 30, 9, 15, 27);
function trace(n = 5, timeless = false): TrackPoint[] {
	return Array.from({ length: n }, (_, i) => ({
		lat: 48.8,
		lon: 2.6 + i / 100,
		altFt: 1000,
		timeMs: (timeless ? 0 : T0) + i * 60_000,
	}));
}

beforeEach(() => {
	ui.isMobile = true;
	strip.unfoldReplayStrip();
	clearTrace();
	nav.recording = false;
	events.list = [];
});

afterEach(() => {
	strip.unfoldReplayStrip();
	ui.isMobile = false;
	nav.recording = false;
	vi.useRealTimers();
});

describe('traceReplayable', () => {
	it('wants a span of time and no recording owning the playhead', () => {
		expect(traceReplayable()).toBe(false);
		importTrace(trace(1), 'msl');
		expect(traceReplayable()).toBe(false);
		importTrace(trace(3).map((p) => ({ ...p, timeMs: T0 })), 'msl');
		expect(traceReplayable()).toBe(false);
		importTrace(trace(3), 'msl');
		expect(traceReplayable()).toBe(true);
		nav.recording = true;
		expect(traceReplayable()).toBe(false);
	});
});

describe('the strip on its trace', () => {
	it('is up on any finished trace, on both layouts', () => {
		expect(strip.replayStripShown()).toBe(false);
		importTrace(trace(), 'msl');
		expect(strip.replayOpen()).toBe(true);
		expect(strip.replayStripShown()).toBe(true);
		ui.isMobile = false;
		expect(strip.replayStripShown()).toBe(true);
	});

	it('folds on its close, the trace and the playhead left as they were', () => {
		importTrace(trace(), 'msl');
		setPlayhead(T0 + 120_000);
		const points = nav.points;
		strip.foldReplayStrip();
		expect(strip.replayStripShown()).toBe(false);
		expect(strip.replayOpen()).toBe(true);
		expect(nav.points).toBe(points);
		expect(nav.points).toHaveLength(5);
		expect(nav.playheadMs).toBe(T0 + 120_000);
		strip.unfoldReplayStrip();
		expect(strip.replayStripShown()).toBe(true);
	});

	it('keeps its fold on the trace it was made on, a new one showing its controls', () => {
		importTrace(trace(), 'msl');
		strip.foldReplayStrip();
		importTrace(trace(), 'msl');
		expect(strip.replayStripShown()).toBe(true);

		strip.foldReplayStrip();
		restoreOuting(trace(), 'msl');
		expect(strip.replayStripShown()).toBe(true);

		strip.foldReplayStrip();
		clearTrace();
		expect(strip.replayOpen()).toBe(false);
		importTrace(trace(), 'msl');
		expect(strip.replayStripShown()).toBe(true);
	});

	it('stands down while a recording owns the playhead, and comes back at the stop as it was', () => {
		importTrace(trace(), 'msl');
		nav.recording = true;
		expect(strip.replayOpen()).toBe(false);
		expect(strip.replayStripShown()).toBe(false);
		nav.recording = false;
		expect(strip.replayStripShown()).toBe(true);
		// Folded before a resumed flight (same array): folded after it.
		strip.foldReplayStrip();
		nav.recording = true;
		nav.recording = false;
		expect(strip.replayStripShown()).toBe(false);
	});

	it('pauses the replay it drives when it folds', () => {
		vi.useFakeTimers();
		importTrace(trace(), 'msl');
		togglePlay();
		expect(nav.playing).toBe(true);
		strip.foldReplayStrip();
		expect(nav.playing).toBe(false);
	});

	it('holds follow loose only while its scrubber is held on a strip that is up', () => {
		importTrace(trace(), 'msl');
		strip.setReplayScrub(true);
		expect(strip.replayScrubbing()).toBe(true);
		strip.foldReplayStrip();
		expect(strip.replayScrubbing()).toBe(false);
		strip.unfoldReplayStrip();
		expect(strip.replayScrubbing()).toBe(false);
		strip.setReplayScrub(true);
		importTrace(trace(), 'msl');
		strip.setReplayScrub(false);
		expect(strip.replayScrubbing()).toBe(false);
	});
});

describe('the strip, rendered', () => {
	it('renders nothing with no replay open', () => {
		expect(render(ReplayStrip).body).not.toContain('replay-');
		importTrace(trace(), 'msl');
		nav.recording = true;
		expect(render(ReplayStrip).body).not.toContain('replay-');
	});

	it('folds into a chip carrying the playhead time, named by the words it shows', () => {
		importTrace(trace(), 'msl');
		setPlayhead(T0 + 60_000);
		strip.foldReplayStrip();
		const html = render(ReplayStrip).body;
		expect(html).not.toContain('class="replay-strip');
		const chip = /<button [^>]*class="foot-chip replay-chip[^"]*"[^>]*>([\s\S]*?)<\/button>/.exec(html);
		expect(chip).not.toBeNull();
		const text = (chip?.[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
		expect(text).toBe('Replay 09:16:27Z Show the replay controls');
	});

	it('names a timeless trace\'s chip by its elapsed time', () => {
		importTrace(trace(5, true), 'msl');
		setPlayhead(120_000);
		strip.foldReplayStrip();
		expect(render(ReplayStrip).body).toMatch(/class="chip-time[^"]*">2:00<\/span>/);
	});

	it('carries the transport, the time and a tick per event', () => {
		importTrace(trace(), 'msl');
		events.list = [
			{ ms: T0 + 60_000, kind: 'takeoff', label: '' },
			{ ms: T0 + 120_000, kind: 'waypoint', label: 'PMN' },
			{ ms: T0 + 150_000, kind: 'airspace', label: 'CTR PARIS' },
			{ ms: T0 + 180_000, kind: 'landing', label: '' },
		];
		const html = render(ReplayStrip).body;
		expect(html).toContain('role="group" aria-label="Replay"');
		for (const name of ['Play', 'Previous event', 'Next event', 'Hide the replay controls', 'Playback speed 4×']) {
			expect(html).toContain(`aria-label="${name}"`);
		}
		expect(html).toMatch(/<button[^>]*disabled[^>]*aria-label="Previous event"/);
		expect(html).toContain(`min="${T0}"`);
		expect(html).toContain(`max="${T0 + 240_000}"`);
		expect(html).toContain('aria-valuetext="09:15:27Z, 0:00 of 4:00"');
		expect(html).toContain('09:15:27Z</span>');
		expect(html.match(/class="tick /g)).toHaveLength(4);
		for (const kind of ['takeoff', 'waypoint', 'airspace', 'landing']) {
			expect(html).toContain(`class="tick ${kind}`);
		}
	});

	it('states no time of day for a trace without one', () => {
		importTrace(trace(5, true), 'msl');
		const html = render(ReplayStrip).body;
		expect(html).not.toContain('class="clock');
		expect(html).toContain('aria-valuetext="0:00 of 4:00"');
	});
});

describe('pinned at the source', () => {
	it('folds on its close, focus following, and never unloads the trace', () => {
		const src = read('src/lib/components/ReplayStrip.svelte');
		expect(src).toMatch(/async function fold\(\): Promise<void> \{\s*foldReplayStrip\(\);\s*await tick\(\);\s*chipEl\?\.focus\(\);/);
		expect(src).toMatch(/async function unfold\(\): Promise<void> \{\s*unfoldReplayStrip\(\);\s*await tick\(\);\s*closeEl\?\.focus\(\);/);
		expect(src).toMatch(/class="icon-btn close map-bar-close"\s*onclick=\{fold\}/);
		expect(src).toMatch(/class="foot-chip replay-chip no-print"[^>]*onclick=\{unfold\}/);
		expect(src).not.toContain('clearTrace');
		// A scrubber removed under a finger fires no pointerup.
		expect(src).toMatch(/\$effect\(\(\) => \{\s*if \(!shown\) \{\s*untrack\(\(\) => setReplayScrub\(false\)\);/);
	});

	it('is left alone by the flight gesture, a recording standing it down', () => {
		const src = read('src/lib/state/flightAction.svelte.ts');
		expect(src).not.toMatch(/ReplayStrip\(/);
	});

	it('is the flight app map chrome, and the NOTAM Viewer has none', () => {
		expect(read('src/lib/components/MapView.svelte')).toContain('<ReplayStrip />');
		expect(read('src/lib/components/NotamMapView.svelte')).not.toContain('ReplayStrip');
	});

	it('takes the very foot, under the radar strip (tests/mapFoot.spec.ts)', () => {
		const mapView = read('src/lib/components/MapView.svelte');
		const foot = mapView.slice(mapView.indexOf('<div class="map-foot'));
		expect(foot.indexOf('<RadarTimeline />')).toBeGreaterThan(0);
		expect(foot.indexOf('<ReplayStrip />')).toBeGreaterThan(foot.indexOf('<RadarTimeline />'));
		expect(foot.indexOf('<ReplayStrip />')).toBeLessThan(foot.indexOf('</div>'));
	});

	it('gives the band a job, and is the one transport on both layouts', () => {
		expect(read('src/lib/components/NavStrip.svelte')).toContain(
			'if (nav.recording || nav.playing || replayStripShown()) {',
		);
		// The trace profile's head transport only while the strip is folded.
		expect(read('src/lib/components/NavProfileModal.svelte')).toContain('{#if canReplay && !stripUp}');
		// No transport left in the Navigation tab, and no launcher on the
		// phone's Flight page.
		const tab = read('src/lib/components/tabs/NavigationTab.svelte');
		expect(tab).not.toContain('type="range"');
		expect(tab).not.toMatch(/onclick=\{togglePlay\}/);
		expect(read('src/lib/components/phone/PhonePages.svelte')).not.toMatch(/id === 'replay'/);
	});

	it('fits an opened trace clear of the strip and the band, on both layouts', () => {
		const open = read('src/lib/state/openFile.svelte.ts');
		const fn = open.slice(open.indexOf('async function applyTrace('), open.indexOf("\tshowTab('navigation');\n}"));
		expect(fn.match(/fitBoundsClear\(/g) ?? []).toHaveLength(2);
		expect(fn).not.toContain('.fitBounds(');
	});

	it('lands a trace opened on a phone on the map, the dispatcher handed the reveal', () => {
		// Handed in by App.svelte: the phone chrome carries the map layers,
		// which the dispatcher (reached by the account and sync modules)
		// must not import.
		expect(read('src/App.svelte')).toContain('onMount(() => setTraceReplayReveal(revealReplay));');
		const open = read('src/lib/state/openFile.svelte.ts');
		expect(open).not.toMatch(/(from|import\()\s*'\$lib\/state\/phoneNav/);
		expect(open).toMatch(/if \(ui\.isMobile && revealTraceReplay\) \{[\s\S]*?revealTraceReplay\(true\);\s*await tick\(\);/);
	});
});
