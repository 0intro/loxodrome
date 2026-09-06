import { describe, it, expect } from 'vitest';
import {
	buildNarrowRouteBody,
	latLonToSofiaToken,
	narrowRouteTokens,
	parseSofiaResponse,
	sofiaNotamToIcaoText,
	SOFIA_DURATION_HHMM,
	SOFIA_DURATION_MS,
	type NarrowRoutePoint,
	type SofiaNotam,
} from '$lib/sofia/client';
import {
	clearerFailure,
	fetchFailure,
	httpFailure,
	noAerodromeFailure,
	payloadFailure,
	retryBudget,
	type SofiaFailure,
} from '$lib/sofia/failure';
import { parseNotams } from '$lib/notam/parser';

// Fixture NOTAMs mirroring the real SOFIA response fields (an ICAO-format
// coordinate, a split Q-code, the ISO validity pair, F/G limits, "PERM").

// New/replace aerodrome NOTAM with a NOTAMR predecessor.
const NOTAM_A: SofiaNotam = {
	id: 'A1',
	series: 'E',
	number: 3272,
	year: 26,
	type: 'R',
	referredSeries: 'E',
	referredNumber: 3111,
	referredYear: 26,
	qLine: { fir: 'LFFF', code23: 'FU', code45: 'LT', traffic: 'IV', purpose: 'NBO', scope: 'A', lower: 0, upper: 999 },
	coordinates: '4849N00237E',
	radius: 5,
	itemA: 'LFPL',
	startValidity: '2026-06-30T15:14:00Z',
	endValidity: '2026-07-08T23:59:00Z',
	itemE: 'UL AERO NOT AVBL.',
	multiLanguage: { itemE: 'UL AERO NON DISPONIBLE.' },
};

// En-route NOTAM with an activity schedule (D) and vertical limits (F/G).
const NOTAM_B: SofiaNotam = {
	id: 'B1',
	series: 'A',
	number: 4121,
	year: 26,
	type: 'N',
	qLine: { fir: 'LFFF', code23: 'SE', code45: 'AU', traffic: 'IV', purpose: 'BO', scope: 'AE', lower: 0, upper: 85 },
	coordinates: '4924N00312E',
	radius: 29,
	itemA: 'LFOB',
	startValidity: '2026-07-01T00:00:00Z',
	endValidity: '2026-07-31T23:59:00Z',
	itemD: '01-12 14-17 19 21 23 26-31 H24',
	itemE: "'BEAUVAIS' INFO FREQ 119.800MHZ NOT AVBL.",
	itemF: 'SFC',
	itemG: '1700FT AMSL',
};

// Permanent en-route NOTAM ("PERM" end validity).
const NOTAM_C: SofiaNotam = {
	id: 'C1',
	series: 'F',
	number: 1170,
	year: 26,
	type: 'R',
	referredSeries: 'F',
	referredNumber: 695,
	referredYear: 26,
	qLine: { fir: 'LFFF', code23: 'AN', code45: 'XX', traffic: 'I', purpose: 'BO', scope: 'E', lower: 65, upper: 195 },
	coordinates: '4943N00120E',
	radius: 79,
	itemA: 'LFFF',
	startValidity: '2026-06-02T07:27:00Z',
	endValidity: 'PERM',
	itemE: 'REVERSAL OF THE PARITY OF THE LOWER ROUTE R50.',
};

/** A response envelope whose stringified `status.message` nests the NOTAMs the
 *  heterogeneous way SOFIA does, with NOTAM_A appearing twice (ADDep + FIR). */
function envelope(): unknown {
	return {
		'status.code': '200',
		'status.message': JSON.stringify({
			nbNotams: 3,
			listnotams: {
				ADDep: { code: 'LFPL', name: 'LOGNES', avertissements_navigation: [NOTAM_A] },
				FIR: {
					organisation_espace_procedures: {
						code23: 'SE',
						sortedNotamsByImpactedAerodromes: [
							{ code: 'LFOB', name: 'BEAUVAIS', notam: [NOTAM_A, NOTAM_B] },
						],
						sortedNotamsByPurpose: [{ notam: [NOTAM_C] }],
					},
				},
				Other: [],
				// A non-NOTAM object (no qLine) the walk must skip.
				_meta: { note: 'not a notam' },
			},
		}),
	};
}

describe('buildNarrowRouteBody', () => {
	it('encodes the postNarrowRoutePibRequest form the way SOFIA expects', () => {
		const body = buildNarrowRouteBody(['LFPL', '4900N00230E', 'LFPK'], {
			widthNM: 15,
			radiusADNM: 10,
			validFrom: new Date('2026-07-03T23:05:00Z'),
		});
		const p = new URLSearchParams(body);
		expect(p.get(':operation')).toBe('postNarrowRoutePibRequest');
		expect(p.getAll('route[]')).toEqual(['LFPL', '4900N00230E', 'LFPK']);
		expect(p.get('width')).toBe('15');
		expect(p.get('radiusAD')).toBe('10');
		expect(p.get('fl_lower')).toBe('0');
		expect(p.get('fl_upper')).toBe('999');
		expect(p.get('traffic')).toBe('VI');
		// HHMM look-ahead, capped at ~24 h.
		expect(p.get('duration')).toBe('2359');
		expect(p.get('valid_from')).toBe('2026-07-03T23:05:00Z');
		expect(p.get('departure_date')).toBe('03-07-2026');
		expect(p.get('departure_time')).toBe('2305');
		expect(p.get('lang')).toBe('fr');
	});

	// The duration is the only statement of what a briefing covers in TIME,
	// and the fetch view derives its coverage caution from it rather than
	// restating the figure. If the two drift, a period wider than the
	// briefing reads as fully briefed again.
	it('derives the briefed span from the duration it actually sends', () => {
		const body = buildNarrowRouteBody(['LFPL', 'LFPK'], {
			widthNM: 15,
			radiusADNM: 10,
			validFrom: new Date('2026-07-03T23:05:00Z'),
		});
		expect(new URLSearchParams(body).get('duration')).toBe(SOFIA_DURATION_HHMM);
		// 23:59 as milliseconds, one minute short of a full day.
		expect(SOFIA_DURATION_MS).toBe(86_340_000);
		expect(SOFIA_DURATION_MS).toBeLessThan(24 * 3600 * 1000);
	});

	it('upper-cases and trims route tokens (SOFIA rejects lower-case idents)', () => {
		const body = buildNarrowRouteBody([' lfpl ', 'lfpk', ''], {
			widthNM: 15,
			radiusADNM: 10,
			validFrom: new Date('2026-07-03T23:05:00Z'),
		});
		// Blank tokens dropped; the rest canonicalised to trimmed upper-case.
		expect(new URLSearchParams(body).getAll('route[]')).toEqual(['LFPL', 'LFPK']);
	});
});

describe('narrowRouteTokens', () => {
	const ad = (token: string): NarrowRoutePoint => ({ token, aerodrome: true });
	const pt = (token: string): NarrowRoutePoint => ({ token, aerodrome: false });

	/** The whole point of the retrace: SOFIA corridors the union of the
	 *  segments between consecutive tokens, so every consecutive pair emitted
	 *  has to be a pair that is ADJACENT on the drawn route. Anything else
	 *  would brief a corridor the aircraft never flies. */
	function everyPairIsARouteLeg(points: NarrowRoutePoint[], tokens: string[]): boolean {
		const legs = new Set<string>();
		for (let i = 1; i < points.length; i++) {
			legs.add(`${points[i - 1].token}|${points[i].token}`);
			legs.add(`${points[i].token}|${points[i - 1].token}`);
		}
		for (let i = 1; i < tokens.length; i++) {
			if (!legs.has(`${tokens[i - 1]}|${tokens[i]}`)) {
				return false;
			}
		}
		return true;
	}

	it('leaves an aerodrome-to-aerodrome route exactly as drawn', () => {
		// The common case: nothing to fix, so nothing changes.
		const points = [ad('LFPL'), pt('4823N00252E'), ad('LFEM')];
		expect(narrowRouteTokens(points)).toEqual(['LFPL', '4823N00252E', 'LFEM']);
	});

	it('retraces to an aerodrome when the route ends on a free point', () => {
		// The LFEM alternate drawn to a pin: SOFIA answers
		// "Erreur serveur : Le format d'un des paramètres n'est pas bon :
		// route[]" for a coordinate at either end, and briefs the same
		// corridor when the walk comes back.
		const points = [ad('LFEM'), pt('4754N00211E')];
		expect(narrowRouteTokens(points)).toEqual(['LFEM', '4754N00211E', 'LFEM']);
	});

	it('retraces when the route STARTS on a free point', () => {
		const points = [pt('4754N00211E'), ad('LFEM')];
		expect(narrowRouteTokens(points)).toEqual(['LFEM', '4754N00211E', 'LFEM']);
	});

	it('anchors on an aerodrome in the middle, walking each side out and back', () => {
		const points = [pt('4754N00211E'), ad('LFEM'), pt('4800N00300E')];
		expect(narrowRouteTokens(points)).toEqual([
			'LFEM',
			'4754N00211E',
			'LFEM',
			'4800N00300E',
			'LFEM',
		]);
	});

	it('uses the first and last aerodromes, so only the loose ends are retraced', () => {
		const points = [pt('P0'), ad('LFPL'), pt('P2'), ad('LFEM'), pt('P4')];
		expect(narrowRouteTokens(points)).toEqual([
			'LFPL',
			'P0',
			'LFPL',
			'P2',
			'LFEM',
			'P4',
			'LFEM',
		]);
	});

	it('never widens the corridor: every pair it emits is a leg of the route', () => {
		const routes: NarrowRoutePoint[][] = [
			[ad('LFPL'), pt('P1'), ad('LFEM')],
			[ad('LFEM'), pt('P1')],
			[pt('P0'), ad('LFEM')],
			[pt('P0'), ad('LFEM'), pt('P2')],
			[pt('P0'), ad('LFPL'), pt('P2'), ad('LFEM'), pt('P4')],
			[pt('P0'), pt('P1'), ad('LFPL'), pt('P3'), pt('P4')],
		];
		for (const points of routes) {
			const tokens = narrowRouteTokens(points);
			expect(tokens).not.toBeNull();
			expect(everyPairIsARouteLeg(points, tokens ?? [])).toBe(true);
			// And an aerodrome at each end, which is all SOFIA asks for.
			const idents = new Set(points.filter((p) => p.aerodrome).map((p) => p.token));
			expect(idents.has(tokens?.[0] ?? '')).toBe(true);
			expect(idents.has(tokens?.[tokens.length - 1] ?? '')).toBe(true);
		}
	});

	it('never demotes an aerodrome the route already departs from or arrives at', () => {
		// The retrace can only ADD the radiusAD scan an endpoint gets, so a
		// briefing can grow but never shrink.
		expect(narrowRouteTokens([ad('LFPL'), pt('P1'), ad('LFEM')])?.[0]).toBe('LFPL');
		expect(narrowRouteTokens([ad('LFPL'), pt('P1'), pt('P2')])?.[0]).toBe('LFPL');
		const arriving = narrowRouteTokens([pt('P0'), pt('P1'), ad('LFEM')]);
		expect(arriving?.[arriving.length - 1]).toBe('LFEM');
	});

	it('reports a route with no aerodrome at all instead of guessing one', () => {
		expect(narrowRouteTokens([pt('4754N00211E'), pt('4800N00300E')])).toBeNull();
		expect(narrowRouteTokens([])).toBeNull();
	});
});

describe('parseSofiaResponse', () => {
	it('walks the grouped tree and de-duplicates a NOTAM seen under two branches', () => {
		const notams = parseSofiaResponse(envelope());
		expect(notams).toHaveLength(3);
		const ids = notams.map((n) => n.id).sort();
		expect(ids).toEqual(['A1', 'B1', 'C1']);
	});

	it('throws a readable error when SOFIA reports a server error', () => {
		// A rejected request (e.g. a route whose endpoints aren't aerodromes)
		// returns status.message as plain text, not the JSON NOTAM tree.
		expect(() =>
			parseSofiaResponse({ 'status.code': '500', 'status.message': 'Erreur serveur : bad route' }),
		).toThrow(/SOFIA: Erreur serveur/);
	});

	it('throws on a payload without a briefing message', () => {
		expect(() => parseSofiaResponse({})).toThrow();
		expect(() => parseSofiaResponse(null)).toThrow();
	});
});

describe('sofiaNotamToIcaoText', () => {
	it('reconstructs an ICAO block from a typical NOTAM', () => {
		const text = sofiaNotamToIcaoText(NOTAM_A);
		expect(text.split('\n')[0]).toBe('E3272/26 NOTAMR E3111/26');
		expect(text).toMatch(/\nQ\) LFFF\/QFULT\/IV\/NBO\/A\/000\/999\/4849N00237E005/);
		expect(text).toContain('A) LFPL');
		expect(text).toContain('B) 2606301514 C) 2607082359');
		expect(text).toContain('E) UL AERO NOT AVBL.');
	});

	it('selects the E-item language, falling back when only one form exists', () => {
		// NOTAM_A carries both forms; 'fr' takes multiLanguage.itemE, the default 'en' itemE.
		expect(sofiaNotamToIcaoText(NOTAM_A, 'fr')).toContain('E) UL AERO NON DISPONIBLE.');
		expect(sofiaNotamToIcaoText(NOTAM_A, 'en')).toContain('E) UL AERO NOT AVBL.');
		expect(sofiaNotamToIcaoText(NOTAM_A)).toContain('E) UL AERO NOT AVBL.');
		// NOTAM_B carries only the English form; 'fr' falls back to it.
		expect(sofiaNotamToIcaoText(NOTAM_B, 'fr')).toContain(
			"E) 'BEAUVAIS' INFO FREQ 119.800MHZ NOT AVBL.",
		);
	});

	it('emits D) / F) / G) and PERM where present', () => {
		const b = sofiaNotamToIcaoText(NOTAM_B);
		expect(b).toContain('D) 01-12 14-17 19 21 23 26-31 H24');
		expect(b).toContain('F) SFC');
		expect(b).toContain('G) 1700FT AMSL');
		const c = sofiaNotamToIcaoText(NOTAM_C);
		expect(c).toContain('C) PERM');
	});

	it('returns the empty string for a record with no id and no Q-line', () => {
		expect(sofiaNotamToIcaoText({})).toBe('');
	});

	it('round-trips through parseNotams into a complete Notam', () => {
		const [n] = parseNotams(sofiaNotamToIcaoText(NOTAM_A));
		expect(n.id).toBe('E3272/26');
		expect(n.replaces).toBe('E3111/26');
		expect(n.qCode).toBe('QFULT');
		expect(n.qualifier?.fir).toBe('LFFF');
		expect(n.qualifier?.traffic).toBe('IV');
		expect(n.qualifier?.scope).toBe('A');
		expect(n.qualifier?.lat).toBeCloseTo(48.82, 1);
		expect(n.qualifier?.lon).toBeCloseTo(2.62, 1);
		expect(n.qualifier?.radius).toBe(5);
		expect(n.icaoCodes).toEqual(['LFPL']);
		expect(n.startDate?.toISOString()).toBe('2026-06-30T15:14:00.000Z');
	});

	it('parses a permanent NOTAM as permanent', () => {
		const [n] = parseNotams(sofiaNotamToIcaoText(NOTAM_C));
		expect(n.permanent).toBe(true);
	});

	it('feeds the whole briefing through parseNotams', () => {
		const text = parseSofiaResponse(envelope())
			.map((n) => sofiaNotamToIcaoText(n))
			.join('\n\n');
		const notams = parseNotams(text);
		expect(notams.map((n) => n.id).sort()).toEqual(['A4121/26', 'E3272/26', 'F1170/26']);
	});
});

describe('latLonToSofiaToken', () => {
	it('formats DDMM[N/S]DDDMM[E/W], rounded to the minute', () => {
		expect(latLonToSofiaToken(48.8167, 2.6167)).toBe('4849N00237E');
		expect(latLonToSofiaToken(-9.5, -0.5)).toBe('0930S00030W');
	});
});

// The proxy answers its refusals and upstream errors as plain text with a
// status; SOFIA's own errors arrive as a JSON envelope. A skipped route is
// reported to the pilot, so each of those has to reach a distinct cause.
function response(status: number, headers: Record<string, string> = {}): Response {
	return new Response('', { status, headers });
}

describe('fetchFailure', () => {
	it('reads a spent client budget as a timeout', () => {
		// What AbortSignal.timeout rejects with.
		const e = new DOMException('signal timed out', 'TimeoutError');
		expect(fetchFailure(e, 'https://proxy.test').code).toBe('timeout');
	});

	it('reads the pilot’s own stop as cancelled, not as a fault', () => {
		// Stop and the budget share one AbortSignal.any; only the name differs.
		const e = new DOMException('The operation was aborted', 'AbortError');
		expect(fetchFailure(e, 'https://proxy.test').code).toBe('cancelled');
	});

	it('reads a response that never arrived as unreachable, naming the proxy', () => {
		const f = fetchFailure(new TypeError('Failed to fetch'), 'https://proxy.test');
		expect(f.code).toBe('unreachable');
		expect(f.detail).toContain('https://proxy.test');
		expect(f.detail).toContain('Failed to fetch');
	});
});

describe('httpFailure', () => {
	it('reads 429 as busy and keeps Retry-After in seconds', () => {
		const f = httpFailure(response(429, { 'Retry-After': '12' }), 'server busy: retry shortly');
		expect(f.code).toBe('busy');
		expect(f.retryAfterS).toBe(12);
		expect(f.detail).toContain('server busy');
	});

	it('reads 429 without Retry-After as busy with no wait to quote', () => {
		const f = httpFailure(response(429), '');
		expect(f.code).toBe('busy');
		expect(f.retryAfterS).toBeUndefined();
	});

	it('reads 404 as a worker that predates the route', () => {
		expect(httpFailure(response(404), 'not found').code).toBe('notDeployed');
	});

	it('reads the worker 502 as an upstream failure', () => {
		const f = httpFailure(response(502), 'upstream error: The operation was aborted');
		expect(f.code).toBe('upstream');
		expect(f.detail).toContain('aborted');
	});

	it('reads any other status as a proxy failure, framed with the status', () => {
		expect(httpFailure(response(413), 'body too large')).toEqual({
			code: 'proxy',
			detail: 'SOFIA fetch failed: HTTP 413: body too large',
		});
	});
});

describe('payloadFailure', () => {
	it('reads SOFIA’s own server error as a refusal', () => {
		// unwrapSofiaMessage prefixes the plain-text status.message with "SOFIA: ".
		const f = payloadFailure(new Error('SOFIA: Erreur serveur : la route est invalide'));
		expect(f.code).toBe('refused');
		expect(f.detail).toContain('Erreur serveur');
	});

	it('reads an envelope shape it cannot read as malformed', () => {
		expect(payloadFailure(new Error('SOFIA returned no payload.')).code).toBe('malformed');
	});
});

describe('clearerFailure', () => {
	const timeout: SofiaFailure = { code: 'timeout', detail: 'SOFIA briefing timed out' };
	const refused: SofiaFailure = { code: 'refused', detail: 'SOFIA: Erreur serveur' };
	const busy: SofiaFailure = { code: 'busy', detail: 'HTTP 429' };

	it('prefers a retry that reached SOFIA over a first attempt that timed out', () => {
		expect(clearerFailure(timeout, refused)).toBe(refused);
	});

	it('keeps the first failure when the retry explains no more', () => {
		expect(clearerFailure(refused, timeout)).toBe(refused);
		expect(clearerFailure(timeout, busy)).toBe(timeout);
	});
});

describe('retryBudget', () => {
	it('never retries a decision', () => {
		// A proxy 429 turned us away on purpose, and a Stop is the pilot's.
		expect(retryBudget('busy')).toBe(0);
		expect(retryBudget('cancelled')).toBe(0);
		// Settled here, without asking; there is nothing to ask again.
		expect(retryBudget('noAerodrome')).toBe(0);
		expect(noAerodromeFailure().code).toBe('noAerodrome');
	});

	it('tries SOFIA’s own transient refusal twice', () => {
		// Measured 2026-07-29: 2 of 12 paced requests came back
		// "Erreur serveur : Le format d'un des paramètres n'est pas bon"
		// against a body SOFIA accepted either side of it, and both
		// recovered on the next attempt. They fail in seconds, so a second
		// retry is cheap.
		expect(retryBudget('refused')).toBe(2);
		expect(retryBudget('malformed')).toBe(2);
	});

	it('tries a transport failure once, since each attempt can cost the whole budget', () => {
		expect(retryBudget('timeout')).toBe(1);
		expect(retryBudget('unreachable')).toBe(1);
		expect(retryBudget('upstream')).toBe(1);
		expect(retryBudget('proxy')).toBe(1);
		expect(retryBudget('notDeployed')).toBe(1);
	});
});
