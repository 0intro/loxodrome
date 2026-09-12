/* Loading a plan out of an interchange file (state/routeLoad.svelte.ts's
 * loadPlanFile, docs/route-files.md).
 *
 * What is pinned here is the half the pure readers cannot test: which points
 * become real aerodromes and navaids, and which stay free at the position the
 * file states. The confirmation rule is the whole safety of it, and its
 * failure is INVISIBLE in the app: a plan that quietly flies through the
 * wrong CHW looks exactly like one that does not.
 *
 * The datasets are stubbed the way tests/routeRestore.spec.ts stubs them: a
 * fresh module graph per case, the two ensures resolved, and the resolver
 * answering from a table the case controls. */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

interface Anchor {
	lat: number;
	lon: number;
	kind: 'airport' | 'navaid';
	refId: string;
	ident: string;
	label?: string;
}

/** What the app's own data claims to hold, per case. An identifier may name
 *  SEVERAL features, which is the point of the index: the OurAirports
 *  baseline shadows same-ident navaids the world over. */
let known: Record<string, Anchor | Anchor[]> = {};

/** The opaque hits the stubbed index hands back, carrying their own kind so
 *  the importer's aerodrome preference is exercised. */
function hitsFor(ident: string): { kind: 'airport' | 'navaid'; anchor: Anchor }[] {
	const at = known[ident.toUpperCase()];
	const list = at === undefined ? [] : Array.isArray(at) ? at : [at];
	return list.map((anchor) => ({ kind: anchor.kind, anchor }));
}

beforeEach(() => {
	known = {};
	vi.resetModules();
	vi.doMock('$lib/state/data.svelte', async () => {
		const actual =
			await vi.importActual<typeof import('$lib/state/data.svelte')>('$lib/state/data.svelte');
		return { ...actual, ensureAirports: () => Promise.resolve([]), ensureNavaids: () => Promise.resolve([]) };
	});
	vi.doMock('$lib/state/waypointSearch.svelte', async () => {
		const actual = await vi.importActual<
			typeof import('$lib/state/waypointSearch.svelte')
		>('$lib/state/waypointSearch.svelte');
		return {
			...actual,
			resolveWaypointToken: (token: string) => hitsFor(token)[0]?.anchor ?? null,
			waypointHitIndex: () =>
				new Map(Object.keys(known).map((ident) => [ident.toUpperCase(), hitsFor(ident)])),
			hitPosition: (hit: { anchor: Anchor }) => hit.anchor,
			hitToAnchor: (hit: { anchor: Anchor }) => hit.anchor,
		};
	});
});

afterEach(() => {
	vi.doUnmock('$lib/state/data.svelte');
	vi.doUnmock('$lib/state/waypointSearch.svelte');
});

async function mods(): Promise<{
	load: typeof import('$lib/state/routeLoad.svelte');
	route: typeof import('$lib/state/route.svelte');
}> {
	return {
		load: await import('$lib/state/routeLoad.svelte'),
		route: await import('$lib/state/route.svelte'),
	};
}

const LFPL = { lat: 48.82194, lon: 2.62278, kind: 'airport' as const, refId: 'LFPL', ident: 'LFPL', label: 'Lognes Emerainville' };

/** A GPX route naming its points the way SDVFR and this app both do. */
function gpx(points: { name: string; lat: number; lon: number; ele?: number }[]): string {
	const body = points
		.map(
			(p) =>
				`<rtept lat="${p.lat}" lon="${p.lon}">` +
				(p.ele === undefined ? '' : `<ele>${p.ele}</ele>`) +
				`<name>${p.name}</name></rtept>`,
		)
		.join('');
	return (
		'<?xml version="1.0" encoding="UTF-8"?>' +
		'<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">' +
		`<metadata><name>Sortie</name></metadata><rte>${body}</rte></gpx>`
	);
}

describe('loadPlanFile', () => {
	it('anchors a point whose identifier the data confirms at that place', async () => {
		known.LFPL = LFPL;
		const { load, route } = await mods();
		expect(
			await load.loadPlanFile(
				gpx([
					{ name: 'LFPL LOGNES EMERAINVILLE', lat: 48.821944, lon: 2.622778, ele: 457.2 },
					{ name: 'Silos', lat: 49.14, lon: 2.79 },
				]),
			),
		).toBe(true);
		const wps = route.activeRoute().waypoints;
		expect(wps).toHaveLength(2);
		expect(wps[0].kind).toBe('airport');
		expect(wps[0].ident).toBe('LFPL');
		// The dataset's own position and label, not the file's copy of them.
		expect(wps[0].lat).toBe(LFPL.lat);
		expect(wps[0].label).toBe('Lognes Emerainville');
		expect(wps[0].alt).toBe(1500);
		expect(wps[0].altAuto).toBe(false);
	});

	it('keeps a point free when the identifier names somewhere else', async () => {
		// CHW is the Chartres VOR-DME and a reporting point 400 km away: the
		// one case that makes the confirmation load-bearing. The file's own
		// position wins, and the point is NOT dropped.
		known.CHW = { lat: 48.46, lon: 1.5, kind: 'navaid', refId: 'VOR:1', ident: 'CHW' };
		const { load, route } = await mods();
		await load.loadPlanFile(
			gpx([
				{ name: 'CHW reporting point', lat: 44.66, lon: -1.15 },
				{ name: 'Silos', lat: 49.14, lon: 2.79 },
			]),
		);
		const wps = route.activeRoute().waypoints;
		expect(wps).toHaveLength(2);
		expect(wps[0].kind).toBe('free');
		expect(wps[0].lat).toBeCloseTo(44.66, 5);
		expect(wps[0].label).toBe('CHW reporting point');
	});

	it('never drops a point the data does not know', async () => {
		// loadRoutes deletes a waypoint whose ident does not resolve, even one
		// carrying coordinates, so an unconfirmed identifier must never be
		// emitted as one.
		const { load, route } = await mods();
		await load.loadPlanFile(
			gpx([
				{ name: 'LFPL LOGNES EMERAINVILLE', lat: 48.821944, lon: 2.622778 },
				{ name: 'ZZZZ NOWHERE', lat: 49.14, lon: 2.79 },
			]),
		);
		const wps = route.activeRoute().waypoints;
		expect(wps).toHaveLength(2);
		expect(wps.every((w) => w.kind === 'free')).toBe(true);
		expect(wps[1].lat).toBeCloseTo(49.14, 5);
	});

	it("recovers an aerodrome from SDVFR's mangled FPL identifier", async () => {
		known.LFPL = LFPL;
		const { load, route } = await mods();
		const fpl =
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<flight-plan xmlns="http://www8.garmin.com/xmlschemas/FlightPlan/v1">' +
			'<waypoint-table>' +
			'<waypoint><identifier>LFPLL</identifier><type>USER WAYPOINT</type><country-code/>' +
			'<lat>48.821944</lat><lon>2.622778</lon><comment/></waypoint>' +
			'<waypoint><identifier>LOBEL1</identifier><type>USER WAYPOINT</type><country-code/>' +
			'<lat>48.7916</lat><lon>2.8691</lon><comment/></waypoint>' +
			'</waypoint-table><route><route-name>X</route-name><flight-plan-index>1</flight-plan-index>' +
			'<route-point><waypoint-identifier>LFPLL</waypoint-identifier><waypoint-type>USER WAYPOINT</waypoint-type><waypoint-country-code/></route-point>' +
			'<route-point><waypoint-identifier>LOBEL1</waypoint-identifier><waypoint-type>USER WAYPOINT</waypoint-type><waypoint-country-code/></route-point>' +
			'</route></flight-plan>';
		await load.loadPlanFile(fpl);
		const wps = route.activeRoute().waypoints;
		expect(wps[0].ident).toBe('LFPL');
		expect(wps[1].kind).toBe('free');
		expect(wps[1].label).toBe('LOBEL1');
	});

	it('takes the file\'s caption as the plan name, unless it is the chain', async () => {
		known.LFPL = LFPL;
		const { load, route } = await mods();
		await load.loadPlanFile(
			gpx([
				{ name: 'LFPL LOGNES EMERAINVILLE', lat: 48.821944, lon: 2.622778 },
				{ name: 'Silos', lat: 49.14, lon: 2.79 },
			]),
		);
		expect(route.routes.planName).toBe('Sortie');

		// Our own exports write the aerodrome chain into that field, and
		// reading one back must not caption a plan after its own route.
		const plain = gpx([
			{ name: 'LFPL LOGNES EMERAINVILLE', lat: 48.821944, lon: 2.622778 },
			{ name: 'Silos', lat: 49.14, lon: 2.79 },
		]).replace('<name>Sortie</name>', '<name>LFPL</name>');
		await load.loadPlanFile(plain);
		expect(route.routes.planName).toBeNull();
	});


	it('anchors the beacon a distant aerodrome of the same name shadows', async () => {
		// The OurAirports baseline is loaded whole and shadows some
		// eighty-eight same-ident navaids: BOV is the Beauvais-Tille VOR-DME
		// here and Boang Airport in Papua New Guinea there. Answering with the
		// first hit alone, the position confirmation could only REJECT it, and
		// the beacon became a nameless free point with no frequency in the nav
		// log and a coordinate token in the file it was saved back to.
		known.BOV = [
			{ lat: -3.38, lon: 154.67, kind: 'airport', refId: 'AYBS', ident: 'BOV', label: 'Boang' },
			{ lat: 49.45, lon: 2.13, kind: 'navaid', refId: 'BOV', ident: 'BOV', label: 'Beauvais' },
		];
		const { load, route } = await mods();
		await load.loadPlanFile(
			gpx([
				{ name: 'BOV BEAUVAIS', lat: 49.4501, lon: 2.1302 },
				{ name: 'Silos', lat: 49.14, lon: 2.79 },
			]),
		);
		const wps = route.activeRoute().waypoints;
		expect(wps[0].kind).toBe('navaid');
		expect(wps[0].ident).toBe('BOV');
	});

	it('takes the aerodrome where the file typed one', async () => {
		// An on-field beacon and its aerodrome share a position and sometimes
		// an identifier; the file's own word settles which the point is.
		known.LFPL = [
			{ lat: 48.8219, lon: 2.6228, kind: 'navaid', refId: 'LFPL-N', ident: 'LFPL', label: 'Beacon' },
			LFPL,
		];
		const { load, route } = await mods();
		const pln =
			'<?xml version="1.0"?><SimBase.Document Type="AceXML" version="1,0">' +
			'<Descr>AceXML Document</Descr><FlightPlan.FlightPlan><Title>T</Title>' +
			'<FPType>VFR</FPType>' +
			'<ATCWaypoint id="LFPL"><ATCWaypointType>Airport</ATCWaypointType>' +
			'<WorldPosition>N48° 49\' 19.00",E002° 37\' 22.00",+001500.00</WorldPosition>' +
			'<ICAO><ICAOIdent>LFPL</ICAOIdent></ICAO></ATCWaypoint>' +
			'<ATCWaypoint id="SILOS"><ATCWaypointType>User</ATCWaypointType>' +
			'<WorldPosition>N49° 8\' 24.00",E002° 47\' 24.00",+002000.00</WorldPosition></ATCWaypoint>' +
			'</FlightPlan.FlightPlan></SimBase.Document>';
		await load.loadPlanFile(pln);
		const wps = route.activeRoute().waypoints;
		expect(wps[0].kind).toBe('airport');
		expect(wps[0].ident).toBe('LFPL');
	});

	it('refuses the chain as a caption even when no dataset answered', async () => {
		// The import proceeds with no datasets by decision, and then nothing
		// resolves: weighing the title against the RESOLVED chain alone, our
		// own export's title became the plan's name at exactly the moment the
		// pilot has no signal, which is when they open a file.
		const { load, route } = await mods();
		const doc = gpx([
			{ name: 'LFPL LOGNES EMERAINVILLE', lat: 48.821944, lon: 2.622778 },
			{ name: 'LFPK MOISSELLES', lat: 49.14, lon: 2.79 },
		]).replace('<name>Sortie</name>', '<name>LFPL-LFPK</name>');
		await load.loadPlanFile(doc);
		expect(route.routes.planName).toBeNull();
	});

	it('keeps a caption written in another script', async () => {
		// fileToken folds to ASCII, so a Cyrillic or CJK caption folds to
		// nothing, and nothing matched the nothing an empty chain gives: the
		// pilot's own name for the plan was dropped with no notice.
		const { load, route } = await mods();
		const doc = gpx([
			{ name: 'LFPL LOGNES EMERAINVILLE', lat: 48.821944, lon: 2.622778 },
			{ name: 'Silos', lat: 49.14, lon: 2.79 },
		]).replace('<name>Sortie</name>', '<name>Полёт</name>');
		await load.loadPlanFile(doc);
		expect(route.routes.planName).toBe('Полёт');
	});

	it('names each route the file names', async () => {
		const { load, route } = await mods();
		const doc =
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">' +
			'<rte><name>Aller</name><rtept lat="48.82" lon="2.62"><name>A</name></rtept>' +
			'<rtept lat="49.14" lon="2.79"><name>B</name></rtept></rte>' +
			'<rte><name>Retour</name><rtept lat="49.14" lon="2.79"><name>B</name></rtept>' +
			'<rtept lat="48.82" lon="2.62"><name>A</name></rtept></rte></gpx>';
		await load.loadPlanFile(doc);
		expect(route.routes.list.map((r) => r.name)).toEqual(['Aller', 'Retour']);
	});

	it('leaves the workspace alone when the file cannot be read', async () => {
		const { load, route } = await mods();
		await load.loadPlanFile(
			gpx([
				{ name: 'A', lat: 48.8, lon: 2.6 },
				{ name: 'B', lat: 49.1, lon: 2.7 },
			]),
		);
		const before = route.activeRoute().waypoints.length;
		expect(await load.loadPlanFile('shopping list')).toBe(false);
		expect(route.activeRoute().waypoints).toHaveLength(before);
		expect(load.routeLoad.error).toMatch(/Not a flight plan/);
	});

	it('applies the flight rules a PLN states', async () => {
		const { load, route } = await mods();
		const pln =
			'<?xml version="1.0" encoding="UTF-8"?><SimBase.Document Type="AceXML" version="1,0">' +
			'<Descr>AceXML Document</Descr><FlightPlan.FlightPlan><Title>T</Title><FPType>IFR</FPType>' +
			'<ATCWaypoint id="A"><ATCWaypointType>User</ATCWaypointType>' +
			'<WorldPosition>N48° 49\' 19.00",E002° 37\' 22.00",+001500.00</WorldPosition></ATCWaypoint>' +
			'<ATCWaypoint id="B"><ATCWaypointType>User</ATCWaypointType>' +
			'<WorldPosition>N49° 8\' 24.00",E002° 47\' 29.00",+000000.00</WorldPosition></ATCWaypoint>' +
			'</FlightPlan.FlightPlan></SimBase.Document>';
		expect(await load.loadPlanFile(pln)).toBe(true);
		expect(route.routeSettings.vfr).toBe(false);
		expect(route.activeRoute().waypoints[0].alt).toBe(1500);
	});
});
