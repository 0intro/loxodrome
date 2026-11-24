import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { setRouteVfr, routeSettings } from '$lib/state/route.svelte';
import { filter } from '$lib/state/filter.svelte';
import { memoryStorage } from './helpers/storage';

// The Route-tab VFR/IFR toggle drives the NOTAM Flight-rules filter through the
// shared setRouteVfr, so a VFR route shows VFR-relevant NOTAMs and an IFR route
// shows IFR-relevant ones (the Filter tab can still override to 'all').
describe('setRouteVfr drives filter.trafficMode', () => {
	it('VFR route -> Flight-rules filter hides IFR-only NOTAMs', () => {
		setRouteVfr(true);
		expect(routeSettings.vfr).toBe(true);
		expect(filter.trafficMode).toBe('vfr');
	});

	it('IFR route -> Flight-rules filter hides VFR-only NOTAMs', () => {
		setRouteVfr(false);
		expect(routeSettings.vfr).toBe(false);
		expect(filter.trafficMode).toBe('ifr');
	});

	it('restores VFR', () => {
		setRouteVfr(true);
		expect(filter.trafficMode).toBe('vfr');
	});
});

/* The Filters popover can PIN the flight rules (docs/preferences.md): the pin
 * persists, a route GESTURE (the Route tab, a file opened) hands the filter
 * back to the route, and the boot's restore of the stored workspace is not a
 * gesture, or a pinned pick would be overwritten at every boot with a stored
 * route. The route's own drive is automatic and never stored. */
describe('a pinned flight-rules filter', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.stubGlobal('localStorage', memoryStorage());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('is stored when picked, and never while the route drives it', async () => {
		const f = await import('$lib/state/filter.svelte');
		const r = await import('$lib/state/route.svelte');
		r.setRouteVfr(false);
		expect(f.filter.trafficMode).toBe('ifr');
		expect(localStorage.getItem('loxodrome:notam-rules')).toBeNull();
		f.setTrafficMode('all');
		expect(f.filter.trafficPinned).toBe(true);
		expect(localStorage.getItem('loxodrome:notam-rules')).toBe('all');
	});

	it('goes back to the route on a gesture', async () => {
		const f = await import('$lib/state/filter.svelte');
		const r = await import('$lib/state/route.svelte');
		f.setTrafficMode('all');
		r.setRouteVfr(false);
		expect(f.filter.trafficPinned).toBe(false);
		expect(f.filter.trafficMode).toBe('ifr');
		expect(localStorage.getItem('loxodrome:notam-rules')).toBeNull();
	});

	it('survives a restore, at boot as through loadRoutes', async () => {
		localStorage.setItem('loxodrome:notam-rules', 'all');
		const f = await import('$lib/state/filter.svelte');
		const r = await import('$lib/state/route.svelte');
		expect(f.filter.trafficMode).toBe('all');
		r.setRouteVfr(false, 'restore');
		expect(f.filter.trafficMode).toBe('all');
		expect(r.routeSettings.vfr).toBe(false);
		r.loadRoutes({ routes: [], settings: { vfr: true } }, () => null, undefined, {
			restoring: true,
		});
		expect(f.filter.trafficMode).toBe('all');
		expect(localStorage.getItem('loxodrome:notam-rules')).toBe('all');
		// The same file opened by the pilot is a gesture.
		r.loadRoutes({ routes: [], settings: { vfr: false } }, () => null);
		expect(f.filter.trafficMode).toBe('ifr');
		expect(f.filter.trafficPinned).toBe(false);
	});

	it('never reads as set by the route while pinned', async () => {
		const f = await import('$lib/state/filter.svelte');
		const r = await import('$lib/state/route.svelte');
		r.setRouteVfr(true);
		f.setTrafficMode('vfr');
		expect(r.routeDrivesTrafficMode()).toBe(false);
	});
});
