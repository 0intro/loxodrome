/* The NOTAM filters and the level band persist through their setters
 * (state/filter.svelte.ts, docs/preferences.md), each stored only away from
 * its default and each showing itself while it hides something: the chips
 * above the list, the toolbar's emphasised chips. "Show only route NOTAMs"
 * joined the filters it belongs with: it has a chip while a routed plan
 * exists, and Show all clears it (a list it emptied used to stay empty). The
 * module seeds itself at evaluation, hence the re-import per case. */

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

const load = () => import('$lib/state/filter.svelte');

describe('the level band', () => {
	it('stores whole feet, the ceiling rounded like the floor', async () => {
		const f = await load();
		f.setAltitudeBand(1500, 6500.6);
		expect(ls.getItem('loxodrome:altitude-band')).toBe('1500,6501');
	});

	it('keeps the default band stored as it was while one is half typed', async () => {
		const f = await load();
		f.setAltitudeBand(Number.NaN, 10000);
		expect(ls.getItem('loxodrome:altitude-band')).toBeNull();
		f.setAltitudeEnabled(false);
		expect(ls.getItem('loxodrome:altitude-band')).toBe('off');
		f.setAltitudeBand(Number.NaN, 10000);
		expect(ls.getItem('loxodrome:altitude-band')).toBe('off');
		vi.resetModules();
		expect((await load()).filter.altitude).toEqual({ enabled: false, floor: 0, ceiling: 10000 });
	});

	it('keeps a stored band while one is half typed, whatever its digits', async () => {
		// Compared as numbers: 5000 is below 10000, not after it.
		const f = await load();
		f.setAltitudeBand(5000, 10000);
		f.setAltitudeBand(Number.NaN, 10000);
		expect(ls.getItem('loxodrome:altitude-band')).toBe('5000,10000');
	});

	it('takes a floor at the surface as a band, not an error', async () => {
		const f = await load();
		expect(f.altitudeError()).toBeNull();
		f.setAltitudeBand(0, 5000);
		expect(f.altitudeError()).toBeNull();
		expect(f.activeAltitudeBand()).toEqual({ floor: 0, ceiling: 5000 });
	});

	it('keeps its range while switched off, across a reload', async () => {
		const f = await load();
		expect(ls.getItem('loxodrome:altitude-band')).toBeNull();
		f.setAltitudeBand(1500, 6500);
		expect(ls.getItem('loxodrome:altitude-band')).toBe('1500,6500');
		f.setAltitudeEnabled(false);
		expect(ls.getItem('loxodrome:altitude-band')).toBe('off:1500,6500');
		vi.resetModules();
		const g = await load();
		expect(g.filter.altitude).toEqual({ enabled: false, floor: 1500, ceiling: 6500 });
		g.setAltitudeEnabled(true);
		expect(ls.getItem('loxodrome:altitude-band')).toBe('1500,6500');
	});

	it('stores nothing for the default band on, and a bare off for it off', async () => {
		const f = await load();
		f.setAltitudeEnabled(false);
		expect(ls.getItem('loxodrome:altitude-band')).toBe('off');
		f.setAltitudeEnabled(true);
		expect(ls.getItem('loxodrome:altitude-band')).toBeNull();
	});

	it('keeps the last good band stored while one is half typed', async () => {
		const f = await load();
		f.setAltitudeBand(2000, 8000);
		f.setAltitudeBand(Number.NaN, 8000);
		expect(ls.getItem('loxodrome:altitude-band')).toBe('2000,8000');
		f.setAltitudeBand(9000, 8000);
		expect(ls.getItem('loxodrome:altitude-band')).toBe('2000,8000');
	});

	it('writes only what it reads back, keeping the last good band otherwise', async () => {
		const f = await load();
		f.setAltitudeBand(2000, 8000);
		// Below the surface, and a figure that prints in exponent form: the
		// reader takes neither, so neither may replace the good band.
		f.setAltitudeBand(-500, 8000);
		expect(ls.getItem('loxodrome:altitude-band')).toBe('2000,8000');
		// Said, and inert while it stands, like any band half typed.
		expect(f.altitudeError()).not.toBeNull();
		expect(f.activeAltitudeBand()).toBeNull();
		f.setAltitudeBand(0, 1e21);
		expect(ls.getItem('loxodrome:altitude-band')).toBe('2000,8000');
		// A fraction is stored as the whole feet the reader takes.
		f.setAltitudeBand(1500.4, 6500);
		expect(ls.getItem('loxodrome:altitude-band')).toBe('1500,6500');
		vi.resetModules();
		expect((await load()).filter.altitude).toEqual({ enabled: true, floor: 1500, ceiling: 6500 });
	});

	it('keeps the stored range when switched while a box is half typed', async () => {
		const f = await load();
		f.setAltitudeBand(2000, 8000);
		f.setAltitudeBand(Number.NaN, 8000);
		f.setAltitudeEnabled(false);
		expect(ls.getItem('loxodrome:altitude-band')).toBe('off:2000,8000');
		f.setAltitudeEnabled(true);
		expect(ls.getItem('loxodrome:altitude-band')).toBe('2000,8000');
		f.setAltitudeEnabled(false);
		vi.resetModules();
		expect((await load()).filter.altitude).toEqual({ enabled: false, floor: 2000, ceiling: 8000 });
	});

	it("reads an older build's bare off as the default band switched off", async () => {
		ls.setItem('loxodrome:altitude-band', 'off');
		const f = await load();
		expect(f.filter.altitude).toEqual({ enabled: false, floor: 0, ceiling: 10000 });
	});
});

describe('the NOTAM filters', () => {
	it('store the hidden kinds, and nothing once every box is back', async () => {
		const f = await load();
		f.setNotamKind('area', false);
		f.setNotamKind('qualifierLine', false);
		expect(ls.getItem('loxodrome:notam-kind')).toBe('area,qualifierLine');
		vi.resetModules();
		const g = await load();
		expect(g.filter.kind).toEqual({ area: false, position: true, qualifierLine: false });
		g.setNotamKind('area', true);
		g.setNotamKind('qualifierLine', true);
		expect(ls.getItem('loxodrome:notam-kind')).toBeNull();
	});

	it('remember a bounded look-ahead, and nothing for the unbounded default', async () => {
		const f = await load();
		f.setWindowHorizon(24);
		expect(ls.getItem('loxodrome:notam-horizon')).toBe('24');
		vi.resetModules();
		const g = await load();
		expect(g.filter.window.horizonH).toBe(24);
		// The mode is never remembered: every session opens on Now.
		expect(g.filter.window.mode).toBe('now');
		g.setWindowHorizon(null);
		expect(ls.getItem('loxodrome:notam-horizon')).toBeNull();
	});

	it('read a look-ahead the popover does not offer as the default', async () => {
		ls.setItem('loxodrome:notam-horizon', '7');
		const f = await load();
		expect(f.filter.window.horizonH).toBeNull();
	});

	it('remember the route corridor switch', async () => {
		const f = await load();
		f.setNotamsOnRouteOnly(true);
		expect(ls.getItem('loxodrome:notams-on-route')).toBe('on');
		vi.resetModules();
		expect((await load()).filter.notamsOnRouteOnly).toBe(true);
	});
});

describe('the chips and Show all', () => {
	it('show the route corridor only where a routed plan exists', async () => {
		const f = await load();
		f.setNotamsOnRouteOnly(true);
		f.setNotamKind('area', false);
		expect(f.activeFilterChips().map((c) => c.id)).toEqual(['rules', 'kind']);
		expect(f.activeFilterChips({ route: true }).map((c) => c.id)).toEqual([
			'rules',
			'route',
			'kind',
		]);
	});

	it('clear the route corridor only where it applies', async () => {
		const f = await load();
		f.setNotamsOnRouteOnly(true);
		f.clearRestrictingFilters();
		expect(f.filter.notamsOnRouteOnly).toBe(true);
		f.clearRestrictingFilters({ route: true });
		expect(f.filter.notamsOnRouteOnly).toBe(false);
		expect(ls.getItem('loxodrome:notams-on-route')).toBeNull();
	});

	it('persist what Show all leaves: every kind, the band off with its range', async () => {
		const f = await load();
		f.setAltitudeBand(1500, 6500);
		f.setNotamKind('position', false);
		f.clearRestrictingFilters();
		expect(f.filter.trafficMode).toBe('all');
		expect(ls.getItem('loxodrome:notam-kind')).toBeNull();
		expect(ls.getItem('loxodrome:altitude-band')).toBe('off:1500,6500');
	});

	it('show every flight rule for the session, leaving a pin to come back', async () => {
		// Pinned in the popover, then cleared by Show all: every rule shows
		// now, and the pin, the pilot's own choice, stands for next time.
		const f = await load();
		f.setTrafficMode('ifr');
		f.clearRestrictingFilters();
		expect(f.filter.trafficMode).toBe('all');
		expect(ls.getItem('loxodrome:notam-rules')).toBe('ifr');
		// A restore drive does not end the session's All over a pin.
		f.followRouteRules(true, false);
		expect(f.filter.trafficMode).toBe('all');
		vi.resetModules();
		const g = await load();
		expect(g.filter.trafficMode).toBe('ifr');
		expect(g.filter.trafficPinned).toBe(true);
	});

	it('show every flight rule for the session, an unpinned filter following the route again', async () => {
		const f = await load();
		f.followRouteRules(false, false);
		f.clearFilterDimension('rules');
		expect(f.filter.trafficMode).toBe('all');
		expect(f.filter.trafficPinned).toBe(false);
		expect(ls.dump()).toEqual({});
		// The next drive is the route's again.
		f.followRouteRules(false, false);
		expect(f.filter.trafficMode).toBe('ifr');
	});

	it("keep a pin of All through Show all, being the popover's pick", async () => {
		const f = await load();
		f.setTrafficMode('all');
		expect(ls.getItem('loxodrome:notam-rules')).toBe('all');
		f.clearRestrictingFilters();
		expect(ls.getItem('loxodrome:notam-rules')).toBe('all');
		f.followRouteRules(true, false);
		expect(f.filter.trafficMode).toBe('all');
		vi.resetModules();
		expect((await load()).filter.trafficMode).toBe('all');
	});

	it("hand a pin back to the route with the popover's Route option", async () => {
		const f = await load();
		f.setTrafficMode('all');
		f.followTrafficRoute('ifr');
		expect(f.filter.trafficMode).toBe('ifr');
		expect(f.filter.trafficPinned).toBe(false);
		expect(ls.dump()).toEqual({});
	});

	it('read on the control as Route only while a routed plan drives them', async () => {
		const f = await load();
		// No routed plan (null): the mode in force, never Route.
		expect(f.trafficChoice(null)).toBe('vfr');
		// A VFR route driving the unpinned filter.
		expect(f.trafficChoice('vfr')).toBe('route');
		// An IFR route whose drive has not come yet reads the mode itself.
		expect(f.trafficChoice('ifr')).toBe('vfr');
		// A pin equal to the route's rules is still a pin, and reads as it.
		f.setTrafficMode('vfr');
		expect(f.trafficChoice('vfr')).toBe('vfr');
		// Show all, unpinned: All for the session, as it is.
		f.followTrafficRoute('vfr');
		f.clearRestrictingFilters();
		expect(f.trafficChoice('vfr')).toBe('all');
	});
});

describe('restoreFilterDefaults', () => {
	it('puts every filter preference back and leaves no key behind', async () => {
		const f = await load();
		f.setAltitudeBand(1500, 6500);
		f.setAltitudeEnabled(false);
		f.setNotamKind('area', false);
		f.setWindowHorizon(6);
		f.setTrafficMode('ifr');
		f.setNotamsOnRouteOnly(true);
		f.setWindowMode('custom');
		f.restoreFilterDefaults();
		expect(f.filter.altitude).toEqual({ enabled: true, floor: 0, ceiling: 10000 });
		expect(f.filter.kind).toEqual({ area: true, position: true, qualifierLine: true });
		expect(f.filter.window.horizonH).toBeNull();
		expect(f.filter.trafficMode).toBe('vfr');
		expect(f.filter.trafficPinned).toBe(false);
		expect(f.filter.notamsOnRouteOnly).toBe(false);
		// Session state is not a preference: the period's mode stays.
		expect(f.filter.window.mode).toBe('custom');
		expect(ls.dump()).toEqual({});
	});
});
