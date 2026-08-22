/* The route string handed to SendFPL: the position encoding, the per-waypoint
 * rules, and the whole-plan chain (docs/sendfpl.md).
 *
 * The classification block is a contract test. SendFPL's own grammar is
 * transcribed here from the sibling garmin-cxp project (cxp/FlightPlan.kt,
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
	it('sends anchored waypoints by identifier and free points by position', () => {
		expect(buildSendFplRoute([LFPL, PONTCARRE, PMN, MLN, CHESNAY, LFPU])).toBe(
			'LFPL PONTC,N48480E002408 PMN MLN POSTE,N48234E002522 LFPU',
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

	it('never shadows an identifier already in the route', () => {
		// A turning point the pilot named after the beacon it sits on: the
		// navigator would have two points answering to MLN otherwise.
		const r = buildSendFplRoute([LFPL, MLN, free('MLN', 48.5, 2.8), LFPU]);
		expect(r).toBe('LFPL MLN MLN2,N48300E002480 LFPU');
	});

	it('gives an airway-shaped navaid its position, so it is not read as an airway', () => {
		// WM801 is a real waypoint in fr-navaids.json, and SendFPL's heuristic
		// (a letter or two then digits) would send a bare WM801 as an airway.
		expect(buildSendFplRoute([LFPL, nav('WM801', 48.8, 2.68), LFPU])).toBe(
			'LFPL WM801,N48480E002408 LFPU',
		);
	});

	it('leaves an airway-shaped airport identifier alone', () => {
		// Thousands of local codes are this shape (A05, AA00), and an airport has
		// to stay a bare identifier: :DA: / :AA: will not take a position.
		expect(buildSendFplRoute([ap('A05', 48.8, 2.68), MLN, ap('AA00', 48.35, 2.8)])).toBe(
			'A05 MLN AA00',
		);
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
		expect(buildSendFplPlan(plan)).toBe('LFPL PMN LFPU MLN LFGO LFPK LFPL');
	});

	it('leaves alternates out: they are diversions, not part of the flight', () => {
		const plan = [route([LFPL, PMN, LFPU]), route([LFPU, LFGO], true), route([LFPU, MLN, LFPL])];
		expect(buildSendFplPlan(plan)).toBe('LFPL PMN LFPU MLN LFPL');
	});

	it('keeps a genuine there-and-back, which repeats no token in a row', () => {
		expect(buildSendFplPlan([route([LFPL, LFPU]), route([LFPU, LFPL])])).toBe('LFPL LFPU LFPL');
	});

	it('fits the names across the whole chain, not per leg', () => {
		const plan = [
			route([LFPL, PONTCARRE, LFPU]),
			route([LFPU, free('Pontcarré sud', 48.75, 2.68), LFPL]),
		];
		// Each leg names its own point; the two are distinct points and both keep
		// a readable name, which is what matters on the navigator.
		expect(buildSendFplPlan(plan)).toBe(
			'LFPL PONTC,N48480E002408 LFPU PONTC,N48450E002408 LFPL',
		);
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
		if (i === 0 || i === tokens.length - 1) {
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
			{ kind: 'waypoint', text: 'PMN' },
			{ kind: 'waypoint', text: 'MLN' },
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

	it('reads an airway-shaped navaid as a user waypoint once it carries its position', () => {
		expect(classify(buildSendFplRoute([LFPL, nav('WM801', 48.8, 2.68), LFPU]))[1]?.kind).toBe(
			'user',
		);
		// The point of the rule: bare, that same identifier would be an airway.
		expect(classify('LFPL WM801 LFPU')[1]?.kind).toBe('airway');
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
