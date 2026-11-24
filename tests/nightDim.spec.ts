/* The recording's automatic night (state/nightDim.svelte.ts) over the theme
 * choice (state/theme.svelte.ts). The trigger is edge-driven and never
 * fights the pilot: a choice made between the edges stands at dawn. And it
 * is never written into the pilot's choice: it rides a transient key of its
 * own, so one dusk flight no longer pins the theme for good (reproduced
 * before the change: the stored theme went from absent to 'night' at dusk,
 * then to 'day' at the stop). The edge state is module-wide, so every case
 * ends on a day edge. */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { applyAutoNight, nightDim, setNightDim } from '$lib/state/nightDim.svelte';
import { setThemePref, theme, toggleTheme } from '$lib/state/theme.svelte';
import { memoryStorage } from './helpers/storage';

const PARIS = { lat: 48.85, lon: 2.35 };
const NIGHT_MS = Date.parse('2026-06-21T23:30:00Z');
const NOON_MS = Date.parse('2026-06-21T12:00:00Z');

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('applyAutoNight theme edges', () => {
	it('sets night at dusk and hands the choice back at dawn', () => {
		setThemePref('day');
		applyAutoNight(PARIS.lat, PARIS.lon, NIGHT_MS);
		expect(theme.value).toBe('night');
		expect(theme.pref).toBe('day');
		applyAutoNight(PARIS.lat, PARIS.lon, NOON_MS);
		expect(theme.value).toBe('day');
	});

	it('never fights a manual override between the edges', () => {
		setThemePref('day');
		applyAutoNight(PARIS.lat, PARIS.lon, NIGHT_MS);
		expect(theme.value).toBe('night');
		// The toolbar's sun: the pilot prefers the day theme tonight. A later
		// reconcile with night still true is not an edge and leaves it alone.
		toggleTheme();
		expect(theme.value).toBe('day');
		applyAutoNight(PARIS.lat, PARIS.lon, NIGHT_MS + 60_000);
		expect(theme.value).toBe('day');
		applyAutoNight(PARIS.lat, PARIS.lon, NOON_MS);
		expect(theme.value).toBe('day');
	});

	it('leaves a mid-night choice standing at dawn, both directions', () => {
		// A night-theme user: dusk changes nothing on screen, they pick day
		// during the night, and dawn must NOT hand them night back.
		setThemePref('night');
		applyAutoNight(PARIS.lat, PARIS.lon, NIGHT_MS);
		expect(theme.value).toBe('night');
		setThemePref('day');
		expect(theme.value).toBe('day');
		applyAutoNight(PARIS.lat, PARIS.lon, NOON_MS);
		expect(theme.value).toBe('day');
	});

	it('ends the automatic night when the coordinates go away (recording stops)', () => {
		setThemePref('day');
		applyAutoNight(PARIS.lat, PARIS.lon, NIGHT_MS);
		expect(theme.value).toBe('night');
		applyAutoNight(null, null, NIGHT_MS + 1000);
		expect(theme.value).toBe('day');
	});

	it('keeps an automatic night through a pick of Auto', () => {
		setThemePref('day');
		applyAutoNight(PARIS.lat, PARIS.lon, NIGHT_MS);
		// Auto includes the automatic night: choosing it mid-flight does not
		// end the night the recording is in.
		setThemePref('auto');
		expect(theme.value).toBe('night');
		applyAutoNight(null, null, NIGHT_MS + 1000);
		// No device here: its appearance reads as day.
		expect(theme.value).toBe('day');
		expect(theme.pref).toBe('auto');
	});

	it("never writes the pilot's theme choice, only its own transient key", () => {
		for (const pref of ['auto', 'day'] as const) {
			const ls = memoryStorage();
			vi.stubGlobal('localStorage', ls);
			setThemePref(pref);
			const stored = ls.getItem('loxodrome:theme');
			const setItem = vi.spyOn(ls, 'setItem');
			const removeItem = vi.spyOn(ls, 'removeItem');
			applyAutoNight(PARIS.lat, PARIS.lon, NIGHT_MS);
			expect(ls.getItem('loxodrome:auto-night')).toBe('1');
			applyAutoNight(null, null, NIGHT_MS + 1000);
			expect(ls.getItem('loxodrome:auto-night')).toBeNull();
			const themeWrites = [...setItem.mock.calls, ...removeItem.mock.calls].filter(
				([key]) => key === 'loxodrome:theme',
			);
			expect(themeWrites).toEqual([]);
			expect(ls.getItem('loxodrome:theme')).toBe(stored);
			expect(theme.pref).toBe(pref);
			vi.unstubAllGlobals();
		}
	});
});

describe('setNightDim', () => {
	it('clamps to the choices range', () => {
		setNightDim(10);
		expect(nightDim.pct).toBe(40);
		setNightDim(120);
		expect(nightDim.pct).toBe(100);
		setNightDim(70);
		expect(nightDim.pct).toBe(70);
	});
});
