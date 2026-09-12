import { describe, it, expect } from 'vitest';
import { setRouteVfr, routeSettings } from '$lib/state/route.svelte';
import { filter } from '$lib/state/filter.svelte';

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
