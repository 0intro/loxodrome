/* Unit tests for the global "vertical profiles: all airspaces vs only those on
 * the map" filter (state/profile.svelte.ts). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Airspace, VerticalLimit } from '$lib/data/airspaces';
import { fromTriple } from '$lib/vertical/limits';
import { layers } from '$lib/state/layers.svelte';
import { display, setProfileAllAirspaces } from '$lib/state/display.svelte';
import { filter } from '$lib/state/filter.svelte';
import { profileScope, airspaceShownOnMap, setRouteOnlyAirspaces } from '$lib/state/profile.svelte';
import { AIRSPACE_FILTER_GROUPS } from '$lib/data/airspaces';
import {
	profileAirspaceGroups,
	PROFILE_AIRSPACE_DEFAULTS,
	profileAirspaceGroupsRestrict,
	setProfileAirspaceGroup,
} from '$lib/state/profileAirspaceFilter.svelte';

/** What the charts plot: the scope's shown set. */
const profileAirspaces = (list: Airspace[]): Airspace[] => profileScope(list).shown;

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
	// To the DEFAULTS, not to `true`: the activity row ships off, so
	// forcing every row on is itself a departure the emphasis would see.
	for (const g of AIRSPACE_FILTER_GROUPS) {
		setProfileAirspaceGroup(g, PROFILE_AIRSPACE_DEFAULTS[g]);
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

	it('follows "Show only route airspaces" while the map applies it', () => {
		// With the filter on, the map draws exactly the route's airspaces,
		// every category forced on: the category toggles alone counted the
		// wrong ones as "not drawn on the map".
		layers.airspace.controlled = true;
		layers.airspace.restricted = false;
		layers.publisher.uk = false;
		const onRoute = mk('r', 'restricted', 'fr');
		const offRoute = mk('o', 'controlled', 'fr');
		setRouteOnlyAirspaces(new Set([onRoute.key, mk('u', 'restricted', 'uk').key]));
		try {
			expect(airspaceShownOnMap(onRoute)).toBe(true);
			expect(airspaceShownOnMap(offRoute)).toBe(false);
			// The publisher still gates, as it does on the map.
			expect(airspaceShownOnMap(mk('u', 'restricted', 'uk'))).toBe(false);
		} finally {
			setRouteOnlyAirspaces(null);
		}
		expect(airspaceShownOnMap(offRoute)).toBe(true);
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

	it('excludes aerial-activity zones by default, the row shipping off', () => {
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

describe('profileAirspaces airspace filter rows', () => {
	/** A row as the loader stamps it, with the type and class the rows read. */
	function kind(key: string, type: string, airClass: string, category: Airspace['category']) {
		return { ...mk(key, category, 'fr'), type, airClass };
	}

	const list = [
		kind('tma', 'TMA', 'D', 'controlled'),
		kind('lta', 'LTA', 'E', 'controlled'),
		kind('r', 'R', '', 'restricted'),
		kind('p', 'P', '', 'restricted'),
		kind('fir', 'FIR', 'A', 'fir'),
	];

	it('every row on is a no-op', () => {
		expect(profileAirspaces(list).map((a) => a.key)).toEqual(['tma', 'lta', 'r', 'p', 'fir']);
		expect(profileAirspaceGroupsRestrict()).toBe(false);
	});

	it('a row off drops its airspaces and only those', () => {
		setProfileAirspaceGroup('classD', false);
		expect(profileAirspaces(list).map((a) => a.key)).toEqual(['lta', 'r', 'p', 'fir']);
		expect(profileAirspaceGroupsRestrict()).toBe(true);
	});

	it('keeps only a prohibited area with every row off', () => {
		// The FIR answers to its own row now, so a column profile CAN hide
		// the frame; the prohibited area still answers to none.
		for (const g of AIRSPACE_FILTER_GROUPS) {
			setProfileAirspaceGroup(g, false);
		}
		expect(profileAirspaces(list).map((a) => a.key)).toEqual(['p']);
	});

	it('hides the background through its own row, not through a class row', () => {
		// The FIR here carries class A. Unticking Class A must not take the
		// frame with it; only the FIR row may.
		setProfileAirspaceGroup('classA', false);
		expect(profileAirspaces(list).map((a) => a.key)).toContain('fir');
		setProfileAirspaceGroup('fir', false);
		expect(profileAirspaces(list).map((a) => a.key)).not.toContain('fir');
	});

	it('emphasises only a choice that departs from the DEFAULTS', () => {
		// Every row defaults on today, so this reads the same as "any row
		// off" - and stops doing so the moment a row ships default-off,
		// which is the whole reason it compares against DEFAULTS.
		expect(profileAirspaceGroupsRestrict()).toBe(false);
		setProfileAirspaceGroup('trafficmgmt', false);
		expect(profileAirspaceGroupsRestrict()).toBe(true);
		setProfileAirspaceGroup('trafficmgmt', true);
		expect(profileAirspaceGroupsRestrict()).toBe(false);
	});

	it('composes with the altitude band and the on-map scope', () => {
		setProfileAirspaceGroup('classE', false);
		display.profileAllAirspaces = false;
		layers.airspace.controlled = true;
		// classE gone by row; the restricted pair gone by the map scope; the
		// FIR frame gone with it (its own category is off on the map).
		expect(profileAirspaces(list).map((a) => a.key)).toEqual(['tma']);
	});

	it('stores only the non-default state, and clears it again', () => {
		const store = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			removeItem: (k: string) => void store.delete(k),
		});
		setProfileAirspaceGroup('classD', false);
		expect(profileAirspaceGroups.classD).toBe(false);
		expect(store.get('loxodrome:profile-class-d')).toBe('off');
		setProfileAirspaceGroup('classD', true);
		expect(profileAirspaceGroups.classD).toBe(true);
		expect(store.has('loxodrome:profile-class-d')).toBe(false);
		vi.unstubAllGlobals();
	});
});

/* The counts are the safety half of this module. An emptied profile that says
 * nothing is not a blank chart, it is a chart asserting clear sky: the header's
 * "airspace above" figure is arithmetic over the DRAWN columns, and
 * airspaceAbove cannot tell an emptied list from an open one. So the filtering
 * reports its own work, by first cause, and flags whether what it dropped was
 * countable at all. */
describe('profileScope counts what it hid, and why', () => {
	function kind(key: string, type: string, airClass: string, category: Airspace['category'], lower?: VerticalLimit, upper?: VerticalLimit) {
		return { ...mk(key, category, 'fr', lower ?? null, upper ?? null), type, airClass };
	}

	const tma = kind('tma', 'TMA', 'D', 'controlled', ['', '0', ''], ['', '50', 'FL']);
	const r = kind('r', 'R', '', 'restricted', ['', '0', ''], ['', '50', 'FL']);
	const act = kind('act', 'PJE', '', 'activity', ['', '0', ''], ['', '50', 'FL']);

	it('is silent when nothing was hidden', () => {
		const s = profileScope([tma, r]);
		expect(s.shown.map((a) => a.key)).toEqual(['tma', 'r']);
		expect([s.hiddenRows, s.hiddenBand, s.hiddenScope]).toEqual([0, 0, 0]);
	});

	it('charges the map scope, which is what empties a fresh install', () => {
		// Every airspace category ships OFF, so "on map" is an empty set out
		// of the box: the reported bug, in one assertion.
		setProfileAllAirspaces(false);
		const s = profileScope([tma, r]);
		expect(s.shown).toEqual([]);
		expect(s.hiddenScope).toBe(2);
		expect([s.hiddenRows, s.hiddenBand]).toEqual([0, 0]);
	});

	it('charges the rows', () => {
		// The activity row ships off, so this is what a fresh install hides.
		const s = profileScope([tma, act]);
		expect(s.shown.map((a) => a.key)).toEqual(['tma']);
		expect(s.hiddenRows).toBe(1);
	});

	it('charges the level band', () => {
		filter.altitude = { enabled: true, floor: 20000, ceiling: 30000 };
		const s = profileScope([tma, r]);
		expect(s.shown).toEqual([]);
		expect(s.hiddenBand).toBe(2);
		expect([s.hiddenRows, s.hiddenScope]).toEqual([0, 0]);
	});

	it('charges each row to its FIRST cause, so the counts partition the lot', () => {
		setProfileAirspaceGroup('classD', false); // takes the TMA
		setProfileAllAirspaces(false); // would take both, gets only the R
		const s = profileScope([tma, r]);
		expect(s.shown).toEqual([]);
		expect(s.hiddenRows).toBe(1);
		expect(s.hiddenScope).toBe(1);
		expect(s.hiddenRows + s.hiddenBand + s.hiddenScope).toBe(2);
	});

	it('exempts the panel\'s own subject from all three, counts included', () => {
		// An activity zone's own detail page is the one place it has to
		// appear, and a note reading "1 hidden" beside the column it names
		// would be its own contradiction.
		setProfileAllAirspaces(false);
		const s = profileScope([tma, act], 'act');
		expect(s.shown.map((a) => a.key)).toEqual(['act']);
		expect(s.hiddenScope).toBe(1);
		expect(s.hiddenRows).toBe(0);
	});

	it('keeps the subject IN PLACE, the input already being in band order', () => {
		setProfileAllAirspaces(false);
		layers.airspace.controlled = true;
		const s = profileScope([tma, act, r], 'act');
		expect(s.shown.map((a) => a.key)).toEqual(['tma', 'act']);
	});
});
