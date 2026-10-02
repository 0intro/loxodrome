/* The Navigation tab's live-position display and the band's height reading
 * persist (state/navRecording.svelte.ts, state/navStrip.svelte.ts,
 * docs/preferences.md): on Android a recording survives the WebView being
 * killed, and these used to come back at their defaults with it. Follow is
 * a mode, not a preference, and is never stored. The aircraft symbol moved
 * out of the crash-recovery trace doc, which a Clear removed with the trace,
 * into a key of its own, adopted from that doc once. Both modules seed
 * themselves at evaluation, hence the re-import per case. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage, type MemoryStorage } from './helpers/storage';

let ls: MemoryStorage;

beforeEach(() => {
	vi.resetModules();
	ls = memoryStorage();
	vi.stubGlobal('localStorage', ls);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const navMod = () => import('$lib/state/navRecording.svelte');

describe('the live-position display preferences', () => {
	it('persist away from their defaults and read back', async () => {
		const n = await navMod();
		n.setShowTrace(false);
		n.setVector(false);
		n.setContactMap(false);
		n.setPlaybackSpeed(8);
		n.setIconKind('glider');
		n.setFollow(false);
		expect(ls.dump()).toEqual({
			'loxodrome:nav-show-trace': 'off',
			'loxodrome:nav-vector': 'off',
			'loxodrome:nav-contact-map': 'off',
			'loxodrome:nav-playback-speed': '8',
			'loxodrome:nav-icon': 'glider',
		});
		vi.resetModules();
		const again = await navMod();
		expect(again.nav.showTrace).toBe(false);
		expect(again.nav.vector).toBe(false);
		expect(again.nav.contactMap).toBe(false);
		expect(again.nav.playbackSpeed).toBe(8);
		expect(again.nav.iconKind).toBe('glider');
		// A mode, back on at every load.
		expect(again.nav.follow).toBe(true);
	});

	it('refuse a replay speed the tab does not offer', async () => {
		const n = await navMod();
		n.setPlaybackSpeed(3);
		expect(n.nav.playbackSpeed).toBe(4);
		expect(ls.dump()).toEqual({});
	});

	it('pick a symbol without leaving an empty trace doc behind', async () => {
		const n = await navMod();
		n.setIconKind('helicopter');
		expect(ls.getItem('loxodrome:nav-trace')).toBeNull();
		n.setIconKind('plane');
		expect(ls.dump()).toEqual({});
	});

	it('keep the symbol through a Clear', async () => {
		const n = await navMod();
		n.setIconKind('glider');
		n.clearTrace();
		vi.resetModules();
		expect((await navMod()).nav.iconKind).toBe('glider');
	});

	it('adopt the symbol an older build left in the trace doc, once', async () => {
		ls.setItem(
			'loxodrome:nav-trace',
			JSON.stringify({ v: 1, iconKind: 'glider', recording: false, points: [] }),
		);
		const n = await navMod();
		expect(n.nav.iconKind).toBe('glider');
		expect(ls.getItem('loxodrome:nav-icon')).toBe('glider');
		// Once: the doc loses its copy in the same step, so the plane picked
		// back (the key removed, which is how the plane is stored) stays.
		expect(JSON.parse(ls.getItem('loxodrome:nav-trace') ?? '{}')).toEqual({
			v: 1,
			recording: false,
			points: [],
		});
		n.setIconKind('plane');
		vi.resetModules();
		expect((await navMod()).nav.iconKind).toBe('plane');
		expect(ls.getItem('loxodrome:nav-icon')).toBeNull();
	});

	it("store no key for an older build's copy of the plane, the default", async () => {
		ls.setItem(
			'loxodrome:nav-trace',
			JSON.stringify({ v: 1, iconKind: 'plane', recording: false, points: [] }),
		);
		const n = await navMod();
		expect(n.nav.iconKind).toBe('plane');
		expect(ls.getItem('loxodrome:nav-icon')).toBeNull();
	});

	it("let the key win over an older build's copy, and drop the copy", async () => {
		ls.setItem('loxodrome:nav-icon', 'helicopter');
		ls.setItem(
			'loxodrome:nav-trace',
			JSON.stringify({ v: 1, iconKind: 'glider', recording: false, points: [] }),
		);
		const n = await navMod();
		expect(n.nav.iconKind).toBe('helicopter');
		// Put back to the plane (Restore default settings, or Reset with the
		// briefing kept, which erases the key and leaves this doc): the old
		// copy must not come back at the next boot.
		n.restoreNavDisplayDefaults();
		vi.resetModules();
		expect((await navMod()).nav.iconKind).toBe('plane');
		expect(ls.dump()).toEqual({
			'loxodrome:nav-trace': JSON.stringify({ v: 1, recording: false, points: [] }),
		});
	});

	it('write a trace doc that carries no symbol', async () => {
		const n = await navMod();
		n.setIconKind('glider');
		const t0 = Date.now() - 3_600_000;
		n.restoreOuting(
			[
				{ lat: 48.6, lon: 2.4, timeMs: t0, altFt: 1500, speedKt: 90, trackDeg: 90, accuracyM: 5 },
				{ lat: 48.61, lon: 2.42, timeMs: t0 + 60_000, altFt: 1600, speedKt: 90, trackDeg: 90, accuracyM: 5 },
			],
			'msl',
		);
		const doc = JSON.parse(ls.getItem('loxodrome:nav-trace') ?? '{}') as Record<string, unknown>;
		expect(doc.points).toHaveLength(2);
		expect('iconKind' in doc).toBe(false);
		n.setIconKind('plane');
		vi.resetModules();
		expect((await navMod()).nav.iconKind).toBe('plane');
	});

	it('restore their defaults and leave no key', async () => {
		const n = await navMod();
		n.setShowTrace(false);
		n.setVector(false);
		n.setContactMap(false);
		n.setPlaybackSpeed(16);
		n.setIconKind('helicopter');
		n.restoreNavDisplayDefaults();
		expect(n.nav.showTrace && n.nav.vector && n.nav.contactMap).toBe(true);
		expect(n.nav.playbackSpeed).toBe(4);
		expect(n.nav.iconKind).toBe('plane');
		expect(ls.dump()).toEqual({});
	});
});

describe("the band's height reading", () => {
	it('is written by a tap only when the cell moves', async () => {
		const s = await import('$lib/state/navStrip.svelte');
		s.setStripAltRing('msa');
		// Only GPS ALT has data (the MSA lapsed, the cell shows the fallback):
		// the tap goes nowhere and the choice underneath stays.
		s.tapAltRing(0, [true, false, false]);
		expect(ls.getItem('loxodrome:nav-strip-alt')).toBe('msa');
		// With AGL to go to, it moves there and remembers it; on round.
		s.tapAltRing(0, [true, true, false]);
		expect(s.navStrip.altRing).toBe('agl');
		s.tapAltRing(1, [true, true, false]);
		expect(s.navStrip.altRing).toBe('gps');
		expect(ls.getItem('loxodrome:nav-strip-alt')).toBeNull();
	});

	it('persists, and the band restores to GPS ALT', async () => {
		const s = await import('$lib/state/navStrip.svelte');
		expect(s.navStrip.altRing).toBe('gps');
		s.setStripAltRing('agl');
		expect(ls.getItem('loxodrome:nav-strip-alt')).toBe('agl');
		vi.resetModules();
		const again = await import('$lib/state/navStrip.svelte');
		expect(again.navStrip.altRing).toBe('agl');
		again.setStripCollapsed(true);
		again.setStripOverflight(false);
		again.restoreNavStripDefaults();
		expect(again.navStrip).toMatchObject({
			collapsed: false,
			hidden: false,
			overflight: true,
			altRing: 'gps',
		});
		expect(ls.dump()).toEqual({});
	});
});
