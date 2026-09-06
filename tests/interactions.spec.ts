import { beforeEach, describe, expect, it, vi } from 'vitest';
import type L from 'leaflet';
import type { Airspace, VerticalLimit } from '$lib/data/airspaces';
import { fromTriple } from '$lib/vertical/limits';
import { filter } from '$lib/state/filter.svelte';
import { layers } from '$lib/state/layers.svelte';

// The map layer modules do a runtime `import L from 'leaflet'`, which
// touches `window` at load time. Mock them so this spec runs in Node, and
// so featureAt's ordering can be exercised against controlled hits.
const m = vi.hoisted(() => ({
	airportHit: vi.fn(),
	airportsAt: vi.fn(),
	nearestAirportUngated: vi.fn(),
	natureHit: vi.fn(),
	navaidHit: vi.fn(),
	navaidsAt: vi.fn(),
	nearestNavaidUngated: vi.fn(),
	obstacleHit: vi.fn(),
	obstaclesAt: vi.fn(),
	airspaceAt: vi.fn(),
	notamAreasAt: vi.fn(),
	activeRoute: vi.fn(),
	stationNear: vi.fn(),
	airportByIdent: vi.fn(),
	getAirspaces: vi.fn(),
	vacPanelsAt: vi.fn(),
}));

vi.mock('$lib/state/vacGeo.svelte', () => ({ vacPanelsAt: m.vacPanelsAt }));

vi.mock('$lib/map/airportLayer', () => ({
	airportHit: m.airportHit,
	airportsAt: m.airportsAt,
	nearestAirportUngated: m.nearestAirportUngated,
}));
vi.mock('$lib/map/natureLayer', () => ({ natureHit: m.natureHit }));
vi.mock('$lib/map/navaidLayer', () => ({
	navaidHit: m.navaidHit,
	navaidsAt: m.navaidsAt,
	nearestNavaidUngated: m.nearestNavaidUngated,
}));
vi.mock('$lib/map/obstacleLayer', () => ({ obstacleHit: m.obstacleHit, obstaclesAt: m.obstaclesAt }));
vi.mock('$lib/map/airspaceLayer', () => ({ airspaceAt: m.airspaceAt }));
vi.mock('$lib/map/metarLayer', () => ({ stationNear: m.stationNear }));
// Partial mock: other modules in the import graph read data.svelte's real
// exports (dataState etc.); only the station-ident resolution and the
// airspace dataset (the context menu's ungated gather) are stubbed.
vi.mock('$lib/state/data.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/state/data.svelte')>()),
	airportByIdent: m.airportByIdent,
	getAirspaces: m.getAirspaces,
}));
vi.mock('$lib/state/notamHit.svelte', () => ({ notamAreasAt: m.notamAreasAt }));
vi.mock('$lib/state/route.svelte', () => ({ activeRoute: m.activeRoute }));

import { contextFeaturesAt, featureAt } from '$lib/map/interactions';

const map = {} as unknown as L.Map;

// A map whose layer-point projection is the identity (x = lon, y = lat) so a
// route waypoint pin's pixel distance from the click point is controllable.
const pixelMap = {
	latLngToLayerPoint: ([la, lo]: [number, number]) => ({ x: lo, y: la }),
} as unknown as L.Map;

// Dataset-shaped airspace row for the context menu's ungated gather
// (airspacesOver runs the real bbox + ring containment on it).
function mkAirspace(
	key: string,
	ring: [number, number][],
	lower: VerticalLimit | null = null,
	upper: VerticalLimit | null = null,
): Airspace {
	const lats = ring.map((p) => p[0]);
	const lons = ring.map((p) => p[1]);
	return {
		key,
		id: key,
		category: 'restricted',
		source: 'fr',
		area: 1,
		ring,
		bbox: {
			minLat: Math.min(...lats),
			maxLat: Math.max(...lats),
			minLon: Math.min(...lons),
			maxLon: Math.max(...lons),
		},
		vLower: fromTriple(lower),
		vUpper: fromTriple(upper),
	} as unknown as Airspace;
}

// A ring containing the (1, 2) click point every test uses.
const RING_AROUND_CLICK: [number, number][] = [
	[0, 0],
	[0, 3],
	[2, 3],
	[2, 0],
];

beforeEach(() => {
	// Clear call history first, then default every hit to a miss; each test
	// overrides only the layers it cares about.
	vi.clearAllMocks();
	m.airportHit.mockReturnValue(null);
	m.natureHit.mockReturnValue(null);
	m.navaidHit.mockReturnValue(null);
	m.obstacleHit.mockReturnValue(null);
	m.airspaceAt.mockReturnValue(null);
	m.airportsAt.mockReturnValue([]);
	m.navaidsAt.mockReturnValue([]);
	m.obstaclesAt.mockReturnValue([]);
	m.notamAreasAt.mockReturnValue([]);
	m.nearestAirportUngated.mockReturnValue(null);
	m.nearestNavaidUngated.mockReturnValue(null);
	m.stationNear.mockReturnValue(null);
	m.airportByIdent.mockReturnValue(null);
	m.getAirspaces.mockReturnValue(null);
	m.vacPanelsAt.mockReturnValue([]);
	// No route pins by default; the pin-anchoring tests set their own waypoints.
	m.activeRoute.mockReturnValue({ waypoints: [] });
	// App-default filter state, restored for the altitude-filter test.
	filter.altitude = { enabled: false, floor: 0, ceiling: 60000 };
});

describe('featureAt', () => {
	it('returns null when nothing is under the point', () => {
		expect(featureAt(map, 1, 2)).toBeNull();
	});

	it('prefers an airport and short-circuits navaid/obstacle/airspace', () => {
		m.airportHit.mockReturnValue({ ident: 'LFPG' });
		m.navaidHit.mockReturnValue({ id: 'n1' });
		m.obstacleHit.mockReturnValue({ id: 'o1' });
		m.airspaceAt.mockReturnValue({ key: 'k', category: 'restricted' });
		expect(featureAt(map, 1, 2)).toEqual({ kind: 'airport', id: 'LFPG' });
		expect(m.navaidHit).not.toHaveBeenCalled();
		expect(m.obstacleHit).not.toHaveBeenCalled();
		expect(m.airspaceAt).not.toHaveBeenCalled();
	});

	it('resolves a METAR station dot to a station hit, above the airport layer (z 415)', () => {
		m.stationNear.mockReturnValue({
			metar: { icaoId: 'LFPO', lat: 48.7, lon: 2.4, name: 'Paris/Orly' },
		});
		m.airportHit.mockReturnValue({ ident: 'LFPG' });
		expect(featureAt(map, 1, 2)).toEqual({
			kind: 'station',
			id: 'LFPO',
			lat: 48.7,
			lon: 2.4,
			name: 'Paris/Orly',
		});
		expect(m.airportHit).not.toHaveBeenCalled();
		// featureAt no longer resolves the station to its airport.
		expect(m.airportByIdent).not.toHaveBeenCalled();
	});

	it('selects a station even when its ident is not in the airports dataset', () => {
		m.stationNear.mockReturnValue({ metar: { icaoId: 'EHSC', lat: 52, lon: 3 } });
		m.airspaceAt.mockReturnValue({ key: 'k', category: 'restricted' });
		expect(featureAt(map, 1, 2)).toEqual({ kind: 'station', id: 'EHSC', lat: 52, lon: 3 });
		expect(m.airspaceAt).not.toHaveBeenCalled();
	});

	it('prefers a nature zone over a navaid when no airport (z-395 pane)', () => {
		m.natureHit.mockReturnValue({ id: 'LF-PRN-020' });
		m.navaidHit.mockReturnValue({ id: 'n1' });
		expect(featureAt(map, 1, 2)).toEqual({ kind: 'nature', id: 'LF-PRN-020' });
		expect(m.navaidHit).not.toHaveBeenCalled();
	});

	it('falls back to a navaid when no airport, before obstacle/airspace', () => {
		m.navaidHit.mockReturnValue({ id: 'VOR:123' });
		m.obstacleHit.mockReturnValue({ id: 'o1' });
		m.airspaceAt.mockReturnValue({ key: 'k', category: 'restricted' });
		expect(featureAt(map, 1, 2)).toEqual({ kind: 'navaid', id: 'VOR:123' });
		expect(m.obstacleHit).not.toHaveBeenCalled();
		expect(m.airspaceAt).not.toHaveBeenCalled();
	});

	it('falls back to an obstacle when no airport/navaid, before airspace', () => {
		m.obstacleHit.mockReturnValue({ id: 'OBS-1' });
		m.airspaceAt.mockReturnValue({ key: 'k', category: 'restricted' });
		expect(featureAt(map, 1, 2)).toEqual({ kind: 'obstacle', id: 'OBS-1' });
		expect(m.airspaceAt).not.toHaveBeenCalled();
	});

	it('falls back to an airspace, carrying its category', () => {
		m.airspaceAt.mockReturnValue({ key: 'LF-R-1|R1', category: 'fir' });
		expect(featureAt(map, 1, 2)).toEqual({
			kind: 'airspace',
			key: 'LF-R-1|R1',
			category: 'fir',
		});
	});
});

describe('contextFeaturesAt', () => {
	it('gathers all feature lists without reordering them', () => {
		const notams = [{ notam: { id: 'A1/26' }, index: 0 }];
		const airports = [{ ident: 'LFPG' }];
		const navaids = [{ id: 'VOR:123' }];
		const airspace = mkAirspace('k', RING_AROUND_CLICK);
		const obstacles = [{ id: 'o1' }];
		m.notamAreasAt.mockReturnValue(notams);
		m.airportsAt.mockReturnValue(airports);
		m.navaidsAt.mockReturnValue(navaids);
		m.getAirspaces.mockReturnValue([airspace]);
		m.obstaclesAt.mockReturnValue(obstacles);
		// supaips and sigmets come from the real supaipZonesAt / sigmetsAt
		// (their modules aren't mocked); with no SUP AIP dataset loaded and
		// the SIGMET toggle off by default both resolve to [], and the VAC
		// gather defaults to no panels above.
		expect(contextFeaturesAt(map, 1, 2)).toEqual({
			notams,
			stations: [],
			airports,
			navaids,
			airspaces: [airspace],
			obstacles,
			supaips: [],
			sigmets: [],
			charts: [],
			waypoints: [],
			leg: null,
		});
	});

	it('lists one row per aerodrome, however many sheets it files there', () => {
		// A large field files a plate in each Atlas product, so Paris CDG
		// has four panels over the same ground: AD-2 approach and landing,
		// AD-3 approach and landing. A row pins an IDENT, so four rows all
		// reading LFPG did the same thing four times.
		const at = { lat: 49.0, lon: 2.55 };
		m.vacPanelsAt.mockReturnValue([
			{ ident: 'LFPG', section: 2, page: 2, kind: 'ATT' },
			{ ident: 'LFPG', section: 3, page: 2, kind: 'ATT' },
			{ ident: 'LFPG', section: 2, page: 1, kind: 'APP' },
			{ ident: 'LFPG', section: 3, page: 1, kind: 'APP' },
			{ ident: 'LFPB', section: 2, page: 1, kind: 'APP' },
		] as never);
		expect(contextFeaturesAt(map, at.lat, at.lon).charts).toEqual([
			{ ident: 'LFPG', kinds: ['ATT', 'APP'] },
			{ ident: 'LFPB', kinds: ['APP'] },
		]);
	});

	it('lists airspaces from the dataset, ignoring the display-only layer toggles', () => {
		const inside = mkAirspace('in', RING_AROUND_CLICK);
		const away = mkAirspace('out', [
			[10, 10],
			[10, 11],
			[11, 11],
			[11, 10],
		]);
		m.getAirspaces.mockReturnValue([inside, away]);
		// Every category off (the app default) and the row's own publisher
		// off: those toggles decide what the map draws, never what the
		// context menu lists.
		const prev = layers.publisher.fr;
		layers.publisher.fr = false;
		try {
			expect(contextFeaturesAt(map, 1, 2).airspaces).toEqual([inside]);
		} finally {
			layers.publisher.fr = prev;
		}
	});

	it('subsets the context-menu airspaces by the altitude filter (a data filter)', () => {
		const low = mkAirspace('low', RING_AROUND_CLICK, ['', '0', ''], ['', '50', 'FL']);
		const high = mkAirspace('high', RING_AROUND_CLICK, ['', '150', 'FL'], ['', '250', 'FL']);
		m.getAirspaces.mockReturnValue([low, high]);
		filter.altitude = { enabled: true, floor: 10000, ceiling: 20000 };
		expect(contextFeaturesAt(map, 1, 2).airspaces.map((a) => a.key)).toEqual(['high']);
	});

	it('surfaces a METAR station as its own row and folds it into airports', () => {
		const station = {
			metar: { icaoId: 'LFPO', lat: 48.7, lon: 2.4, name: 'Paris/Orly' },
			cat: 'VFR',
		};
		const airport = { ident: 'LFPO', name: 'Paris Orly' };
		m.stationNear.mockReturnValue(station);
		m.airportByIdent.mockReturnValue(airport);
		const res = contextFeaturesAt(map, 1, 2);
		expect(res.stations).toEqual([station]);
		expect(res.airports).toEqual([airport]);
	});

	it('surfaces the airport a route waypoint pin is anchored to, even when zoom-gated out', () => {
		// airportsAt misses it (gated out at this zoom); the pin makes it reachable.
		m.airportsAt.mockReturnValue([]);
		m.activeRoute.mockReturnValue({
			waypoints: [{ kind: 'airport', refId: 'LFAB', lat: 1, lon: 2 }],
		});
		const airport = { ident: 'LFAB', name: 'Anchor Field', type: 'small_airport' };
		m.nearestAirportUngated.mockReturnValue({ airport, distM: 0 });
		expect(contextFeaturesAt(pixelMap, 1, 2).airports).toEqual([airport]);
		expect(m.nearestAirportUngated).toHaveBeenCalledWith(1, 2, 250);
	});

	it('ignores a pin whose disc is outside the click pixel radius', () => {
		m.activeRoute.mockReturnValue({
			waypoints: [{ kind: 'airport', refId: 'LFAB', lat: 1, lon: 2 }],
		});
		m.nearestAirportUngated.mockReturnValue({ airport: { ident: 'LFAB' }, distM: 0 });
		// Click 28 px away in x from the pin at (1, 2): beyond the 14 px disc.
		expect(contextFeaturesAt(pixelMap, 1, 30).airports).toEqual([]);
		expect(m.nearestAirportUngated).not.toHaveBeenCalled();
	});

	it('does not substitute a neighbour when the nearest airport mismatches the pin refId', () => {
		m.activeRoute.mockReturnValue({
			waypoints: [{ kind: 'airport', refId: 'LFAB', lat: 1, lon: 2 }],
		});
		m.nearestAirportUngated.mockReturnValue({ airport: { ident: 'LFZZ' }, distM: 0 });
		expect(contextFeaturesAt(pixelMap, 1, 2).airports).toEqual([]);
	});

	it('de-dupes a pin-anchored airport against airportsAt, keeping the pin copy first', () => {
		const anchored = { ident: 'LFAB', name: 'Anchored' };
		const gatedSame = { ident: 'LFAB', name: 'Gated' };
		const gatedOther = { ident: 'LFCD', name: 'Other' };
		m.airportsAt.mockReturnValue([gatedSame, gatedOther]);
		m.activeRoute.mockReturnValue({
			waypoints: [{ kind: 'airport', refId: 'LFAB', lat: 1, lon: 2 }],
		});
		m.nearestAirportUngated.mockReturnValue({ airport: anchored, distM: 0 });
		expect(contextFeaturesAt(pixelMap, 1, 2).airports).toEqual([anchored, gatedOther]);
	});

	it('surfaces the navaid a route waypoint pin is anchored to', () => {
		m.navaidsAt.mockReturnValue([]);
		m.activeRoute.mockReturnValue({
			waypoints: [{ kind: 'navaid', refId: 'VOR:1', lat: 1, lon: 2 }],
		});
		const navaid = { id: 'VOR:1', ident: 'ABC' };
		m.nearestNavaidUngated.mockReturnValue({ navaid, distM: 0 });
		expect(contextFeaturesAt(pixelMap, 1, 2).navaids).toEqual([navaid]);
		expect(m.nearestNavaidUngated).toHaveBeenCalledWith(1, 2, 250);
	});

	it('returns an active-route waypoint whose pin is under the click', () => {
		const wp = { id: 'wp-1', kind: 'free', lat: 1, lon: 2 };
		m.activeRoute.mockReturnValue({ waypoints: [wp] });
		expect(contextFeaturesAt(pixelMap, 1, 2).waypoints).toEqual([wp]);
	});

	it('omits a waypoint whose pin is outside the click pixel radius', () => {
		m.activeRoute.mockReturnValue({
			waypoints: [{ id: 'wp-1', kind: 'free', lat: 1, lon: 2 }],
		});
		// Click 28 px away in x from the pin at (1, 2): beyond the 14 px disc.
		expect(contextFeaturesAt(pixelMap, 1, 30).waypoints).toEqual([]);
	});

	it('orders hit waypoints nearest first', () => {
		const near = { id: 'near', kind: 'free', lat: 1, lon: 3 };
		const far = { id: 'far', kind: 'free', lat: 1, lon: 10 };
		// Click at lon 4: near is 1 px away, far 6 px (both within the 14 px disc).
		m.activeRoute.mockReturnValue({ waypoints: [far, near] });
		expect(contextFeaturesAt(pixelMap, 1, 4).waypoints).toEqual([near, far]);
	});

	it('returns the active-route leg index under the click', () => {
		// Two far-apart waypoints; click near the leg middle, > 14 px from either pin.
		m.activeRoute.mockReturnValue({
			waypoints: [
				{ id: 'a', kind: 'free', lat: 0, lon: 0 },
				{ id: 'b', kind: 'free', lat: 0, lon: 40 },
			],
		});
		expect(contextFeaturesAt(pixelMap, 2, 20).leg).toBe(0);
	});

	it('returns no leg when the click is far from every leg', () => {
		m.activeRoute.mockReturnValue({
			waypoints: [
				{ id: 'a', kind: 'free', lat: 0, lon: 0 },
				{ id: 'b', kind: 'free', lat: 0, lon: 40 },
			],
		});
		expect(contextFeaturesAt(pixelMap, 30, 20).leg).toBeNull();
	});

	it('prefers a waypoint pin over a leg', () => {
		m.activeRoute.mockReturnValue({
			waypoints: [
				{ id: 'a', kind: 'free', lat: 0, lon: 0 },
				{ id: 'b', kind: 'free', lat: 0, lon: 40 },
			],
		});
		// Click on pin 'a': the leg is suppressed so the pin's actions win.
		const res = contextFeaturesAt(pixelMap, 0, 0);
		expect(res.leg).toBeNull();
		expect(res.waypoints.length).toBeGreaterThan(0);
	});

	it('picks the nearest leg of several', () => {
		m.activeRoute.mockReturnValue({
			waypoints: [
				{ id: 'a', kind: 'free', lat: 0, lon: 0 },
				{ id: 'b', kind: 'free', lat: 0, lon: 100 },
				{ id: 'c', kind: 'free', lat: 60, lon: 100 },
			],
		});
		// Click hugs the second leg (x=100, y 0..60) near y=30, far from leg 0.
		expect(contextFeaturesAt(pixelMap, 30, 97).leg).toBe(1);
	});
});
