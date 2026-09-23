import { describe, it, expect } from 'vitest';
import { applyAutoNight, nightDim, setNightDim } from '$lib/state/nightDim.svelte';
import { setTheme, theme } from '$lib/state/theme.svelte';

const PARIS = { lat: 48.85, lon: 2.35 };
const NIGHT_MS = Date.parse('2026-06-21T23:30:00Z');
const NOON_MS = Date.parse('2026-06-21T12:00:00Z');

describe('applyAutoNight theme edges', () => {
	it('sets night at dusk, restores the remembered theme at dawn', () => {
		setTheme('day');
		applyAutoNight(PARIS.lat, PARIS.lon, NIGHT_MS);
		expect(theme.value).toBe('night');
		applyAutoNight(PARIS.lat, PARIS.lon, NOON_MS);
		expect(theme.value).toBe('day');
	});

	it('never fights a manual override between the edges', () => {
		setTheme('day');
		applyAutoNight(PARIS.lat, PARIS.lon, NIGHT_MS);
		expect(theme.value).toBe('night');
		// The pilot prefers the day theme tonight: a later reconcile with
		// night still true is not an edge and must leave it alone.
		setTheme('day');
		applyAutoNight(PARIS.lat, PARIS.lon, NIGHT_MS + 60_000);
		expect(theme.value).toBe('day');
		// Dawn restores what dusk remembered.
		applyAutoNight(PARIS.lat, PARIS.lon, NOON_MS);
		expect(theme.value).toBe('day');
	});

	it('leaves a mid-night manual choice standing at dawn, both directions', () => {
		// A night-theme user: dusk is a no-op, they pick day during the
		// night, and dawn must NOT hand them night back.
		setTheme('night');
		applyAutoNight(PARIS.lat, PARIS.lon, NIGHT_MS);
		expect(theme.value).toBe('night');
		setTheme('day');
		applyAutoNight(PARIS.lat, PARIS.lon, NOON_MS);
		expect(theme.value).toBe('day');
	});

	it('ends the automatic night when the coordinates go away (recording stops)', () => {
		setTheme('day');
		applyAutoNight(PARIS.lat, PARIS.lon, NIGHT_MS);
		expect(theme.value).toBe('night');
		applyAutoNight(null, null, NIGHT_MS + 1000);
		expect(theme.value).toBe('day');
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
