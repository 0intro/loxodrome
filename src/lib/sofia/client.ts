/**
 * SOFIA-Briefing client core: build the briefing request body, unpack the
 * response, and reconstruct each NOTAM as ICAO text so the existing
 * `parseNotams()` handles SOFIA-sourced NOTAMs exactly like paste / upload /
 * autorouter. Pure and unit-tested; the transport (proxy + session handshake)
 * lives in the worker + `fetch.ts`.
 *
 * SOFIA (the French DSNA/SIA pre-flight briefing service) exposes an anonymous
 * Apache-Sling backend: `POST /sofia` with `:operation=postNarrowRoutePibRequest`
 * returns a JSON envelope whose `status.message` is a *stringified* JSON tree of
 * NOTAMs grouped by FIR / aerodrome / purpose. Every NOTAM already carries its
 * ICAO fields (a split Q-code, item A, the E-text, F/G limits, an ICAO-format
 * coordinate and radius), so the reconstruction here is a light re-assembly, the
 * SOFIA analogue of autorouter's `rowToIcaoText`. The request/response shape was
 * reverse-engineered and confirmed against the live service; see
 * `notam-proxy/worker.js` (handleSofia) for the transport half.
 */

import type { Locale } from '$lib/i18n/locale';

/** The split ICAO Q-code line as SOFIA returns it. `code23`/`code45` are the
 *  2nd-3rd and 4th-5th Q-code letters (so `Q` + code23 + code45 = the 5-char
 *  Q-code, e.g. code23="FU" + code45="LT" -> "QFULT"). */
export interface SofiaQLine {
	fir?: string;
	code23?: string;
	code45?: string;
	traffic?: string;
	purpose?: string;
	scope?: string;
	lower?: number;
	upper?: number;
}

/** One NOTAM as it appears (repeatedly, under several groupings) in the SOFIA
 *  response tree. Every field is optional; we read only what we re-emit. */
export interface SofiaNotam {
	/** SOFIA's internal record id, unique per NOTAM instance in a response;
	 *  used only to de-duplicate the tree walk. */
	id?: string | number;
	series?: string;
	number?: string | number;
	year?: string | number;
	/** N (new) / R (replace) / C (cancel). */
	type?: string;
	referredSeries?: string;
	referredNumber?: string | number;
	referredYear?: string | number;
	qLine?: SofiaQLine;
	/** ICAO Q-line coordinate, already compacted, e.g. "4849N00237E". */
	coordinates?: string;
	/** Radius in nautical miles. */
	radius?: number;
	itemA?: string;
	/** ISO 8601 UTC, e.g. "2026-06-30T15:14:00Z". */
	startValidity?: string;
	/** ISO 8601 UTC, or the literal "PERM". */
	endValidity?: string;
	itemD?: string;
	/** The E-section free text (English on the FR listing). */
	itemE?: string;
	/** The parallel-language E-text; `multiLanguage.itemE` is the French form. */
	multiLanguage?: { itemE?: string };
	/** Lower vertical limit, SIA vocabulary ("SFC", "1700FT AMSL", "FL065"). */
	itemF?: string;
	/** Upper vertical limit. */
	itemG?: string;
}

/** One drawn waypoint as SOFIA sees it: the `route[]` token it travels as, and
 *  whether that token is an aerodrome ICAO ident, the only thing SOFIA reads at
 *  either end of a route. */
export interface NarrowRoutePoint {
	token: string;
	aerodrome: boolean;
}

/** Inputs for one narrow-route briefing request. */
export interface NarrowRouteOptions {
	/** Corridor half-width each side of the track, NM (the app's
	 *  `corridorRadiusNM`; SOFIA reports back double this as `routeWidth`). */
	widthNM: number;
	/** Radius around each aerodrome in the route, NM. */
	radiusADNM: number;
	/** The instant the briefing window opens; SOFIA covers ~24 h from here. */
	validFrom: Date;
}

/** The look-ahead SOFIA is asked for, HHMM. It caps a narrow-route PIB at
 *  ~24 h, so this is both the request and the honest statement of what the
 *  resulting briefing covers in TIME: the coverage the fetch view reports
 *  is otherwise purely spatial, and a viewing period wider than this would
 *  read as briefed when it is not. */
export const SOFIA_DURATION_HHMM = '2359';

/** That same look-ahead as milliseconds, for the briefed-interval stamp. */
export const SOFIA_DURATION_MS =
	(Number(SOFIA_DURATION_HHMM.slice(0, 2)) * 60 + Number(SOFIA_DURATION_HHMM.slice(2))) * 60_000;

const pad2 = (v: number | string): string => String(v).padStart(2, '0');
const pad3 = (v: number | string): string => String(v).padStart(3, '0');
const pad4 = (v: number | string): string => String(v).padStart(4, '0');

/** Order one drawn route's `route[]` tokens so SOFIA will accept them, without
 *  widening the corridor by a mile.
 *
 *  SOFIA reads the FIRST and LAST tokens as the PIB's departure and destination
 *  aerodromes and refuses anything else there: either end a coordinate answers
 *  `500 Erreur serveur : Le format d'un des paramètres n'est pas bon : route[]`
 *  (verified live, both ends and each end alone), while a coordinate is
 *  accepted for every point in between. A route drawn to a free point or to a
 *  navaid (which goes by coordinate too, since SOFIA rejects some navaid
 *  idents) therefore cannot be sent as it stands, though its corridor is
 *  perfectly briefable.
 *
 *  So the walk RETRACES: it starts at the first aerodrome on the route, walks
 *  back over whatever precedes it and forward again, runs the route, then walks
 *  out past the last aerodrome and back to it. Every consecutive pair it emits
 *  is an adjacent pair of the drawn route, and SOFIA corridors the UNION of the
 *  segments, so the briefed corridor is exactly the drawn one; a retraced leg
 *  is simply briefed twice and answers the same. `[LFEM, 4754N00211E]` goes out
 *  as `[LFEM, 4754N00211E, LFEM]`, `[x, LFEM, y]` as `[LFEM, x, LFEM, y, LFEM]`.
 *
 *  The walk never DEMOTES an aerodrome: the first token is the first aerodrome
 *  on the route (so a route already departing one keeps it there) and the last
 *  is the last (same). An aerodrome only ever gains the `radiusAD` scan an
 *  endpoint gets, so the briefing can only grow. A route already flying
 *  aerodrome to aerodrome, the common case, comes back unchanged.
 *
 *  null when NO waypoint is an aerodrome: neither end has anything to anchor
 *  on, and a route SOFIA cannot brief is reported rather than guessed at. */
export function narrowRouteTokens(points: NarrowRoutePoint[]): string[] | null {
	let first = -1;
	let last = -1;
	for (const [i, p] of points.entries()) {
		if (p.aerodrome) {
			if (first < 0) {
				first = i;
			}
			last = i;
		}
	}
	if (first < 0) {
		return null;
	}
	const end = points.length - 1;
	return [
		// Back to the start from the first aerodrome, then forward over the
		// route. Both are the plain route when it already departs an aerodrome.
		...points.slice(0, first + 1).reverse(),
		...points.slice(1, last + 1),
		// Out past the last aerodrome and back to it; both empty when the route
		// already arrives at one.
		...points.slice(last + 1),
		...points.slice(last, end).reverse(),
	].map((p) => p.token);
}

/** Build the `application/x-www-form-urlencoded` body for a
 *  `postNarrowRoutePibRequest`. `route` is the ordered list of track tokens:
 *  ICAO aerodrome / navaid idents, or ICAO-format coordinate tokens
 *  (`4900N00230E`) for free points; SOFIA requires the endpoints to be
 *  aerodromes. The worker owns the session handshake; this body travels
 *  through it verbatim. */
export function buildNarrowRouteBody(route: string[], opts: NarrowRouteOptions): string {
	const p = new URLSearchParams();
	p.append(':operation', 'postNarrowRoutePibRequest');
	for (const token of route) {
		// SOFIA is case-sensitive: a lower-case ident is rejected with a generic
		// "Votre requête n'a pas abouti". Canonicalise to trimmed upper-case; a
		// coordinate token is already upper-case, so this is idempotent for it.
		// Empty tokens are dropped rather than sent as a blank route[].
		const t = token.trim().toUpperCase();
		if (t) {
			p.append('route[]', t);
		}
	}
	p.append('width', String(Math.round(opts.widthNM)));
	p.append('radiusAD', String(Math.round(opts.radiusADNM)));
	// Whole vertical band: the app's own altitude filter narrows the display.
	p.append('fl_lower', '0');
	p.append('fl_upper', '999');
	// Both flight rules; the app's flight-rules filter narrows the display.
	p.append('traffic', 'VI');
	// Look-ahead window, HHMM; SOFIA caps a narrow-route PIB at ~24 h (2359).
	p.append('duration', SOFIA_DURATION_HHMM);
	p.append('valid_from', isoZ(opts.validFrom));
	p.append('departure_date', sofiaDate(opts.validFrom));
	p.append('departure_time', sofiaTime(opts.validFrom));
	p.append('typeVol', 'N');
	p.append('lang', 'fr');
	p.append('routeVal', 'false');
	p.append('href', '/sofia/pages/notamroute.html');
	p.append('isFromSofia', 'true');
	return p.toString();
}

/** Unpack the Sling envelope every SOFIA operation answers with: the real
 *  payload is a *stringified* JSON tree under `status.message`. Throws a
 *  readable error when SOFIA reports a server error (the message is then a
 *  plain string, not JSON). Shared by the NOTAM briefing here and the
 *  TEMSI / WINTEM chart catalog (charts.ts). */
export function unwrapSofiaMessage(payload: unknown): Record<string, unknown> {
	if (!isRecord(payload)) {
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new Error('SOFIA returned an unexpected response.');
	}
	const message = payload['status.message'];
	if (typeof message !== 'string') {
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new Error('SOFIA returned no payload.');
	}
	let inner: unknown;
	try {
		inner = JSON.parse(message);
	} catch {
		// A server error comes back with status.message as plain text, e.g.
		// "Erreur serveur : ..." (seen when a route's endpoints aren't
		// aerodromes). Surface it rather than a JSON-parse stack; the
		// "SOFIA: " prefix is what payloadFailure reads to tell a refusal
		// from an envelope shape we don't know.
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new Error('SOFIA: ' + message.trim().slice(0, 200));
	}
	if (!isRecord(inner)) {
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new Error('SOFIA returned an empty payload.');
	}
	return inner;
}

/** Unpack a SOFIA response envelope into a flat, de-duplicated NOTAM list.
 *  `payload` is the parsed JSON the worker returned. */
export function parseSofiaResponse(payload: unknown): SofiaNotam[] {
	const inner = unwrapSofiaMessage(payload);
	const notams: SofiaNotam[] = [];
	const seen = new Set<string>();
	// The tree groups NOTAMs FIR / aerodrome / purpose several ways
	// (ADDep, ADDes, FIR, Other, ...), so a NOTAM can appear more than once.
	// Walk everything and collect any object that looks like a NOTAM, keyed by
	// SOFIA's internal id so duplicates collapse.
	walk(inner['listnotams'], (n) => {
		const key = sofiaNotamKey(n);
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		notams.push(n);
	});
	return notams;
}

/** Stable de-dup key for a NOTAM instance: SOFIA's internal id when present,
 *  else the ICAO id. The same NOTAM recurs across the response groupings and,
 *  when several routes are briefed, across per-route responses. */
export function sofiaNotamKey(n: SofiaNotam): string {
	return String(n.id ?? `${n.series ?? ''}${n.number ?? ''}/${n.year ?? ''}`);
}

/** Reconstruct one SOFIA NOTAM as an ICAO-format text block ready for
 *  `parseNotams()`. Returns '' for a record too sparse to form a valid block
 *  (no id and no Q-line), mirroring autorouter's `rowToIcaoText`. `lang`
 *  selects the E-item free text when SOFIA carries both forms ('fr' prefers
 *  `multiLanguage.itemE`, else `itemE`); a NOTAM with only one form keeps it.
 *  Everything else (Q-code, items A / D / F / G) is language-neutral ICAO. */
export function sofiaNotamToIcaoText(n: SofiaNotam, lang: Locale = 'en'): string {
	const lines: string[] = [];
	const id = formatNotamId(n.series, n.number, n.year);
	const q = qLineText(n);
	if (!id && !q) {
		return '';
	}
	if (id) {
		// A replacing NOTAM names what it supersedes (NOTAMR), so the parser can
		// carry the "replaces" relationship, matching a real ICAO briefing.
		const ref =
			n.type === 'R' ? formatNotamId(n.referredSeries, n.referredNumber, n.referredYear) : '';
		lines.push(ref ? `${id} NOTAMR ${ref}` : id);
	}
	if (q) {
		lines.push(q);
	}
	if (n.itemA) {
		lines.push('A) ' + n.itemA);
	}
	const bc = validityLine(n.startValidity, n.endValidity);
	if (bc) {
		lines.push(bc);
	}
	if (n.itemD) {
		lines.push('D) ' + n.itemD);
	}
	const e =
		lang === 'fr' ? (n.multiLanguage?.itemE ?? n.itemE) : (n.itemE ?? n.multiLanguage?.itemE);
	if (e) {
		lines.push('E) ' + e);
	}
	if (n.itemF) {
		lines.push('F) ' + n.itemF);
	}
	if (n.itemG) {
		lines.push('G) ' + n.itemG);
	}
	return lines.join('\n');
}

/** ICAO-format coordinate token for a free (lat/lon) route point:
 *  `DDMM[N/S]DDDMM[E/W]`, e.g. 48.8167, 2.6167 -> "4849N00237E". SOFIA accepts
 *  these in `route[]` for intermediate points. */
export function latLonToSofiaToken(lat: number, lon: number): string {
	return dmsCompact(lat, 2, 'NS') + dmsCompact(lon, 3, 'EW');
}

// --- helpers -------------------------------------------------------------

function formatNotamId(
	series: string | undefined,
	number: string | number | undefined,
	year: string | number | undefined,
): string {
	if (series == null || number == null || year == null) {
		return '';
	}
	const yy = String(year);
	return `${series}${pad4(number)}/${yy.length === 4 ? yy.slice(-2) : pad2(yy)}`;
}

function qLineText(n: SofiaNotam): string {
	const q = n.qLine;
	// Need the FIR and a coordinate; parseQualifierLine requires a coord in the
	// 8th field, so a Q-line without one yields no qualifier anyway.
	if (!q || !q.fir || !n.coordinates) {
		return '';
	}
	const code = 'Q' + (q.code23 ?? '').trim() + (q.code45 ?? '').trim();
	const lower = pad3(q.lower ?? 0);
	const upper = q.upper != null ? pad3(q.upper) : '999';
	const radius = n.radius != null && n.radius > 0 ? pad3(Math.round(n.radius)) : '005';
	return `Q) ${q.fir}/${code}/${(q.traffic ?? '').trim()}/${(q.purpose ?? '').trim()}/${(
		q.scope ?? ''
	).trim()}/${lower}/${upper}/${n.coordinates}${radius}`;
}

function validityLine(start: string | undefined, end: string | undefined): string {
	const b = icaoDateTime(start);
	const c = end === 'PERM' ? 'PERM' : icaoDateTime(end);
	if (!b && !c) {
		return '';
	}
	let s = '';
	if (b) {
		s += 'B) ' + b;
	}
	if (c) {
		s += (s ? ' ' : '') + 'C) ' + c;
	}
	return s;
}

/** ISO 8601 UTC -> the ICAO B)/C) form YYMMDDHHMM (all UTC). '' on absent or
 *  unparseable input. */
function icaoDateTime(iso: string | undefined): string {
	if (!iso) {
		return '';
	}
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) {
		return '';
	}
	return (
		pad2(d.getUTCFullYear() % 100) +
		pad2(d.getUTCMonth() + 1) +
		pad2(d.getUTCDate()) +
		pad2(d.getUTCHours()) +
		pad2(d.getUTCMinutes())
	);
}

/** One signed degree value -> compact DMS `DDMM[hemi]` (rounded to the minute,
 *  with the 60' carry). `padDeg` is 2 for latitude, 3 for longitude. */
function dmsCompact(deg: number, padDeg: number, hemis: string): string {
	const negative = deg < 0;
	const abs = Math.abs(deg);
	const d = Math.floor(abs);
	const m = Math.round((abs - d) * 60);
	const dd = m === 60 ? d + 1 : d;
	const mm = m === 60 ? 0 : m;
	return String(dd).padStart(padDeg, '0') + pad2(mm) + hemis[negative ? 1 : 0];
}

function isoZ(d: Date): string {
	return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

function sofiaDate(d: Date): string {
	return `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

function sofiaTime(d: Date): string {
	return pad2(d.getUTCHours()) + pad2(d.getUTCMinutes());
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null;
}

/** Recursively collect NOTAM-shaped objects from the response tree. A node is a
 *  NOTAM when it carries a `qLine` object (every SOFIA NOTAM does); otherwise we
 *  descend into its arrays / object values. */
function walk(node: unknown, emit: (n: SofiaNotam) => void): void {
	if (Array.isArray(node)) {
		for (const item of node) {
			walk(item, emit);
		}
		return;
	}
	if (!isRecord(node)) {
		return;
	}
	if (isRecord(node['qLine'])) {
		emit(node);
		return;
	}
	for (const key of Object.keys(node)) {
		walk(node[key], emit);
	}
}
