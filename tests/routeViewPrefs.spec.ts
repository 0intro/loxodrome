/* The Route tab's two display preferences persist under keys of their own,
 * never inside the route workspace doc (state/route.svelte.ts,
 * docs/preferences.md): a cleared or replaced plan must not take a display
 * choice with it. The route-only airspace filter overrides the Layers-tab
 * categories, so it answers, once, whether it applies right now; the map's
 * filter effect and the Layers tab's indicator both read that answer. */

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

describe('the route display preferences', () => {
	it('persist each under its own key, and nothing while off', async () => {
		const r = await import('$lib/state/route.svelte');
		r.setAirspacesOnRouteOnly(true);
		r.setMinAltDangerOn(true);
		expect(ls.dump()).toEqual({
			'loxodrome:airspaces-on-route': 'on',
			'loxodrome:min-alt-danger': 'on',
		});
		vi.resetModules();
		const again = await import('$lib/state/route.svelte');
		expect(again.routeSettings.airspacesOnRouteOnly).toBe(true);
		expect(again.routeSettings.minAltDangerOn).toBe(true);
		again.restoreRouteViewDefaults();
		expect(again.routeSettings.airspacesOnRouteOnly).toBe(false);
		expect(again.routeSettings.minAltDangerOn).toBe(false);
		expect(ls.dump()).toEqual({});
	});

	it('apply the airspace filter only with a route to fly through', async () => {
		const r = await import('$lib/state/route.svelte');
		r.setAirspacesOnRouteOnly(true);
		expect(r.routeAirspaceFilterActive()).toBe(false);
		r.loadRoutes(
			{
				routes: [
					{
						name: 'A to B',
						waypoints: [
							{ name: 'A', lat: 48.6, lon: 2.3 },
							{ name: 'B', lat: 48.9, lon: 2.6 },
						],
					},
				],
			},
			() => null,
		);
		expect(r.routeAirspaceFilterActive()).toBe(true);
		r.setAirspacesOnRouteOnly(false);
		expect(r.routeAirspaceFilterActive()).toBe(false);
	});
});
