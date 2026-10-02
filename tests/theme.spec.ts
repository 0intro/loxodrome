/* The theme choice (state/theme.svelte.ts, docs/preferences.md): Auto follows
 * the device's light or dark appearance and is stored as the key's absence, a
 * pinned Day / Night is stored, the toolbar's toggle pins the opposite of the
 * theme on screen, and the recording's automatic night rides its own
 * transient key, restored at load by the flight app alone. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/storage';

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** A device whose appearance the case moves, listeners and all. */
function deviceAppearance(): { set: (dark: boolean) => void } {
	let dark = false;
	const listeners: (() => void)[] = [];
	vi.stubGlobal('window', {
		matchMedia: () => ({
			get matches() {
				return dark;
			},
			addEventListener: (_type: string, f: () => void) => listeners.push(f),
			removeEventListener: () => {},
		}),
	});
	return {
		set: (d: boolean) => {
			dark = d;
			for (const f of listeners) {
				f();
			}
		},
	};
}

describe('the theme choice', () => {
	it('stores a pinned theme and nothing for Auto', async () => {
		const { setThemePref, theme } = await import('$lib/state/theme.svelte');
		expect(theme.pref).toBe('auto');
		setThemePref('night');
		expect(localStorage.getItem('loxodrome:theme')).toBe('night');
		expect(theme.value).toBe('night');
		setThemePref('auto');
		expect(localStorage.getItem('loxodrome:theme')).toBeNull();
		expect(theme.value).toBe('day');
	});

	it('pins the opposite of the theme on screen from the toolbar', async () => {
		const { theme, toggleTheme } = await import('$lib/state/theme.svelte');
		toggleTheme();
		expect(theme.pref).toBe('night');
		toggleTheme();
		// Day is now a choice, not Auto: it stays day whatever the device does.
		expect(theme.pref).toBe('day');
		expect(localStorage.getItem('loxodrome:theme')).toBe('day');
	});

	it('follows the device while on Auto, and not once pinned', async () => {
		const device = deviceAppearance();
		const { setThemePref, theme, watchSystemTheme } = await import('$lib/state/theme.svelte');
		const stop = watchSystemTheme();
		expect(theme.value).toBe('day');
		device.set(true);
		expect(theme.value).toBe('night');
		device.set(false);
		expect(theme.value).toBe('day');
		setThemePref('day');
		device.set(true);
		expect(theme.value).toBe('day');
		stop();
	});

	it('reads the stored choice at load', async () => {
		localStorage.setItem('loxodrome:theme', 'night');
		const { theme } = await import('$lib/state/theme.svelte');
		expect(theme.pref).toBe('night');
		expect(theme.value).toBe('night');
	});

	it('resumes an automatic night at load in the flight app', async () => {
		localStorage.setItem('loxodrome:auto-night', '1');
		const { theme } = await import('$lib/state/theme.svelte');
		expect(theme.autoNight).toBe(true);
		expect(theme.value).toBe('night');
		expect(theme.pref).toBe('auto');
	});

	it("ignores the flight app's automatic night in the NOTAM Viewer", async () => {
		localStorage.setItem('loxodrome:auto-night', '1');
		(await import('$lib/state/appIdentity')).markNotamViewer();
		const { theme } = await import('$lib/state/theme.svelte');
		expect(theme.autoNight).toBe(false);
		expect(theme.value).toBe('day');
	});
});

/* The automatic night across a restart (state/nightDim.svelte.ts): the edge
 * state rides the transient key, so a WebView killed mid-night (a MIUI swipe,
 * the Android service recording on) or a reloaded web page resumes where the
 * night was, neither firing its dusk again over the pilot's pick nor ending
 * it before the flight is back. */
describe('the automatic night across a restart', () => {
	const PARIS = { lat: 48.85, lon: 2.35 };
	const NIGHT_MS = Date.parse('2026-06-21T23:30:00Z');
	const NOON_MS = Date.parse('2026-06-22T12:00:00Z');

	/** What the crash-recovery copy holds when the app dies mid-recording. */
	function crashDoc(): string {
		return JSON.stringify({
			v: 1,
			altDatum: 'msl',
			recording: true,
			points: [
				{ lat: 48.6, lon: 2.4, timeMs: NIGHT_MS - 120_000, altFt: 1500, speedKt: 95 },
				{ lat: PARIS.lat, lon: PARIS.lon, timeMs: NIGHT_MS - 60_000, altFt: 1500, speedKt: 95 },
			],
		});
	}

	async function boot() {
		const theme = await import('$lib/state/theme.svelte');
		const night = await import('$lib/state/nightDim.svelte');
		const nav = await import('$lib/state/navRecording.svelte');
		return { ...theme, ...night, ...nav };
	}

	it('keeps a Day picked mid-night through a restart', async () => {
		let m = await boot();
		m.applyAutoNight(PARIS.lat, PARIS.lon, NIGHT_MS);
		expect(m.theme.value).toBe('night');
		m.toggleTheme();
		expect(m.theme.value).toBe('day');
		// Past dusk still, the night held by the pick: not in force, so the
		// pre-paint paints the pick.
		expect(localStorage.getItem('loxodrome:auto-night')).toBe('held');
		vi.resetModules();
		m = await boot();
		expect(m.theme.value).toBe('day');
		// The recording resumed, still night: no second dusk over the pick.
		m.applyAutoNight(PARIS.lat, PARIS.lon, NIGHT_MS + 120_000);
		expect(m.theme.value).toBe('day');
		expect(m.theme.pref).toBe('day');
		// Dawn ends the edge, and the held key with it.
		m.applyAutoNight(PARIS.lat, PARIS.lon, NOON_MS);
		expect(localStorage.getItem('loxodrome:auto-night')).toBeNull();
	});

	it('holds a restored night over an interrupted flight until dawn there', async () => {
		localStorage.setItem('loxodrome:auto-night', '1');
		localStorage.setItem('loxodrome:nav-trace', crashDoc());
		const m = await boot();
		expect(m.nav.interrupted).toBe(true);
		const at = m.autoNightFix(NIGHT_MS);
		expect(at).toEqual({ lat: PARIS.lat, lon: PARIS.lon, canStart: false });
		// The first reconcile, the recording not back (the web reload, or
		// the WebView ahead of the service's own reconcile): night stays.
		m.applyAutoNight(at?.lat ?? null, at?.lon ?? null, NIGHT_MS, at?.canStart);
		expect(m.theme.value).toBe('night');
		// Dawn at the last fix ends it.
		m.applyAutoNight(at?.lat ?? null, at?.lon ?? null, NOON_MS, at?.canStart);
		expect(m.theme.value).toBe('day');
		expect(localStorage.getItem('loxodrome:auto-night')).toBeNull();
	});

	it('never starts a night over an interrupted flight', async () => {
		localStorage.setItem('loxodrome:nav-trace', crashDoc());
		const m = await boot();
		const at = m.autoNightFix(NIGHT_MS);
		expect(at?.canStart).toBe(false);
		m.applyAutoNight(at?.lat ?? null, at?.lon ?? null, NIGHT_MS, at?.canStart);
		expect(m.theme.value).toBe('day');
		expect(localStorage.getItem('loxodrome:auto-night')).toBeNull();
	});

	it('lets a flight go once it is older than an outing, night or not', async () => {
		// The browser went away mid-night and the app is opened again the
		// NEXT evening: a dawn passed while nothing watched, and the flight
		// is long over, so its night is no longer the one outside.
		localStorage.setItem('loxodrome:auto-night', '1');
		localStorage.setItem('loxodrome:nav-trace', crashDoc());
		const m = await boot();
		expect(m.nav.interrupted).toBe(true);
		const nextNight = NIGHT_MS + 24 * 3_600_000;
		m.reconcileAutoNight(m.autoNightFix(nextNight), nextNight);
		expect(m.theme.value).toBe('day');
		expect(localStorage.getItem('loxodrome:auto-night')).toBeNull();
		// The same night, within the outing, it still holds.
		localStorage.setItem('loxodrome:auto-night', '1');
		vi.resetModules();
		const again = await boot();
		again.reconcileAutoNight(again.autoNightFix(NIGHT_MS + 3_600_000), NIGHT_MS + 3_600_000);
		expect(again.theme.value).toBe('night');
	});

	it('ends the hold once the flight is put away', async () => {
		localStorage.setItem('loxodrome:auto-night', '1');
		localStorage.setItem('loxodrome:nav-trace', crashDoc());
		const m = await boot();
		expect(m.autoNightFix(NIGHT_MS)).not.toBeNull();
		m.clearTrace();
		expect(m.nav.interrupted).toBe(false);
		expect(m.autoNightFix(NIGHT_MS)).toBeNull();
		m.applyAutoNight(null, null, NIGHT_MS);
		expect(m.theme.value).toBe('day');
	});

	it('knows nothing while a recording has no fix yet', async () => {
		const m = await boot();
		m.nav.recording = true;
		expect(m.autoNightFix()).toBeUndefined();
		m.nav.recording = false;
		expect(m.autoNightFix()).toBeNull();
	});

	it('ends a night a clean stop left behind at the first reconcile', async () => {
		// The app went away after the stop and before its reconcile: the key
		// says night, the crash copy says the flight is over.
		localStorage.setItem('loxodrome:auto-night', '1');
		localStorage.setItem(
			'loxodrome:nav-trace',
			JSON.stringify({ ...JSON.parse(crashDoc()), recording: false }),
		);
		const m = await boot();
		expect(m.nav.points.length).toBe(2);
		expect(m.nav.interrupted).toBe(false);
		expect(m.autoNightFix(NIGHT_MS)).toBeNull();
		m.reconcileAutoNight(m.autoNightFix(NIGHT_MS), NIGHT_MS);
		expect(m.theme.value).toBe('day');
	});

	it('reads an automatic-night value it never writes as no night, then or later', async () => {
		localStorage.setItem('loxodrome:auto-night', 'x');
		const m = await boot();
		expect(m.pastDuskAtLoad).toBe(false);
		expect(m.theme.autoNight).toBe(false);
		// Nothing held either: Auto picked after a pin takes no night back.
		m.setThemePref('day');
		m.setThemePref('auto');
		expect(m.theme.autoNight).toBe(false);
	});

	it('reads a held night as ended at load', async () => {
		localStorage.setItem('loxodrome:auto-night', 'held');
		localStorage.setItem('loxodrome:theme', 'day');
		const m = await boot();
		expect(m.theme.autoNight).toBe(false);
		expect(m.theme.value).toBe('day');
		expect(m.pastDuskAtLoad).toBe(true);
	});
});

describe('Auto picked again past dusk', () => {
	const PARIS = { lat: 48.85, lon: 2.35 };
	const NIGHT_MS = Date.parse('2026-06-21T23:30:00Z');
	const NOON_MS = Date.parse('2026-06-22T12:00:00Z');

	async function boot() {
		const theme = await import('$lib/state/theme.svelte');
		const night = await import('$lib/state/nightDim.svelte');
		return { ...theme, ...night };
	}

	it('takes the automatic night back, the night being part of Auto', async () => {
		const m = await boot();
		m.applyAutoNight(PARIS.lat, PARIS.lon, NIGHT_MS);
		m.toggleTheme();
		expect(m.theme.value).toBe('day');
		m.setThemePref('auto');
		expect(m.theme.value).toBe('night');
		expect(m.theme.autoNight).toBe(true);
		expect(localStorage.getItem('loxodrome:auto-night')).toBe('1');
		expect(localStorage.getItem('loxodrome:theme')).toBeNull();
		// Dawn still ends it.
		m.applyAutoNight(PARIS.lat, PARIS.lon, NOON_MS);
		expect(m.theme.value).toBe('day');
	});

	it('takes it back after a restart too', async () => {
		localStorage.setItem('loxodrome:auto-night', 'held');
		localStorage.setItem('loxodrome:theme', 'day');
		const m = await boot();
		m.setThemePref('auto');
		expect(m.theme.value).toBe('night');
		expect(localStorage.getItem('loxodrome:auto-night')).toBe('1');
	});

	it('does nothing before dusk or after dawn', async () => {
		const m = await boot();
		m.setThemePref('day');
		m.setThemePref('auto');
		expect(m.theme.autoNight).toBe(false);
		m.applyAutoNight(PARIS.lat, PARIS.lon, NIGHT_MS);
		m.setThemePref('night');
		m.applyAutoNight(PARIS.lat, PARIS.lon, NOON_MS);
		m.setThemePref('auto');
		expect(m.theme.autoNight).toBe(false);
		expect(localStorage.getItem('loxodrome:auto-night')).toBeNull();
	});
});

/* Every path that ends an interrupted flight clears it before its own flush,
 * or the crash copy (which keeps saying recording while the flag holds)
 * would make every later boot take a finished flight for one in progress:
 * never parked or filed, and holding the automatic night after the stop. */
describe('what ends an interrupted flight', () => {
	const NIGHT_MS = Date.parse('2026-06-21T23:30:00Z');

	function crash(): void {
		localStorage.setItem(
			'loxodrome:nav-trace',
			JSON.stringify({
				v: 1,
				altDatum: 'msl',
				recording: true,
				points: [
					{ lat: 48.6, lon: 2.4, timeMs: NIGHT_MS - 120_000, altFt: 1500, speedKt: 95 },
					{ lat: 48.85, lon: 2.35, timeMs: NIGHT_MS - 60_000, altFt: 1500, speedKt: 95 },
				],
			}),
		);
	}

	const points = [
		{ lat: 48.7, lon: 2.3, timeMs: NIGHT_MS - 600_000, altFt: 900, speedKt: 80, trackDeg: 90, accuracyM: 5 },
		{ lat: 48.71, lon: 2.32, timeMs: NIGHT_MS - 540_000, altFt: 950, speedKt: 80, trackDeg: 90, accuracyM: 5 },
	];

	const cases: [string, (n: typeof import('$lib/state/navRecording.svelte')) => void][] = [
		['the stop', (n) => n.stopRecording()],
		['an import', (n) => n.importTrace(points, 'msl')],
		['an outing loaded back', (n) => n.restoreOuting(points, 'msl')],
	];

	for (const [name, end] of cases) {
		it(`is ended by ${name}`, async () => {
			crash();
			const n = await import('$lib/state/navRecording.svelte');
			expect(n.nav.interrupted).toBe(true);
			expect(n.autoNightFix(NIGHT_MS)).not.toBeNull();
			end(n);
			expect(n.nav.interrupted).toBe(false);
			expect(n.autoNightFix(NIGHT_MS)).toBeNull();
			const doc = JSON.parse(localStorage.getItem('loxodrome:nav-trace') ?? '{}') as { recording?: unknown };
			expect(doc.recording).toBe(false);
		});
	}
});

describe("App's reconcile of the automatic night", () => {
	const PARIS = { lat: 48.85, lon: 2.35 };
	const NIGHT_MS = Date.parse('2026-06-21T23:30:00Z');
	const NOON_MS = Date.parse('2026-06-22T12:00:00Z');
	/** Day in Paris (civil dusk there is about 20:40Z), and night at the
	 *  position with the two coordinates swapped (2.35 N, 48.85 E). */
	const EVENING_MS = Date.parse('2026-06-21T19:30:00Z');

	async function boot() {
		const theme = await import('$lib/state/theme.svelte');
		const night = await import('$lib/state/nightDim.svelte');
		const nav = await import('$lib/state/navRecording.svelte');
		return { ...theme, ...night, ...nav };
	}

	/** A recording with a live fix over Paris. */
	function flying(m: Awaited<ReturnType<typeof boot>>): void {
		m.nav.recording = true;
		m.nav.lastFix = { lat: PARIS.lat, lon: PARIS.lon, timeMs: NIGHT_MS, altFt: 1500, speedKt: 95 };
	}

	it('judges the night at the live pose, which may start it', async () => {
		const m = await boot();
		flying(m);
		expect(m.autoNightFix(NIGHT_MS)).toEqual({ lat: PARIS.lat, lon: PARIS.lon, canStart: true });
		m.reconcileAutoNight(m.autoNightFix(EVENING_MS), EVENING_MS);
		expect(m.theme.value).toBe('day');
		m.reconcileAutoNight(m.autoNightFix(NIGHT_MS), NIGHT_MS);
		expect(m.theme.value).toBe('night');
		expect(localStorage.getItem('loxodrome:auto-night')).toBe('1');
	});

	it('lets a recording resumed over an interrupted flight start it too', async () => {
		const m = await boot();
		flying(m);
		m.nav.interrupted = true;
		expect(m.autoNightFix(NIGHT_MS)).toEqual({ lat: PARIS.lat, lon: PARIS.lon, canStart: true });
		m.reconcileAutoNight(m.autoNightFix(NIGHT_MS), NIGHT_MS);
		expect(m.theme.value).toBe('night');
	});

	it("passes an interrupted fix's refusal to start through", async () => {
		const m = await boot();
		m.reconcileAutoNight({ ...PARIS, canStart: false }, NIGHT_MS);
		expect(m.theme.value).toBe('day');
		expect(localStorage.getItem('loxodrome:auto-night')).toBeNull();
	});

	it('changes nothing while the pose is unknown, and ends the night without a flight', async () => {
		localStorage.setItem('loxodrome:auto-night', '1');
		const { theme } = await import('$lib/state/theme.svelte');
		const { reconcileAutoNight } = await import('$lib/state/nightDim.svelte');
		// A recording with no fix yet: even at noon nothing is known.
		reconcileAutoNight(undefined, NOON_MS);
		expect(theme.value).toBe('night');
		// An interrupted flight's fix at night holds it; no flight ends it.
		reconcileAutoNight({ lat: PARIS.lat, lon: PARIS.lon, canStart: false }, Date.parse('2026-06-21T23:30:00Z'));
		expect(theme.value).toBe('night');
		reconcileAutoNight(null, NOON_MS);
		expect(theme.value).toBe('day');
	});
});
