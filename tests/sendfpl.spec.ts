/* The route string handed to SendFPL: the position encoding, the per-waypoint
 * rules, and the whole-plan chain (docs/sendfpl.md).
 *
 * The classification block is a contract test. SendFPL's own grammar is
 * transcribed here from the sibling sendfpl project (cxp/FlightPlan.kt,
 * route/RouteParser.kt) and every emitted token is classified through it, so a
 * drift on either side fails here rather than on a navigator. The last block is
 * the ladder that decides which way the finished string leaves. */

import { describe, it, expect } from 'vitest';
import { buildSendFplPlan, buildSendFplRoute, formatArincLatLon } from '$lib/route/sendfpl';
import { handoffFor } from '$lib/native/sendfpl';
import type { Route, Waypoint } from '$lib/state/route.svelte';

function wp(extra: Partial<Waypoint>): Waypoint {
	return { id: 't', lat: 0, lon: 0, kind: 'free', alt: 2000, altAuto: true, ...extra };
}

const ap = (ident: string, lat: number, lon: number): Waypoint =>
	wp({ kind: 'airport', ident, lat, lon });
const nav = (ident: string, lat: number, lon: number): Waypoint =>
	wp({ kind: 'navaid', ident, lat, lon });
const free = (label: string | undefined, lat: number, lon: number): Waypoint =>
	wp({ kind: 'free', label, lat, lon });

const route = (waypoints: Waypoint[], alternate = false): Route => ({
	id: 'r',
	name: null,
	waypoints,
	selectedWaypointId: null,
	alternate,
});

/* The Lognes -> Melun leg of a real plan: an aerodrome, a named turning point,
 * the PM-N reporting point, the Melun VOR/DME, another turning point. */
const LFPL = ap('LFPL', 48.821944, 2.622778);
const PONTCARRE = free('Pontcarré', 48.8, 2.68);
const PMN = nav('PMN', 48.69417, 2.72056);
const MLN = nav('MLN', 48.45578, 2.81329);
const CHESNAY = free('Poste électrique du Chesnay', 48.38969, 2.86958);
const LFPU = ap('LFPU', 48.35, 2.8);

/* A fixture's position, so an expectation below says WHICH points carry one and
 * under what name; the encoding itself is pinned in its own block. */
const at = (w: Waypoint): string => formatArincLatLon(w.lat, w.lon);

describe('formatArincLatLon', () => {
	it('writes whole degrees and tenths of a minute, the way the navigator does', () => {
		// The worked example in garmin-cxp docs/cxp-flightplan.md.
		expect(formatArincLatLon(48.82, 2.62)).toBe('N48492E002372');
	});

	it('is 13 characters, zero-padded on both axes', () => {
		expect(formatArincLatLon(5.5, 7.25)).toBe('N05300E007150');
		expect(formatArincLatLon(48.5, 122.5)).toBe('N48300E122300');
		expect(formatArincLatLon(48.82, 2.62)).toHaveLength(13);
	});

	it('carries the hemisphere in the sign', () => {
		expect(formatArincLatLon(-12.5, -34.25)).toBe('S12300W034150');
	});

	it('lets the tenths reach 600 rather than carrying into the degrees', () => {
		// Garmin does not clamp either, and its own decoder reads 600 / 600 as a
		// whole degree, so carrying here would disagree with the receiver.
		expect(formatArincLatLon(48.99999, 2)).toBe('N48600E002000');
	});
});

describe('buildSendFplRoute', () => {
	it('carries a position on every point but the two aerodromes at the ends', () => {
		expect(buildSendFplRoute([LFPL, PONTCARRE, PMN, MLN, CHESNAY, LFPU])).toBe(
			'LFPL PONTC,N48480E002408 PMN,N48417E002432 MLN,N48273E002488 ' +
				'POSTE,N48234E002522 LFPU',
		);
	});

	it('folds accents and drops what a user-waypoint name may not hold', () => {
		expect(buildSendFplRoute([LFPL, free("L'obélisque", 48.7916, 2.86917), LFPU])).toContain(
			'LOBEL,',
		);
		expect(buildSendFplRoute([LFPL, free('Villages Nature', 48.8395, 2.81985), LFPU])).toContain(
			'VILLA,',
		);
	});

	it('folds an identifier the way it folds a label, no dataset being clean', () => {
		// it-navaids.json states APS1=COLLE ROIO for a reporting point, and pushed
		// raw the space alone splits one point into two tokens and hands the
		// arrival aerodrome to ROIO. The 23 markers shaped like the second are
		// refused outright by the navigator.
		expect(buildSendFplRoute([LFPL, nav('APS1=COLLE ROIO', 42.3, 13.4), LFPU])).toBe(
			'LFPL APS1C,N42180E013240 LFPU',
		);
		expect(buildSendFplRoute([LFPL, nav('LFBC-24-M', 44.8, -0.7), LFPU])).toBe(
			'LFPL LFBC2,N44480W000420 LFPU',
		);
	});

	it('sends an unnamed free point as a bare position', () => {
		expect(buildSendFplRoute([LFPL, free(undefined, 48.8, 2.68), LFPU])).toBe(
			'LFPL N48480E002408 LFPU',
		);
	});

	it('sends a name that folds to nothing as a bare position', () => {
		expect(buildSendFplRoute([LFPL, free('—', 48.8, 2.68), LFPU])).toBe(
			'LFPL N48480E002408 LFPU',
		);
	});

	it('keeps two points that fold to the same name distinct', () => {
		const r = buildSendFplRoute([LFPL, PONTCARRE, free('Pontcarré sud', 48.75, 2.68), LFPU]);
		expect(r).toBe('LFPL PONTC,N48480E002408 PONT2,N48450E002408 LFPU');
	});

	it('names one place once, however many times the route passes it', () => {
		// A name is bound to the position it names, not merely used: an out and
		// back through Melun writing MLN and then MLN2 would put two beacons in the
		// navigator's catalogue for the one.
		expect(buildSendFplRoute([LFPL, MLN, LFPU, MLN, LFPL])).toBe(
			`LFPL MLN,${at(MLN)} LFPU,${at(LFPU)} MLN,${at(MLN)} LFPL`,
		);
	});

	it('separates two places answering to one identifier, which is why positions go', () => {
		// fr-navaids.json answers CHW for the Chartres VOR-DME and for the CH-W
		// reporting point near Arcachon, 400 km apart. Garmin calls the position
		// optional only where the identifier is unique, and here it is not.
		const chartres = nav('CHW', 48.48, 0.98705);
		const chw = nav('CHW', 44.58917, -1.21361);
		expect(buildSendFplRoute([LFPL, chartres, chw, LFPU])).toBe(
			'LFPL CHW,N48288E000592 CHW2,N44354W001128 LFPU',
		);
	});

	it('never shadows an identifier already in the route', () => {
		// A turning point the pilot named after the beacon it sits on: the
		// navigator would have two points answering to MLN otherwise.
		const r = buildSendFplRoute([LFPL, MLN, free('MLN', 48.5, 2.8), LFPU]);
		expect(r).toBe('LFPL MLN,N48273E002488 MLN2,N48300E002480 LFPU');
	});

	it('gives an airway-shaped navaid its position, so it is not read as an airway', () => {
		// WM801 is a real waypoint in fr-navaids.json, and bare it reads as an
		// airway (a letter or two then digits). There is no rule of its own for it
		// any more: every point carries a position, and a position is what stops
		// that reading.
		expect(buildSendFplRoute([LFPL, nav('WM801', 48.8, 2.68), LFPU])).toBe(
			'LFPL WM801,N48480E002408 LFPU',
		);
	});

	it('sends the ends bare and everything between with its position', () => {
		// Thousands of local codes are airway-shaped (A05, AA00). At an end that is
		// an aerodrome identifier and travels bare; in the middle a bare A05 would
		// be read as an airway, which is why nothing there goes bare.
		expect(buildSendFplRoute([ap('A05', 48.8, 2.68), MLN, ap('AA00', 48.35, 2.8)])).toBe(
			`A05 MLN,${at(MLN)} AA00`,
		);
	});

	it('gives an end SendFPL cannot read as an aerodrome its position too', () => {
		// 731 rows in airports.json are OurAirports local codes, and the :DA: /
		// :AA: handler reads four characters, so a bare AD-ALV is refused and the
		// route with it.
		expect(buildSendFplRoute([ap('AD-ALV', 42.5, 1.5), MLN, LFPU])).toBe(
			`ADALV,N42300E001300 MLN,${at(MLN)} LFPU`,
		);
	});

	it('gives a beacon at an end its position, an end being no exemption', () => {
		// :F:MLN is the token the navigator refused. A route may perfectly well
		// start on a beacon, and an aerodrome identifier is the only one unique
		// enough to travel bare.
		expect(buildSendFplRoute([MLN, PMN, LFPU])).toBe(`MLN,${at(MLN)} PMN,${at(PMN)} LFPU`);
	});

	it('emits no name the navigator would refuse', () => {
		// FlightPlan.checkName: alphanumeric, and at most WAYPOINT_NAME_LEN.
		const r = buildSendFplRoute([
			LFPL,
			nav('APS1=COLLE ROIO', 42.3, 13.4),
			nav('LFBC-24-M', 44.8, -0.7),
			CHESNAY,
			LFPU,
		]);
		for (const token of r.split(' ').filter((t) => t.includes(','))) {
			expect(token.split(',')[0]).toMatch(/^[A-Z0-9]{1,5}$/);
		}
	});

	it('has nothing to send without a departure and an arrival', () => {
		expect(buildSendFplRoute([])).toBe('');
		expect(buildSendFplRoute([LFPL])).toBe('');
	});
});

describe('buildSendFplPlan', () => {
	const LFGO = ap('LFGO', 49.0, 3.1);
	const LFPK = ap('LFPK', 48.8375, 3.014444);

	it('chains every trip, writing the shared aerodrome once', () => {
		const plan = [
			route([LFPL, PMN, LFPU]),
			route([LFPU, MLN, LFGO]),
			route([LFGO, LFPK, LFPL]),
		];
		expect(buildSendFplPlan(plan)).toBe(
			'LFPL PMN,N48417E002432 LFPU,N48210E002480 MLN,N48273E002488 ' +
				'LFGO,N49000E003060 LFPK,N48502E003009 LFPL',
		);
	});

	it('leaves alternates out: they are diversions, not part of the flight', () => {
		const plan = [route([LFPL, PMN, LFPU]), route([LFPU, LFGO], true), route([LFPU, MLN, LFPL])];
		expect(buildSendFplPlan(plan)).toBe(
			'LFPL PMN,N48417E002432 LFPU,N48210E002480 MLN,N48273E002488 LFPL',
		);
	});

	it('keeps a genuine there-and-back, which repeats no place in a row', () => {
		expect(buildSendFplPlan([route([LFPL, LFPU]), route([LFPU, LFPL])])).toBe(
			'LFPL LFPU,N48210E002480 LFPL',
		);
	});

	it('names one junction once, however many legs meet there', () => {
		const plan = [
			route([LFPL, LFPU]),
			route([LFPU, LFGO]),
			route([LFGO, LFPU]),
			route([LFPU, LFPL]),
		];
		expect(buildSendFplPlan(plan)).toBe(
			'LFPL LFPU,N48210E002480 LFGO,N49000E003060 LFPU,N48210E002480 LFPL',
		);
	});

	it('fits the names across the whole chain, not per leg', () => {
		const plan = [
			route([LFPL, PONTCARRE, LFPU]),
			route([LFPU, free('Pontcarré sud', 48.75, 2.68), LFPL]),
		];
		// One name space covers the chain, because SendFPL parses one route: the
		// two are different places, so the second cannot be PONTC as well.
		expect(buildSendFplPlan(plan)).toBe(
			'LFPL PONTC,N48480E002408 LFPU,N48210E002480 PONT2,N48450E002408 LFPL',
		);
	});

	it('is the route emitter, so a plan of one trip is that trip', () => {
		const trip = route([LFPL, PONTCARRE, PMN, MLN, CHESNAY, LFPU]);
		expect(buildSendFplPlan([trip])).toBe(buildSendFplRoute(trip.waypoints));
	});

	it('has nothing to send when no trip has two waypoints', () => {
		expect(buildSendFplPlan([])).toBe('');
		expect(buildSendFplPlan([route([LFPL])])).toBe('');
		expect(buildSendFplPlan([route([LFPL, LFPU], true)])).toBe('');
	});
});

/* SendFPL's grammar, transcribed from garmin-cxp:
 * cxp/FlightPlan.kt LOOSE_LATLON / NAMED_USER_WAYPOINT / USER_WAYPOINT_TOKEN /
 * LATLON, and route/RouteParser.kt AIRWAY plus the order it tests them in. */
const LOOSE_LATLON =
	/(?<![A-Z0-9.,])([NS]\d{1,6}(?:[.,]\d{1,8})?|\d{1,6}(?:[.,]\d{1,8})?[NS])[ \t]*[/,]?[ \t]*([EW]\d{1,6}(?:[.,]\d{1,8})?|\d{1,6}(?:[.,]\d{1,8})?[EW])(?![A-Z0-9.,])/gi;
const NAMED_USER_WAYPOINT = /(?<![A-Z0-9./])([A-Z0-9]{1,8}),([NS]\d{5}[EW]\d{6})(?![A-Z0-9./])/gi;
const USER_WAYPOINT_TOKEN = /^([A-Z0-9]{1,8})\/([NS]\d{5}[EW]\d{6})$/;
const LATLON = /^([NS])?(\d{1,7}(?:\.\d{1,8})?)([NS])?\/?([EW])?(\d{1,7}(?:\.\d{1,8})?)([EW])?$/;
const AIRWAY = /^[A-Z]{1,2}\d{1,3}[A-Z]?$/;
/* RouteParser.aerodrome(): at most four characters, all alphanumeric. A token
 * longer than that, or holding the `/` a folded position leaves behind, is no
 * aerodrome, and parse() keeps it in the enroute slice as the route's own first
 * or last point. */
const AERODROME = /^[A-Z0-9]{1,4}$/;

type TokenKind = 'airport' | 'coordinate' | 'user' | 'airway' | 'waypoint';

/** RouteParser.parse, reduced to how it classifies each token. */
function classify(route: string): { kind: TokenKind; text: string }[] {
	const folded = route
		.replace(LOOSE_LATLON, (_m, lat: string, lon: string) =>
			`${lat.replace(',', '.')}/${lon.replace(',', '.')}`,
		)
		.replace(NAMED_USER_WAYPOINT, (_m, name: string, at: string) => `${name}/${at}`);
	const tokens = folded
		.split(/[ ,\n\t]/)
		.filter((s) => s !== '')
		.map((s) => s.toUpperCase());
	return tokens.map((text, i) => {
		// parse() takes the ends as the departure and the arrival ONLY where
		// aerodrome() accepts them; anything else stays in the enroute slice and
		// classifies like the rest.
		if ((i === 0 || i === tokens.length - 1) && AERODROME.test(text)) {
			return { kind: 'airport', text };
		}
		const at = LATLON.exec(text);
		// parseLatLon returns null, i.e. "some other identifier", unless both
		// halves carry a hemisphere.
		if (at && (at[1] ?? at[3]) && (at[4] ?? at[6])) {
			return { kind: 'coordinate', text };
		}
		if (USER_WAYPOINT_TOKEN.test(text)) {
			return { kind: 'user', text };
		}
		return { kind: AIRWAY.test(text) ? 'airway' : 'waypoint', text };
	});
}

describe('what SendFPL makes of the string', () => {
	it('classifies every token of a real route as it was meant', () => {
		expect(classify(buildSendFplRoute([LFPL, PONTCARRE, PMN, MLN, CHESNAY, LFPU]))).toEqual([
			{ kind: 'airport', text: 'LFPL' },
			{ kind: 'user', text: 'PONTC/N48480E002408' },
			{ kind: 'user', text: 'PMN/N48417E002432' },
			{ kind: 'user', text: 'MLN/N48273E002488' },
			{ kind: 'user', text: 'POSTE/N48234E002522' },
			{ kind: 'airport', text: 'LFPU' },
		]);
	});

	it('reads a bare position as a coordinate, not as a name', () => {
		expect(classify(buildSendFplRoute([LFPL, free(undefined, 48.8, 2.68), LFPU]))[1]).toEqual({
			kind: 'coordinate',
			text: 'N48480/E002408',
		});
	});

	it('reads nothing in an emitted route as an airway', () => {
		// A05 sits mid-route here, where a bare identifier would be read as one,
		// and 8837 of the 41664 identifiers in airports.json are that shape. This
		// is why the module needs no airway heuristic of its own any more.
		const r = buildSendFplRoute([
			LFPL,
			nav('WM801', 48.8, 2.68),
			ap('A05', 48.7, 2.7),
			nav('G20A', 48.6, 2.75),
			LFPU,
		]);
		expect(classify(r).some((t) => t.kind === 'airway')).toBe(false);
		// The point of it: bare, any of those identifiers is an airway.
		expect(classify('LFPL WM801 LFPU')[1]?.kind).toBe('airway');
	});

	it('lets an end SendFPL cannot read as an aerodrome be a point, which it is', () => {
		const tokens = classify(buildSendFplRoute([ap('AD-ALV', 42.5, 1.5), MLN, LFPU]));
		expect(tokens[0]).toEqual({ kind: 'user', text: 'ADALV/N42300E001300' });
		expect(tokens[tokens.length - 1]?.kind).toBe('airport');
	});

	it('keeps a spaced identifier to one token, so the arrival stays the arrival', () => {
		const tokens = classify(buildSendFplRoute([LFPL, nav('APS1=COLLE ROIO', 42.3, 13.4), LFPU]));
		expect(tokens).toHaveLength(3);
		expect(tokens[2]).toEqual({ kind: 'airport', text: 'LFPU' });
	});

	it('never lets a chained plan end on anything but an aerodrome identifier', () => {
		const plan = [route([LFPL, PONTCARRE, LFPU]), route([LFPU, MLN, LFPL])];
		const tokens = classify(buildSendFplPlan(plan));
		for (const end of [tokens[0], tokens[tokens.length - 1]]) {
			expect(end?.kind).toBe('airport');
			// AIRPORT_NAME_LEN: the :DA: / :AA: handler reads four characters.
			expect(end?.text).toMatch(/^[A-Z0-9]{1,4}$/);
		}
	});
});

/* Which way out the route takes. The judgement is pure and takes the platform
 * as arguments, the safeArea.ts pattern, so the ladder is pinned without
 * standing up a navigator. */
describe('handoffFor', () => {
	it('gives the shell its explicit intent whatever the browser also offers', () => {
		expect(handoffFor(true, true, true)).toBe('intent');
		expect(handoffFor(true, false, false)).toBe('intent');
	});

	it('shares from an Android browser, where SendFPL is in the sheet', () => {
		expect(handoffFor(false, true, true)).toBe('share');
	});

	it('copies when the sheet cannot hold SendFPL, whatever the API says', () => {
		// A desktop sheet lists mail and messengers, never an Android app, and
		// the clipboard pastes into SendFPL's own route box.
		expect(handoffFor(false, false, true)).toBe('clipboard');
	});

	it('copies on Android without the API, which is the raw WebView', () => {
		expect(handoffFor(false, true, false)).toBe('clipboard');
	});
});

describe('the second-pass pins', () => {
	it('writes the Lognes ARP the way the contract document quotes it', () => {
		expect(at(LFPL)).toBe('N48493E002374');
	});

	it('encodes the origin, negative zero included, as N00000E000000', () => {
		expect(formatArincLatLon(0, 0)).toBe('N00000E000000');
		expect(formatArincLatLon(-0, -0)).toBe('N00000E000000');
	});

	it('wraps the map\'s raw longitude and clamps the latitude before encoding', () => {
		// Leaflet hands a waypoint dropped on the second world copy a
		// longitude past 180; SendFPL\'s decoder throws on it.
		expect(formatArincLatLon(48.82, 362.62)).toBe('N48492E002372');
		expect(formatArincLatLon(48.82, -357.38)).toBe('N48492E002372');
		expect(formatArincLatLon(48, 180)).toBe('N48000W180000');
		expect(formatArincLatLon(95, 0)).toBe('N90000E000000');
	});

	it('carries the position on a short-named free point at an end', () => {
		// Four alphanumerics is what SendFPL reads as an aerodrome, but only
		// an AERODROME goes bare; a strip the pilot called HOME is a point.
		const home = free('Home', 48.9, 2.5);
		const r = buildSendFplRoute([home, MLN, LFPU]).split(' ');
		expect(r[0]).toBe(`HOME,${at(home)}`);
	});

	it('sends a nameless free point at an end as a bare position', () => {
		const strip = free(undefined, 48.9, 2.5);
		const r = buildSendFplRoute([strip, MLN, LFPU]).split(' ');
		expect(r[0]).toBe(at(strip));
	});

	it('drops an adjacent repeat inside one route, as the plan chain does', () => {
		expect(buildSendFplRoute([LFPL, MLN, MLN, LFPU])).toBe(
			buildSendFplRoute([LFPL, MLN, LFPU]),
		);
	});

	it('keys the junction on the identifier, never on a resolved label or position', () => {
		// One leg typed before the AIXM overlay landed, the next after it:
		// the same aerodrome resolved with another name and an ARP a hair
		// away. One place, one token.
		const before = wp({ kind: 'airport', ident: 'LFPU', label: 'Moret', lat: 48.35, lon: 2.8 });
		const after = wp({ kind: 'airport', ident: 'LFPU', label: 'Moret Episy', lat: 48.3501, lon: 2.8001 });
		const LFGO = ap('LFGO', 48.0, 3.1);
		const r = buildSendFplPlan([route([LFPL, before]), route([after, LFGO])]).split(' ');
		expect(r).toEqual(['LFPL', `LFPU,${at(before)}`, 'LFGO']);
	});

	it('leaves a route short of a leg out of the plan, so the arrival stays the arrival', () => {
		const LFGO = ap('LFGO', 48.0, 3.1);
		const scratch = free('Scratch', 48.9, 2.9);
		const r = buildSendFplPlan([route([LFPL, LFPU]), route([LFPU, LFGO]), route([scratch])]).split(' ');
		expect(r[r.length - 1]).toBe('LFGO');
	});

	it('never rewrites an end binding: a mid-route pass over the departure keeps its name', () => {
		// Two ends answering to one identifier at positions a hair apart (the
		// same drift as above): the FIRST binding stands, so the overflight of
		// the departure at its own position is LFPL, not LFPL2.
		const a = ap('LFPL', 48.821944, 2.622778);
		const b = ap('LFPL', 48.8229, 2.6228);
		const r = buildSendFplRoute([a, MLN, ap('LFPL', a.lat, a.lon), CHESNAY, b]).split(' ');
		expect(r[2]).toBe(`LFPL,${at(a)}`);
	});

	it('gives an end the dataset knows the navigator will not resolve its position', () => {
		const closed = ap('LF10', 48.5, 2.9);
		const r = buildSendFplRoute([LFPL, MLN, closed], {
			knownAerodrome: (ident) => ident !== 'LF10',
		}).split(' ');
		expect(r[r.length - 1]).toBe(`LF10,${at(closed)}`);
		// The default trusts every well-shaped identifier.
		expect(buildSendFplRoute([LFPL, MLN, closed]).split(' ').pop()).toBe('LF10');
	});
});
