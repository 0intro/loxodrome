/* Every Settings-tab preference persists (state/display.svelte.ts,
 * docs/preferences.md), the NOTAM-marker toggles and the cursor coordinates
 * included, which reset on every reload before: on Android, whenever the OS
 * had killed the app. The booleans share one table and one setter; a key
 * exists only while its flag is away from the default, and the keys that
 * predate the table keep reading back what they stored. The module seeds
 * itself at evaluation, hence the re-import per case. */

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

const NEW_FLAGS = [
	['typeIcons', 'loxodrome:notam-type-icons', true],
	['qlineRadius', 'loxodrome:notam-qline-radius', true],
	['qlineMarkers', 'loxodrome:notam-qline-markers', true],
	['hideAirportNotamMarkers', 'loxodrome:hide-airport-notam-markers', true],
	['affectedAirspaces', 'loxodrome:affected-airspaces', true],
	['showInAirspaces', 'loxodrome:show-in-airspaces', false],
	['cursorCoords', 'loxodrome:cursor-coords', true],
	['lockRouteInFlight', 'loxodrome:route-lock-in-flight', true],
] as const;

describe('the display flags', () => {
	it('store a flag away from its default, and nothing at it', async () => {
		const { display, setDisplayFlag } = await import('$lib/state/display.svelte');
		for (const [flag, key, def] of NEW_FLAGS) {
			expect(display[flag], flag).toBe(def);
			setDisplayFlag(flag, !def);
			expect(display[flag]).toBe(!def);
			expect(ls.getItem(key), key).toBe(def ? 'off' : 'on');
			setDisplayFlag(flag, def);
			expect(ls.getItem(key), key).toBeNull();
		}
	});

	it('read a stored flag back at load', async () => {
		for (const [, key, def] of NEW_FLAGS) {
			ls.setItem(key, def ? 'off' : 'on');
		}
		const { display } = await import('$lib/state/display.svelte');
		for (const [flag, , def] of NEW_FLAGS) {
			expect(display[flag], flag).toBe(!def);
		}
	});

	it('read the tokens older keys stored, unchanged', async () => {
		ls.setItem('loxodrome:live-weather', 'off');
		ls.setItem('loxodrome:profile-all-airspaces', 'off');
		ls.setItem('loxodrome:flight-fullscreen', 'off');
		ls.setItem('loxodrome:trace-convert-imported', '1');
		const { display, setConvertImportedTraces, setLiveWeather } = await import(
			'$lib/state/display.svelte'
		);
		expect(display.liveWeather).toBe(false);
		expect(display.profileAllAirspaces).toBe(false);
		expect(display.flightFullscreen).toBe(false);
		expect(display.convertImportedTraces).toBe(true);
		setConvertImportedTraces(false);
		expect(ls.getItem('loxodrome:trace-convert-imported')).toBeNull();
		setConvertImportedTraces(true);
		expect(ls.getItem('loxodrome:trace-convert-imported')).toBe('1');
		setLiveWeather(true);
		expect(ls.getItem('loxodrome:live-weather')).toBeNull();
	});

	it('read anything else stored as the default', async () => {
		ls.setItem('loxodrome:notam-type-icons', 'maybe');
		ls.setItem('loxodrome:show-in-airspaces', 'off');
		const { display } = await import('$lib/state/display.svelte');
		expect(display.typeIcons).toBe(true);
		expect(display.showInAirspaces).toBe(false);
	});
});

describe('restoreDisplayDefaults', () => {
	it('puts every field back and leaves no key behind', async () => {
		const fresh = await import('$lib/state/display.svelte');
		const defaults = JSON.parse(JSON.stringify(fresh.display)) as unknown;
		vi.resetModules();
		for (const [, key, def] of NEW_FLAGS) {
			ls.setItem(key, def ? 'off' : 'on');
		}
		ls.setItem('loxodrome:live-weather', 'off');
		ls.setItem('loxodrome:gps-alt-datum', 'msl');
		ls.setItem('loxodrome:sofia-lang', 'fr');
		ls.setItem('loxodrome:trace-export-format', 'igc');
		ls.setItem('loxodrome:layers-control', 'map');
		ls.setItem('loxodrome:toolbar-in-flight', 'folded');
		ls.setItem('loxodrome:trace-convert-imported', '1');
		const { display, restoreDisplayDefaults } = await import('$lib/state/display.svelte');
		expect(JSON.parse(JSON.stringify(display))).not.toEqual(defaults);
		restoreDisplayDefaults();
		expect(JSON.parse(JSON.stringify(display))).toEqual(defaults);
		expect(ls.dump()).toEqual({});
	});

	it('touches only the fields it is given', async () => {
		ls.setItem('loxodrome:notam-type-icons', 'off');
		ls.setItem('loxodrome:gps-alt-datum', 'msl');
		const { display, restoreDisplayDefaults } = await import('$lib/state/display.svelte');
		restoreDisplayDefaults(['typeIcons']);
		expect(display.typeIcons).toBe(true);
		expect(display.gpsAltDatum).toBe('msl');
		expect(ls.dump()).toEqual({ 'loxodrome:gps-alt-datum': 'msl' });
	});
});
