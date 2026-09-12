/* Reading a flight plan back OUT of an interchange file: the four formats
 * routeExport.ts writes, plus whatever SDVFR, ForeFlight or a simulator wrote
 * before us. Pure and hand-rolled, the shape the trace readers next door have
 * (nav/gpx.ts, nav/kml.ts): tolerant of namespace prefixes, attribute order
 * and CRLF, and scoped to the element it is reading, never hunting a tag
 * across the document.
 *
 * What comes out is what the FILE says, not what the app knows: an identifier
 * here is a CANDIDATE, and only the loader, which has the datasets, can turn
 * it into an anchored waypoint (state/routeLoad.svelte.ts). That split is what
 * keeps this module testable without a dataset in sight.
 *
 * Contract: docs/route-files.md. Tested by tests/routeImport.spec.ts. */

import { M_PER_FT } from '$lib/nav/gpx';
import { parseCoordToken } from './coordToken';
import { MAX_POINTS, MIN_POINTS } from './routePoints';
import type { RouteFormat } from './routeExport';

/** One point of a route as a file states it. */
export interface ImportedPoint {
	/** The identifier the file states, uppercased, or null. A CANDIDATE: the
	 *  loader decides whether the app's data agrees it names this place. */
	ident: string | null;
	/** True when the format TYPED it an aerodrome (an FPL `AIRPORT`, a PLN
	 *  `Airport` with its ICAO ident), rather than merely naming it. */
	aerodrome: boolean;
	/** The name the file gives it, verbatim: UTF-8, accents kept. */
	name: string | null;
	lat: number;
	lon: number;
	/** The level of the leg LEAVING this point, ft AMSL, where the format
	 *  states one. Null on the arrival, which has no leg to fly. */
	altFt: number | null;
}

/** One route of a document: its points, and the name the file gives IT. A
 *  document's caption and its routes' names are different things, and a GPX
 *  states both: dropping the second leaves the trips unnamed in the strip,
 *  the flight-prep list and every print, though the file named them all. */
export interface ImportedRoute {
	name: string | null;
	points: ImportedPoint[];
}

export interface ImportedPlan {
	format: RouteFormat;
	/** The document's own caption, where it carries one. */
	title: string | null;
	/** The flight rules the file states (the PLN alone states any). */
	vfr: boolean | null;
	/** Every route the document states, in order. GPX is the one format that
	 *  can hold more than one; reading only the first would drop the rest
	 *  without a word, and the workspace has room for six. */
	routes: ImportedRoute[];
	/** The points the reader could NOT take, named as the file names them: a
	 *  position in a punctuation this grammar does not read, a route-point
	 *  naming no table row. They ride out through the same notice an
	 *  unresolved identifier does, because a plan quietly one waypoint short
	 *  is the failure nobody sees (state/routeLoad.svelte.ts). */
	skipped: string[];
}

// --- Probes ----------------------------------------------------------------

/* Every probe reads the WHOLE text, not files/detect.ts's 4096-character
 * head: SDVFR writes 4.8 KB of <Style> before its first <Placemark>, so its
 * first <Point> sits at character 7080. The NOTAM markers already scan whole
 * text for their own reason, so the cost is a known one. */

const GPX_ROOT = /<(?:\w+:)?gpx[\s>]/i;
const KML_ROOT = /<(?:\w+:)?kml[\s>]/i;
const TRKPT = /<(?:\w+:)?trkpt[\s>]/i;
const RTEPT = /<(?:\w+:)?rtept[\s>]/i;
const KML_TRACK = /<(?:\w+:)?Track[\s>]/i;
const FPL_ROOT = /<(?:\w+:)?flight-plan[\s>]/i;
const FPL_ROUTE_POINT = /<(?:\w+:)?route-point[\s>]/i;
const PLN_ROOT = /<SimBase\.Document[\s>]/i;
const PLN_PLAN = /<FlightPlan\.FlightPlan[\s>]/i;
const RING_EL = /<(?:\w+:)?LinearRing[\s>]/i;

/** A GPX stating a ROUTE rather than a flown track. A document carrying both
 *  is a TRACE: a recorded track is evidence of a flight flown, which no plan
 *  has, and reading it as a plan would throw away the flight. A `<wpt>`-only
 *  document is not a plan either, being a waypoint library rather than an
 *  order to fly them in. */
export function looksLikeRouteGpx(text: string): boolean {
	// The track test first, and not only for the rule: a recording states its
	// first trkpt in its opening lines, while looking for a rtept that is not
	// there scans the whole file, and a trace is megabytes.
	return GPX_ROOT.test(text) && !TRKPT.test(text) && RTEPT.test(text);
}

/** A KML stating a route: the point placemarks ARE the waypoints, and the
 *  line, where there is one, merely joins them.
 *
 *  Three documents have to be told apart. One holding only a line states no
 *  waypoints, just a shape, and stays the trace it is today. An airspace
 *  dataset (the Austrian Luftraumstruktur KMZ carries 98 000 rings) is
 *  refused by its LinearRings, which no route has. And a recorded trace
 *  pinned "Start" and "End" over hundreds of vertices is refused because its
 *  line does not FOLLOW its pins: in a route every vertex IS a waypoint, the
 *  line being drawn from them.
 *
 *  Counting instead of matching was the first rule here and it was wrong: a
 *  training route flying the same two fields five times has far more vertices
 *  than pins, and reading it as a trace is exactly the mistake this whole
 *  probe exists to stop. */
export function looksLikeRouteKml(text: string): boolean {
	if (!KML_ROOT.test(text) || KML_TRACK.test(text) || RING_EL.test(text)) {
		return false;
	}
	const pins = positionKeys(pinnedPoints(text).pins);
	if (pins.size < 2) {
		return false;
	}
	const drawn = longestLine(text, pins).vertices;
	if (drawn.length === 0) {
		// Pins and no line: they are the route, in document order.
		return true;
	}
	// One vertex per pin is a route whose writer rounded its two lists
	// differently; otherwise every vertex has to stand on a pin. A vertex this
	// grammar cannot read is passed over rather than counted against the
	// document: refusing the whole file for it would open a flight plan as a
	// recorded trace, which files an outing, where reading it names the loss
	// in the notice instead.
	const readable = drawn.filter((v) => v !== null);
	if (readable.length < MIN_POINTS) {
		return false;
	}
	return drawn.length === pins.size || readable.every((v) => pins.has(positionKey(v.lat, v.lon)));
}

/** A Garmin flight plan stating a ROUTE. The waypoint table alone is not
 *  one: uploading user waypoints to a panel-mount navigator is what an FPL
 *  holding a table and no route IS, and reading that as a route would invent
 *  an order nobody wrote, the same reason a `<wpt>`-only GPX is refused. */
export function looksLikeFpl(text: string): boolean {
	return FPL_ROOT.test(text) && FPL_ROUTE_POINT.test(text);
}

export function looksLikePln(text: string): boolean {
	return PLN_ROOT.test(text) && PLN_PLAN.test(text);
}

/** Which format this text is a plan in, or null when it is not one. */
export function routeFileFormat(text: string): RouteFormat | null {
	if (looksLikeFpl(text)) {
		return 'fpl';
	}
	if (looksLikePln(text)) {
		return 'pln';
	}
	if (looksLikeRouteGpx(text)) {
		return 'gpx';
	}
	if (looksLikeRouteKml(text)) {
		return 'kml';
	}
	return null;
}

// --- Hand-rolled XML reading ----------------------------------------------

/** One element as the walk finds it: its opening tag, which carries the
 *  attributes, and its body. */
interface Element {
	open: string;
	body: string;
}

/** Every `<tag …>…</tag>` in `text`, in document order, at most `limit` of
 *  them. Namespace prefixes tolerated, the tag matched whole (`\b` would let
 *  `<rtept>` answer a scan for `<rte>`, which is exactly the bug this format
 *  invites), the first close after an open winning, and a self-closing tag
 *  counted with an empty body.
 *
 *  Walked with two scans rather than written as one non-greedy pattern,
 *  because these documents arrive from outside and some of them are
 *  TRUNCATED or malformed: a write that stopped halfway, a download that did.
 *  One pattern re-scans to the end of the file for every unclosed element it
 *  meets, which measured TEN SECONDS on a 1.2 MB KML holding 20 000 of them,
 *  inside detectFileKind, on the thread that draws. Finding no close beyond
 *  an open ends the walk instead: no later open can have one either. */
function elementsWithTag(text: string, tag: string, limit = Infinity): Element[] {
	const open = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>`, 'gi');
	const close = new RegExp(`</(?:\\w+:)?${tag}>`, 'gi');
	const out: Element[] = [];
	let start = open.exec(text);
	while (start !== null && out.length < limit) {
		if (start[0].endsWith('/>')) {
			out.push({ open: start[0], body: '' });
			start = open.exec(text);
			continue;
		}
		const from = start.index + start[0].length;
		close.lastIndex = from;
		const end = close.exec(text);
		if (end === null) {
			break;
		}
		out.push({ open: start[0], body: text.slice(from, end.index) });
		open.lastIndex = end.index + end[0].length;
		start = open.exec(text);
	}
	return out;
}

/** Every `<tag …>…</tag>` body, the shape most readers want. */
function elements(text: string, tag: string, limit = Infinity): string[] {
	return elementsWithTag(text, tag, limit).map((e) => e.body);
}

/** The first `<tag>` body, trimmed and unescaped, or null. An element that
 *  states nothing (`<comment/>`, `<name></name>`) states no value: every
 *  reader here then falls through to whatever it has instead. */
function textOf(xml: string, tag: string): string | null {
	const first = elements(xml, tag, 1)[0];
	const text = first === undefined ? '' : first.trim();
	return text === '' ? null : xmlUnescape(text);
}

/** The element's OWN `<tag>`, not the first one anywhere beneath it.
 *
 *  `textOf` reads a descendant happily, which is right for a waypoint's own
 *  children and wrong for a document's caption: a GPX whose `<rte>` states no
 *  name would be captioned after its first waypoint, a KML whose `<Document>`
 *  states none after its first placemark, and a `<metadata>` carrying an
 *  author but no name after the tool that wrote the file. And the caption is
 *  no caption once it lands: `routes.planName` is the plan's IDENTITY, the
 *  subject of every file and print it produces afterwards.
 *
 *  Read by DEPTH, never by naming the containers to skip. That deny-list was
 *  the first rule here and it was patched twice before being deleted: KML
 *  alone gives seven feature types a name of their own, so a document with no
 *  name was captioned after its author, then after a ScreenOverlay, and the
 *  next writer would have found the next hole. Depth has no holes. */
function ownText(xml: string, tag: string): string | null {
	for (const child of directChildren(xml)) {
		if (child.tag.toLowerCase() === tag.toLowerCase()) {
			const t = child.body.trim();
			return t === '' ? null : xmlUnescape(t);
		}
	}
	return null;
}

/** The DIRECT children of an element's body, in document order: each one's
 *  tag (namespace prefix dropped) and its body.
 *
 *  Scanned by hand rather than by pattern, because the depth is the answer and
 *  a comment or a CDATA section carries angle brackets that are not markup: a
 *  KML description holding `<![CDATA[<b>x</b>]]>` would otherwise open two
 *  elements that never close and swallow the rest of the document. */
function directChildren(xml: string): { tag: string; body: string }[] {
	const out: { tag: string; body: string }[] = [];
	let depth = 0;
	let tag = '';
	let from = 0;
	let i = 0;
	while (i < xml.length) {
		const lt = xml.indexOf('<', i);
		if (lt < 0) {
			break;
		}
		if (xml.startsWith('<![CDATA[', lt)) {
			const end = xml.indexOf(']]>', lt);
			i = end < 0 ? xml.length : end + 3;
			continue;
		}
		if (xml.startsWith('<!--', lt)) {
			const end = xml.indexOf('-->', lt);
			i = end < 0 ? xml.length : end + 3;
			continue;
		}
		const gt = xml.indexOf('>', lt);
		if (gt < 0) {
			break;
		}
		const raw = xml.slice(lt + 1, gt);
		i = gt + 1;
		if (raw.startsWith('!') || raw.startsWith('?')) {
			continue;
		}
		if (raw.startsWith('/')) {
			depth--;
			if (depth === 0) {
				out.push({ tag, body: xml.slice(from, lt) });
			}
			if (depth < 0) {
				// The close of the element this body belongs to: everything after
				// it is a sibling's, not a child's.
				break;
			}
			continue;
		}
		if (raw.endsWith('/')) {
			if (depth === 0) {
				out.push({ tag: tagName(raw), body: '' });
			}
			continue;
		}
		if (depth === 0) {
			tag = tagName(raw);
			from = i;
		}
		depth++;
	}
	return out;
}

/** The element name of a raw tag body, prefix dropped: `gx:Track lat="1"` is
 *  `Track`. */
function tagName(raw: string): string {
	const name = raw.replace(/^\/+/, '').split(/[\s/]/)[0];
	const colon = name.indexOf(':');
	return colon < 0 ? name : name.slice(colon + 1);
}

/** An attribute's value on the first tag of `xml`. */
function attr(xml: string, name: string): string | null {
	const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(xml);
	return m ? m[1] : null;
}

/** The entity forms nav/gpx.ts's xmlEscape writes, plus the numeric ones a
 *  foreign writer may use. */
export function xmlUnescape(s: string): string {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (m: string, d: string) => codePoint(Number(d)) ?? m)
		.replace(/&#x([0-9a-f]+);/gi, (m: string, h: string) => codePoint(parseInt(h, 16)) ?? m)
		.replace(/&amp;/g, '&');
}

/** One numeric character reference, or null when it names no character.
 *  `String.fromCodePoint` THROWS past U+10FFFF, and the throw would escape
 *  detectFileKind, which three call sites take for total: an Android "Open
 *  with" would end as an unhandled rejection showing nothing at all. A
 *  reference this grammar cannot read stays the text it was written as. */
function codePoint(n: number): string | null {
	return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null;
}

/** Every `<Placemark>` body. */
function placemarks(text: string): string[] {
	return elements(text, 'Placemark');
}

function emptyToNull(v: string | null): string | null {
	return v === null || v.trim() === '' ? null : v;
}

/** A number a field states, or null. An EMPTY field states none: `Number('')`
 *  is 0, and a `lat=""` read as a latitude puts the waypoint in the Gulf of
 *  Guinea rather than in the notice. */
function num(v: string | null): number | null {
	if (v === null || v.trim() === '') {
		return null;
	}
	const n = Number(v.trim());
	return Number.isFinite(n) ? n : null;
}

/** A position the app can draw. Leaflet's spherical Mercator returns
 *  non-finite numbers from |lat| >= 90, so a transposed or truncated field
 *  reaches the route line, fitRoute and every terrain pass as NaN geometry;
 *  the writers clamp and wrap on the way out (format/coord.ts) and this is
 *  the mirror of that on the way in. */
function validPosition(lat: number, lon: number): boolean {
	return Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

// --- The four readers ------------------------------------------------------

/** Read a plan out of `text`, or throw when it holds none. The message says
 *  which format was read and what was missing, the parseGpx idiom: it reaches
 *  the user verbatim (docs/i18n.md rule 7). */
export function readRouteFile(text: string): ImportedPlan {
	const format = routeFileFormat(text);
	if (format === null) {
		// i18n-ignore: file-format diagnostic, stays EN like the parsers' own
		throw new Error('Not a flight plan file');
	}
	const plan =
		format === 'fpl'
			? readFpl(text)
			: format === 'pln'
				? readPln(text)
				: format === 'kml'
					? readKml(text)
					: readGpx(text);
	// A route short of a leg is no route: one point states a place, not a
	// flight, and the workspace would take it as a scratch route. Its point
	// still rides out in the notice, a dropped pair being a loss like any
	// other.
	const routes: ImportedRoute[] = [];
	const skipped = [...plan.skipped];
	for (const r of plan.routes) {
		const points = tidy(r.points);
		if (points.length >= MIN_POINTS) {
			routes.push({ ...r, points });
			continue;
		}
		skipped.push(...points.map((p, i) => p.name ?? p.ident ?? `point ${i + 1}`));
	}
	if (routes.length === 0) {
		// i18n-ignore: file-format diagnostic, stays EN like the parsers' own
		throw new Error(`Invalid ${format.toUpperCase()}: no route found`);
	}
	// A track CONVERTED to a route is a legal route file of thousands of
	// points, and every GPS tool offers that conversion. It is not a flight
	// plan, the app cannot draw it as one, and half of it is not half a plan:
	// the file is refused whole, and the count is what says why. The two counts
	// are counted apart, or a good two-point route is refused under a message
	// naming the three hundred points the reader could not take.
	const most = Math.max(0, ...routes.map((r) => r.points.length));
	// i18n-ignore-start: file-format diagnostics, EN like the parsers' own
	if (most > MAX_POINTS) {
		throw new Error(
			`Invalid ${format.toUpperCase()}: ${most} points, more than a route may state (${MAX_POINTS})`,
		);
	}
	if (skipped.length > MAX_POINTS) {
		throw new Error(
			`Invalid ${format.toUpperCase()}: ${skipped.length} points could not be read, more than a route may state (${MAX_POINTS})`,
		);
	}
	// i18n-ignore-end
	return { ...plan, routes, skipped };
}

/** The rules every format shares once its points are read.
 *
 *  Adjacent repeats collapse into the entry that states an identifier: a PLN
 *  writes its departure and its arrival TWICE, an Airport and a User at one
 *  position (SDVFR: 24 entries for 22 points). Only ADJACENT ones, because a
 *  there-and-back repeats its aerodrome at the two ENDS, which is a real leg
 *  between them; the writers apply the same rule on the way out.
 *
 *  The last point loses its altitude whatever the file says: KML and PLN
 *  cannot omit one, so the writers restate the inbound level there, and this
 *  app has no leg leaving an arrival to fly at it.
 *
 *  A name that is a coordinate literal is no name: it is what a writer prints
 *  when a point has none, and loadRoutes only recognises the bare decimal
 *  form as such. */
function tidy(points: readonly ImportedPoint[]): ImportedPoint[] {
	const out: ImportedPoint[] = [];
	for (const p of points) {
		const last = out[out.length - 1];
		if (last && samePosition(last, p)) {
			// The survivor keeps whichever identity is richer and the LATER
			// leg's altitude, which is the one flown out of the place: the same
			// merge routePoints.ts makes on the way out.
			out[out.length - 1] = {
				...(last.ident ? last : p),
				name: last.name ?? p.name,
				altFt: p.altFt,
			};
			continue;
		}
		out.push(p);
	}
	return out.map((p, i) => ({
		...p,
		name: p.name !== null && isCoordinateName(p.name) ? null : p.name,
		// Zero is not a level. KML and PLN cannot omit an altitude, so every
		// writer that has none puts a zero there, and reading one as a planned
		// level pins the leg MANUAL at sea level: nothing afterwards may
		// re-level it, the semicircular rules rewriting automatic legs only,
		// the profile draws the flight underground and the fuel plan computes
		// at sea level.
		altFt: i === out.length - 1 || p.altFt === 0 ? null : p.altFt,
	}));
}

/** A name that is really a POSITION: what a writer prints when the point has
 *  none, and what this app's own writers print, so it must not become a label.
 *  The whole of it has to read as one. The first rule here applied the route
 *  FIELD's token test to free-form text, which nulled "EGAC BELFAST/CITY" (648
 *  aerodromes carry a slash in their name) and every landmark called N4 or
 *  N104, leaving those points nameless and, on GPX and KML where the name is
 *  also the only identifier candidate, unanchored as well. */
const COORD_NAME_RE = /^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/;

function isCoordinateName(name: string): boolean {
	const t = name.trim();
	return COORD_NAME_RE.test(t) || parseCoordToken(t) !== null;
}

/** Within a tenth of a second of arc, about three metres: the same place
 *  written twice, not two places. */
function samePosition(a: ImportedPoint, b: ImportedPoint): boolean {
	return Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5;
}

/** ft from the metres GPX and KML state altitudes in. */
function feetFromMetres(m: number | null): number | null {
	return m === null ? null : Math.round(m / M_PER_FT);
}

function readGpx(text: string): ImportedPlan {
	const rtes = elements(text, 'rte');
	const metadata = elements(text, 'metadata')[0] ?? '';
	const read = rtes.map(routePoints);
	return {
		format: 'gpx',
		// The document's own caption first; a lone route lends its name when
		// the document carries none, which is what this app's own writer and
		// SDVFR's both put there.
		title:
			ownText(metadata, 'name') ?? (rtes.length === 1 ? ownText(rtes[0], 'name') : null),
		vfr: null,
		routes: rtes.map((rte, i) => ({ name: ownText(rte, 'name'), points: read[i].points })),
		skipped: read.flatMap((r) => r.skipped),
	};
}

/** The `<rtept>`s of one `<rte>`, in document order, and the ones it could
 *  not read: a point stating no position is a point the pilot planned and
 *  this app is about to fly without, which it must not do in silence. */
function routePoints(rte: string): { points: ImportedPoint[]; skipped: string[] } {
	const points: ImportedPoint[] = [];
	const skipped: string[] = [];
	// A self-closing point carries its position on the tag and nothing else,
	// which the walk hands back as an empty body.
	for (const { open: head, body } of elementsWithTag(rte, 'rtept')) {
		const lat = num(attr(head, 'lat'));
		const lon = num(attr(head, 'lon'));
		const name = textOf(body, 'name');
		if (lat === null || lon === null || !validPosition(lat, lon)) {
			skipped.push(name ?? `point ${points.length + skipped.length + 1}`);
			continue;
		}
		points.push({
			ident: null,
			aerodrome: false,
			name,
			lat,
			lon,
			altFt: feetFromMetres(num(textOf(body, 'ele'))),
		});
	}
	return { points, skipped };
}

/** A KML states a route twice over: one Placemark per distinct PLACE, which
 *  carries the names, and one LineString, which carries the ORDER. The line
 *  is what is walked, because a route that returns to its field pins that
 *  field ONCE and flies it twice (this app's own writer dedupes the pins, as
 *  SDVFR's does not); each vertex then takes the name of the placemark
 *  standing on it. A document with no line at all falls back to the pins in
 *  document order, which is the best evidence it has left. */
function readKml(text: string): ImportedPlan {
	const doc = elements(text, 'Document')[0] ?? elements(text, 'kml')[0] ?? text;
	const { pins, skipped } = pinnedPoints(text);
	const drawn = longestLine(text, positionKeys(pins));
	const line: Coord[] = [];
	const lost: string[] = [];
	drawn.vertices.forEach((v, i) => {
		if (v === null) {
			// A vertex of the drawn route IS a waypoint, so one this grammar
			// cannot read is a waypoint the pilot planned: named out here, or
			// the plan comes back one point short with a clean notice.
			lost.push(`point ${i + 1}`);
		} else {
			line.push(v);
		}
	});
	const points =
		line.length >= MIN_POINTS
			? line.map((v) => ({
					ident: null,
					aerodrome: false,
					name: pinNameAt(pins, v),
					lat: v.lat,
					lon: v.lon,
					altFt: drawn.levels ? feetFromMetres(v.alt) : null,
				}))
			: pins;
	return {
		format: 'kml',
		title: ownText(doc, 'name'),
		vfr: null,
		routes: [{ name: null, points }],
		// A pin the reader could not place is a lost POINT only while the pins
		// ARE the route. Where the line drives, that pin was a name and
		// nothing else, and naming it in the notice would report a waypoint
		// missing from a route that has all of them; what the LINE lost is a
		// waypoint either way.
		skipped: line.length >= MIN_POINTS ? lost : [...skipped, ...lost],
	};
}

/** Every Point placemark, in document order: where it stands and what it is
 *  called. Both the probe and the reader walk these, so they cannot disagree
 *  about what a pin is. */
function pinnedPoints(text: string): { pins: ImportedPoint[]; skipped: string[] } {
	const pins: ImportedPoint[] = [];
	const skipped: string[] = [];
	for (const pm of placemarks(text)) {
		const point = elements(pm, 'Point')[0];
		if (point === undefined) {
			continue;
		}
		const at = coordTuples(textOf(point, 'coordinates'))[0] ?? null;
		const name = textOf(pm, 'name');
		if (!at) {
			skipped.push(name ?? `point ${pins.length + skipped.length + 1}`);
			continue;
		}
		pins.push({
			ident: null,
			aerodrome: false,
			name,
			lat: at.lat,
			lon: at.lon,
			altFt: statesLevels(point) ? feetFromMetres(at.alt) : null,
		});
	}
	return { pins, skipped };
}

/** How far a pin may stand from the vertex it names: a ten-thousandth of a
 *  degree, about eleven metres. The two lists describe one route and differ
 *  only by the decimals each was rounded to; anything further apart is
 *  another place, and taking its name prints another aerodrome's identifier
 *  at this waypoint. Indexing the pins by POSITION IN THE LIST was the first
 *  rule here and it was wrong: the pins are every Point in the document, so
 *  one decorative marker slid every name along by one. */
const PIN_MATCH_DEG = 1e-4;

function pinNameAt(pins: readonly ImportedPoint[], v: Coord): string | null {
	let best: { name: string; off: number } | null = null;
	for (const pin of pins) {
		if (pin.name === null) {
			continue;
		}
		const off = Math.max(Math.abs(pin.lat - v.lat), Math.abs(pin.lon - v.lon));
		if (off <= PIN_MATCH_DEG && (best === null || off < best.off)) {
			best = { name: pin.name, off };
		}
	}
	return best?.name ?? null;
}

/** True when this element's altitudes are levels above mean sea level. KML's
 *  DEFAULT is clampToGround, the ground itself, which is what Google Earth's
 *  own "Save Place As" writes under the conventional `,0` third component;
 *  only `absolute` states a level a plan can be flown at. Reading a ground
 *  clamp as one pins every leg MANUAL at sea level, where nothing afterwards
 *  may re-level it and the profile draws the flight underground. This app's
 *  own writer states the mode whenever it has a level to state. */
function statesLevels(el: string): boolean {
	return (ownText(el, 'altitudeMode') ?? '').toLowerCase() === 'absolute';
}

/** One vertex of a coordinates run. */
interface Coord {
	lat: number;
	lon: number;
	alt: number | null;
}

/** A position as a key a pin and a vertex can be matched on: six decimals,
 *  which is a tenth of a metre, and both come from one writer's own numbers. */
function positionKey(lat: number, lon: number): string {
	return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

function positionKeys(pins: readonly { lat: number; lon: number }[]): Set<string> {
	const out = new Set<string>();
	for (const p of pins) {
		out.add(positionKey(p.lat, p.lon));
	}
	return out;
}

/** The vertices of the longest drawn line, unreadable ones kept as nulls, and
 *  whether that line states LEVELS. Longest, never concatenated: two drawn
 *  paths in one document are two paths, and joining them would fabricate a
 *  leg (the rule nav/kml.ts states for a trace). */
function longestLine(
	text: string,
	pins: ReadonlySet<string>,
): { vertices: (Coord | null)[]; levels: boolean } {
	let best: { vertices: (Coord | null)[]; levels: boolean } = { vertices: [], levels: false };
	for (const line of elements(text, 'LineString')) {
		const vertices = coordTuples(textOf(line, 'coordinates'), pins);
		if (vertices.length > best.vertices.length) {
			best = { vertices, levels: statesLevels(line) };
		}
	}
	return best;
}

/** A run of `lon,lat[,alt]` tuples, a vertex this grammar cannot read kept as
 *  a null so a caller can say which one it lost.
 *
 *  KML separates TUPLES with whitespace and COMPONENTS with commas, so the
 *  whitespace is read first and each token split on its own commas: that is
 *  the grammar, and it is the only reading that tells `2.6,48.8 2.7,48.9`
 *  (two points at sea level) from `2.6,48.8,2.7` (one point at 2.7 m). Files
 *  in the wild also put spaces AFTER the commas, which shatters a naive split
 *  into halves that read as nothing at all and turn a flight plan into a
 *  trace; nav/kml.ts carries the same normalisation for the same reason. */
function coordTuples(raw: string | null, pins?: ReadonlySet<string>): (Coord | null)[] {
	if (raw === null) {
		return [];
	}
	const tokens = raw
		.trim()
		.replace(/\s*,\s*/g, ',')
		.split(/\s+/)
		.filter((t) => t !== '');
	if (tokens.length === 0) {
		return [];
	}
	if (tokens.length > 1) {
		return tokens.map(numbersOf).map(tupleOf);
	}
	const parts = numbersOf(tokens[0]);
	if (parts.length <= 3) {
		const one = tupleOf(parts);
		return one === null ? [] : [one];
	}
	return regroup(parts, pins);
}

/** SDVFR writes no whitespace at all, the whole route as one comma-run, and a
 *  reader that stops at the grammar gives ONE point for a whole navigation.
 *  So a lone token is regrouped, by three components or by two.
 *
 *  Six numbers read as either, and both readings can be positions: the
 *  three-component one is two waypoints with altitudes, the two-component one
 *  is three at sea level. The PINS settle it, being the same document's own
 *  answer for where this route goes; with none to ask, three components is
 *  what a writer omitting the whitespace has always meant. Preferring three
 *  blindly was the first rule here, and on a four-pin out-and-back written
 *  without altitudes it put every waypoint in Somalia. */
function regroup(parts: number[], pins?: ReadonlySet<string>): (Coord | null)[] {
	const byThree = groupRun(parts, 3);
	const byTwo = groupRun(parts, 2);
	if (byThree === null) {
		return byTwo ?? [];
	}
	if (byTwo === null) {
		return byThree;
	}
	if (pins && pins.size > 0) {
		const onPins = (g: Coord[]): number =>
			g.filter((v) => pins.has(positionKey(v.lat, v.lon))).length;
		return onPins(byTwo) > onPins(byThree) ? byTwo : byThree;
	}
	return byThree;
}

/** The numbers of one comma-separated token. An EMPTY field is dropped
 *  rather than read as the zero `Number('')` gives: SDVFR closes each of its
 *  tuples with a trailing comma. */
function numbersOf(token: string): number[] {
	return token
		.split(',')
		.filter((s) => s.trim() !== '')
		.map(Number);
}

function tupleOf(parts: number[]): Coord | null {
	const [lon, lat, alt] = parts;
	if (!Number.isFinite(lat) || !Number.isFinite(lon) || !validPosition(lat, lon)) {
		return null;
	}
	return { lat, lon, alt: Number.isFinite(alt) ? alt : null };
}

/** A flat run cut into groups of `size`, or null when it does not divide or
 *  any group fails to read as a position. */
function groupRun(parts: number[], size: number): Coord[] | null {
	if (parts.length % size !== 0) {
		return null;
	}
	const out: Coord[] = [];
	for (let i = 0; i < parts.length; i += size) {
		const one = tupleOf(parts.slice(i, i + size));
		if (one === null) {
			return null;
		}
		out.push(one);
	}
	return out;
}

function readFpl(text: string): ImportedPlan {
	const plan = elements(text, 'flight-plan')[0] ?? text;
	// The waypoint table is a MAP, and its key is the TRIPLE Garmin's schema
	// states: identifier, type and country-code together, which every
	// route-point names in full. Keying on the identifier alone is not a
	// simplification, it is a wrong answer: the schema permits LFPL as an
	// AIRPORT and LFPL as a USER WAYPOINT in one table, and a route-point
	// asking for the aerodrome would be handed whichever row was written last.
	const table = new Map<string, ImportedPoint>();
	// Beside it, the identifier ALONE, for a writer that omits the type from
	// its route-points: both fields are optional in the table, and files in
	// the wild are looser than the schema. Only while the table files one
	// PLACE under that identifier, which is the whole reason the schema keys
	// the triple: MLN is Melilla's aerodrome and Melun's VOR-DME, 1200 km
	// apart, and first-row-wins would fly to the wrong one with nothing in
	// the notice to say so. A row repeated at one position is one place; two
	// places under one name are refused, and the point is named in the notice
	// like any other the reader could not take.
	const byIdent = new Map<string, ImportedPoint | null>();
	for (const w of elements(plan, 'waypoint')) {
		const ident = textOf(w, 'identifier');
		const lat = num(textOf(w, 'lat'));
		const lon = num(textOf(w, 'lon'));
		if (ident === null || lat === null || lon === null || !validPosition(lat, lon)) {
			continue;
		}
		const key = ident.toUpperCase();
		const point: ImportedPoint = {
			ident: key,
			aerodrome: (textOf(w, 'type') ?? '').toUpperCase() === 'AIRPORT',
			// The exact name where the writer kept one, else what the comment's
			// own alphabet allowed, else the identifier itself: SDVFR writes an
			// empty comment and no description, so the mangled identifier is the
			// only name its file holds and a point with none reads as a bare
			// coordinate (docs/route-files.md).
			name: textOf(w, 'waypoint-description') ?? emptyToNull(textOf(w, 'comment')) ?? ident,
			lat,
			lon,
			altFt: null,
		};
		table.set(tableKey(key, textOf(w, 'type'), textOf(w, 'country-code')), point);
		const prior = byIdent.get(key);
		if (prior === undefined) {
			byIdent.set(key, point);
		} else if (prior !== null && !samePosition(prior, point)) {
			byIdent.set(key, null);
		}
	}
	const route = elements(plan, 'route')[0] ?? '';
	const points: ImportedPoint[] = [];
	const skipped: string[] = [];
	for (const rp of elements(route, 'route-point')) {
		const ident = textOf(rp, 'waypoint-identifier');
		if (ident === null) {
			continue;
		}
		const key = ident.toUpperCase();
		const hit =
			table.get(tableKey(key, textOf(rp, 'waypoint-type'), textOf(rp, 'waypoint-country-code'))) ??
			byIdent.get(key) ??
			null;
		if (hit) {
			points.push(hit);
		} else {
			skipped.push(ident);
		}
	}
	return {
		format: 'fpl',
		title: ownText(plan, 'file-description') ?? ownText(route, 'route-name'),
		vfr: null,
		routes: [{ name: null, points }],
		skipped,
	};
}

/** One waypoint-table row's key: the three fields Garmin's `xsd:key` names,
 *  a stated-nothing field reading as the empty string it is written as. */
function tableKey(ident: string, type: string | null, country: string | null): string {
	return `${ident}|${(type ?? '').trim().toUpperCase()}|${(country ?? '').trim().toUpperCase()}`;
}

function readPln(text: string): ImportedPlan {
	const plan = elements(text, 'FlightPlan\\.FlightPlan')[0] ?? text;
	const points: ImportedPoint[] = [];
	const skipped: string[] = [];
	for (const { open, body } of elementsWithTag(plan, 'ATCWaypoint')) {
		const pos = parseWorldPosition(textOf(body, 'WorldPosition'));
		if (!pos) {
			// A row stating no position, or one in a punctuation this grammar
			// does not read: named out rather than dropped in silence.
			skipped.push(attr(open, 'id') ?? `point ${points.length + skipped.length + 1}`);
			continue;
		}
		const icao = textOf(body, 'ICAOIdent');
		const type = (textOf(body, 'ATCWaypointType') ?? '').toLowerCase();
		const id = attr(open, 'id');
		points.push({
			ident: (icao ?? (type === 'airport' ? id : null))?.toUpperCase() ?? null,
			aerodrome: type === 'airport',
			name: id,
			lat: pos.lat,
			lon: pos.lon,
			altFt: pos.altFt,
		});
	}
	const rules = (textOf(plan, 'FPType') ?? '').toUpperCase();
	return {
		format: 'pln',
		title: ownText(plan, 'Title'),
		vfr: rules === 'VFR' ? true : rules === 'IFR' ? false : null,
		routes: [{ name: null, points }],
		skipped,
	};
}

/** `N48° 49' 19.00",E002° 37' 22.00",+001500.00`, the simulator's own
 *  grammar and the inverse of routePln.ts's writer. Tolerant of the degree
 *  sign being a plain space and of the seconds' decimals, which not every
 *  writer states. */
export function parseWorldPosition(
	raw: string | null,
): { lat: number; lon: number; altFt: number | null } | null {
	if (raw === null) {
		return null;
	}
	const parts = raw.split(',');
	if (parts.length < 2) {
		return null;
	}
	const lat = parseDms(parts[0], 'N', 'S');
	const lon = parseDms(parts[1], 'E', 'W');
	if (lat === null || lon === null) {
		return null;
	}
	if (!validPosition(lat, lon)) {
		return null;
	}
	const alt = parts.length > 2 ? Number(parts[2]) : NaN;
	return { lat, lon, altFt: Number.isFinite(alt) ? Math.round(alt) : null };
}

/* `N48° 49' 19.00"`, and the same without its seconds, which not every
 * writer states. The degree and minute marks ARE required: they are what
 * makes the reading unambiguous, and a bare "N48 49 19" is no grammar this
 * format ever wrote. `*` is tolerated for the degree sign, which is what a
 * writer reaches for when its encoding cannot carry one. */
const DMS_RE = /^\s*([NSEW])\s*(\d+)\s*[°*]\s*(\d+(?:\.\d+)?)\s*['′](?:\s*([\d.]+)\s*["″]?)?\s*$/i;

function parseDms(raw: string, positive: string, negative: string): number | null {
	const m = DMS_RE.exec(raw);
	if (!m) {
		return null;
	}
	const hemi = m[1].toUpperCase();
	if (hemi !== positive && hemi !== negative) {
		return null;
	}
	const deg = Number(m[2]) + Number(m[3]) / 60 + (m[4] === undefined ? 0 : Number(m[4]) / 3600);
	if (!Number.isFinite(deg)) {
		return null;
	}
	return hemi === negative ? -deg : deg;
}

// --- What the loader resolves ----------------------------------------------

/** Shape of an identifier a database can be expected to hold. */
const IDENT_SHAPE = /^[A-Z0-9]{2,5}$/;
/** An ICAO location indicator, the one identifier that is reliably unique. */
const ICAO_SHAPE = /^[A-Z]{4}$/;

/** The identifiers this point might be, best evidence first, for the loader
 *  to try against the app's own data (state/routeLoad.svelte.ts).
 *
 *  Three tiers, and each earns its place from a real file: what the file
 *  STATES (an FPL AIRPORT, a PLN ICAOIdent); the leading token of a name that
 *  opens with one, which is how SDVFR and this app both write a named
 *  feature ("LFPL LOGNES EMERAINVILLE", "CLM COULOMMIERS"); and the first
 *  four characters of a stated identifier when they are ICAO-shaped, because
 *  SDVFR's own FPL writes five characters of the NAME as the identifier and
 *  LFPL comes back as LFPLL. The loader confirms every one of them against
 *  the position the file states before it accepts it. */
export function identCandidates(p: ImportedPoint): string[] {
	const out: string[] = [];
	const add = (v: string | null | undefined): void => {
		const t = v?.trim().toUpperCase();
		if (t && IDENT_SHAPE.test(t) && !out.includes(t)) {
			out.push(t);
		}
	};
	const leading = p.name?.trim().split(/\s+/)[0];
	add(p.ident);
	// The leading token of a name, whether or not more follows it: "LFPL
	// LOGNES EMERAINVILLE" names the field and its town, and a PLN's
	// ATCWaypoint has no name field at all, so its id IS the whole name.
	add(leading);
	// The ICAO-shaped first four characters of either, when more follows them.
	// SDVFR's FPL writes five characters of the name as the identifier, so
	// LFPL arrives as LFPLL; its PLN writes ten as the id, so Compiegne
	// arrives as LFADCOMPIE and the aerodrome, with its runways, frequencies
	// and weather, was coming back a nameless free point beside its own field.
	for (const source of [p.ident, leading]) {
		const t = source?.trim();
		// A token a MACHINE wrote, which is what a mangled identifier is: no
		// lowercase in it. "Abbaye de Chaalis" is a place the pilot named and
		// its first four characters name no aerodrome, however ICAO-shaped
		// ABBA looks, and the position test is not the place to find that out.
		if (t !== undefined && t.length > 4 && t === t.toUpperCase() && ICAO_SHAPE.test(t.slice(0, 4))) {
			add(t.slice(0, 4));
		}
	}
	return out;
}
