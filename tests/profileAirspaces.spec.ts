/* Unit tests for the global "vertical profiles: all airspaces vs only those on
 * the map" filter (state/profile.svelte.ts). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Airspace, VerticalLimit } from '$lib/data/airspaces';
import { fromTriple } from '$lib/vertical/limits';
import { layers } from '$lib/state/layers.svelte';
import { display, setProfileAllAirspaces } from '$lib/state/display.svelte';
import { filter } from '$lib/state/filter.svelte';
import { profileAirspaces, airspaceShownOnMap } from '$lib/state/profile.svelte';

function mk(
	key: string,
	category: Airspace['category'],
	source: Airspace['source'],
	lower: VerticalLimit | null = null,
	upper: VerticalLimit | null = null,
): Airspace {
	return {
		key,
		category,
		source,
		lower,
		upper,
		vLower: fromTriple(lower),
		vUpper: fromTriple(upper),
	} as unknown as Airspace;
}

beforeEach(() => {
	// App defaults: profiles show all; altitude filter off; every category
	// hidden; every publisher on.
	display.profileAllAirspaces = true;
	filter.altitude = { enabled: false, floor: 0, ceiling: 60000 };
	for (const k of Object.keys(layers.airspace) as (keyof typeof layers.airspace)[]) {
		layers.airspace[k] = false;
	}
	for (const k of Object.keys(layers.publisher) as (keyof typeof layers.publisher)[]) {
		layers.publisher[k] = true;
	}
});

describe('airspaceShownOnMap', () => {
	it('requires both the category and the publisher to be enabled', () => {
		layers.airspace.controlled = true;
		expect(airspaceShownOnMap(mk('a', 'controlled', 'fr'))).toBe(true);
		// category toggled off
		expect(airspaceShownOnMap(mk('b', 'restricted', 'fr'))).toBe(false);
		// publisher toggled off
		layers.publisher.uk = false;
		expect(airspaceShownOnMap(mk('c', 'controlled', 'uk'))).toBe(false);
	});
});

describe('profileAirspaces', () => {
	const list = [
		mk('a', 'controlled', 'fr'),
		mk('b', 'restricted', 'fr'),
		mk('c', 'controlled', 'uk'),
	];

	it('returns the full list when the global toggle is on, even if hidden', () => {
		display.profileAllAirspaces = true;
		expect(profileAirspaces(list).map((a) => a.key)).toEqual(['a', 'b', 'c']);
	});

	it('returns only on-map airspaces when the toggle is off', () => {
		display.profileAllAirspaces = false;
		layers.airspace.controlled = true; // 'a' (fr) and 'c' (uk) category on
		layers.publisher.uk = false; // but 'c' publisher off
		expect(profileAirspaces(list).map((a) => a.key)).toEqual(['a']);
	});

	it('returns nothing when the toggle is off and all categories are hidden', () => {
		display.profileAllAirspaces = false;
		expect(profileAirspaces(list)).toHaveLength(0);
	});

	it('always excludes aerial-activity zones, even with the toggle on', () => {
		display.profileAllAirspaces = true;
		const withActivity = [
			mk('a', 'controlled', 'fr'),
			mk('act', 'activity', 'fr'),
			mk('b', 'restricted', 'fr'),
		];
		expect(profileAirspaces(withActivity).map((a) => a.key)).toEqual(['a', 'b']);
	});
});

describe('profileAirspaces altitude filter', () => {
	const below = mk('below', 'controlled', 'fr', ['', '0', ''], ['', '50', 'FL']); // 0-5000 ft
	const within = mk('within', 'controlled', 'fr', ['', '150', 'FL'], ['', '250', 'FL']); // 15000-25000 ft
	const noLimits = mk('noLimits', 'controlled', 'fr'); // missing vertical data

	it('excludes airspaces outside the active altitude band', () => {
		filter.altitude = { enabled: true, floor: 10000, ceiling: 20000 }; // FL100-FL200
		const keys = profileAirspaces([below, within, noLimits]).map((a) => a.key);
		expect(keys).toContain('within'); // overlaps the band
		expect(keys).toContain('noLimits'); // missing vertical data is never hidden
		expect(keys).not.toContain('below'); // entirely below the band
	});

	it('ignores the band when the altitude filter is disabled', () => {
		filter.altitude = { enabled: false, floor: 10000, ceiling: 20000 };
		expect(profileAirspaces([below, within]).map((a) => a.key)).toEqual(['below', 'within']);
	});

	it('applies on top of the on-map filter', () => {
		display.profileAllAirspaces = false;
		layers.airspace.controlled = true;
		filter.altitude = { enabled: true, floor: 10000, ceiling: 20000 };
		// below: out of band; within: in band and on the map.
		expect(profileAirspaces([below, within]).map((a) => a.key)).toEqual(['within']);
	});
});

/* The scope has a control in every profile chart's header, so it is flipped
 * often enough that a reload must not undo it. The INITIAL read is not testable
 * here (the module initialises before any stub can land, the same gap
 * initialLiveWeather has); the round trip is. */
describe('setProfileAllAirspaces', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('stores only the non-default off, and clears it again', () => {
		const store = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			removeItem: (k: string) => void store.delete(k),
		});

		setProfileAllAirspaces(false);
		expect(display.profileAllAirspaces).toBe(false);
		expect(store.get('loxodrome:profile-all-airspaces')).toBe('off');

		setProfileAllAirspaces(true);
		expect(display.profileAllAirspaces).toBe(true);
		expect(store.has('loxodrome:profile-all-airspaces')).toBe(false);
	});

	it('drives which airspaces a profile plots', () => {
		layers.airspace.controlled = true;
		const on = mk('on', 'controlled', 'fr');
		const off = mk('off', 'restricted', 'fr');
		setProfileAllAirspaces(true);
		expect(profileAirspaces([on, off]).map((a) => a.key)).toEqual(['on', 'off']);
		setProfileAllAirspaces(false);
		expect(profileAirspaces([on, off]).map((a) => a.key)).toEqual(['on']);
	});
});
