/* The position reading (docs/nav-live.md "The position reference"): where
 * the aircraft is, said as a pilot reports it, from the nearest reference a
 * chart names. Within a mile of any reference, overhead it ("OHD Étampes");
 * else the nearest aerodrome, radio aid or landmarked reporting point within
 * ten miles; else the nearest town of 5,000 people within fifteen, then of
 * 1,000. From 1 to 3 NM the direction alone ("NW Étampes"), beyond that the
 * distance too ("4 NM NW Étampes"): the bearing is TRUE, from the reference
 * to the aircraft, as one of the eight points. OHD, PSN, NM and the points
 * are ICAO Doc 8400 abbreviations (the Belgian AIP GEN 2.2 lists them
 * unmarked, where it asterisks OVH as national), and a reference keeps its
 * own name and case. Pure: no Svelte, no I/O, so a replay reads the same
 * reference at the same instant; the words around it are the caller's. */

import type { Airport } from '$lib/data/airports';
import type { Navaid } from '$lib/data/navaids';
import type { Place } from '$lib/data/places';
import { compassPoint } from '$lib/format/compass';
import { vrpLandmark } from '$lib/format/remark';
import { equirectangularDistanceM, initialBearingDeg } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import { nearestCandidates } from './nearest';

/** Under this, overhead the reference ("OHD"). */
export const PSN_OVERHEAD_NM = 1;
/** Up to this, the direction alone; beyond, the distance too. */
export const PSN_NEAR_NM = 3;
/** How far a feature (aerodrome, radio aid, reporting point) is read from. */
export const PSN_FEATURE_NM = 10;
/** How far a town is read from. */
export const PSN_TOWN_NM = 15;
/** A town of this many people is read before a smaller one. */
export const PSN_TOWN_LARGE = 5000;
/** A town smaller than this is no reference. */
export const PSN_TOWN_MIN = 1000;

export type PositionRefKind = 'airport' | 'navaid' | 'vrp' | 'town';

/** A reference a reading can name. */
export interface RefPoint {
	kind: PositionRefKind;
	/** The feature's or the town's own id. */
	id: string;
	/** As published, in its own case ("Étampes", "LFOX", "AUDLEY END
	 *  RAILWAY STATION"). */
	label: string;
	lat: number;
	lon: number;
	/** A town's inhabitants; null for a feature, or unknown. */
	pop: number | null;
}

/** The reading at a position: the reference, and where the position lies
 *  from it. */
export interface PositionRef {
	kind: PositionRefKind;
	id: string;
	label: string;
	distNM: number;
	/** Degrees TRUE, from the reference to the position. */
	bearingTrueDeg: number;
	form: 'ohd' | 'near' | 'far';
}

/* ---- the references ---- */

const ICAO_RE = /^[A-Z]{4}$/;

/** The open fixed-wing aerodromes (nav/nearest.ts), each by its ICAO
 *  location indicator, else its name as published. */
export function aerodromeRefs(airports: readonly Airport[]): RefPoint[] {
	return nearestCandidates(airports).map((a) => ({
		kind: 'airport',
		id: a.ident,
		label: ICAO_RE.test(a.ident) ? a.ident : a.name || a.ident,
		lat: a.lat,
		lon: a.lon,
		pop: null,
	}));
}

const RADIO_TYPES: ReadonlySet<string> = new Set(['VOR', 'VOR-DME', 'VORTAC', 'NDB', 'TACAN']);

// The ICAO spelling alphabet: a point named by a letter names nothing a
// pilot sees on the ground ("ECHO", "NOVEMBER 1").
const PHONETIC_RE =
	/^(ALFA|ALPHA|BRAVO|CHARLIE|DELTA|ECHO|FOXTROT|GOLF|HOTEL|INDIA|JULIET|JULIETT|KILO|LIMA|MIKE|NOVEMBER|OSCAR|PAPA|QUEBEC|ROMEO|SIERRA|TANGO|UNIFORM|VICTOR|WHISKEY|WHISKY|X-?RAY|YANKEE|ZULU)\s*\d*$/i;
// A procedure's fix or a position given relative to another: no landmark.
const RELATIVE_RE = /\b(NM|RDL|QDR|DME|FAF|FAP|IAF|MAPT|RWY|SID|STAR|MSA|THR)\b|°|\/|^(abeam|north|south|east|west)\b/i;
// The DFS files its reporting points among its IFR fixes, the real ones
// named after their aerodrome ("EDFH SIERRA"): the rest are codes.
const DE_VRP_RE = /^E[DT][A-Z]{2}\s+\S/;

/** A reporting point's label, or '' when it names no landmark: France's
 *  remark ("VRP-Neuville de Poitou"), Germany's names after their aerodrome,
 *  everywhere else its name, or its identifier where that is a phrase (as
 *  Ireland files its points); a spelling-alphabet name, a procedure fix or
 *  a relative description is none. */
export function vrpLabel(n: Navaid): string {
	let label: string;
	if (n.source === 'fr') {
		label = vrpLandmark(n.rmk);
	} else if (n.source === 'de') {
		label = DE_VRP_RE.test(n.name) ? n.name : '';
	} else {
		label = n.name || (/\s/.test(n.ident.trim()) ? n.ident.trim() : '');
	}
	label = label.trim();
	if (!label || PHONETIC_RE.test(label) || RELATIVE_RE.test(label)) {
		return '';
	}
	return label;
}

/** The radio aids, by their identifier, and the reporting points that name
 *  a landmark (vrpLabel). */
export function navaidRefs(navaids: readonly Navaid[]): RefPoint[] {
	const out: RefPoint[] = [];
	for (const n of navaids) {
		if (RADIO_TYPES.has(n.type)) {
			out.push({ kind: 'navaid', id: n.id, label: n.ident, lat: n.lat, lon: n.lon, pop: null });
		} else if (n.type === 'VFR_REPORTING_POINT') {
			const label = vrpLabel(n);
			if (label) {
				out.push({ kind: 'vrp', id: n.id, label, lat: n.lat, lon: n.lon, pop: null });
			}
		}
	}
	return out;
}

/** The towns of PSN_TOWN_MIN people or more. */
export function townRefs(places: readonly Place[]): RefPoint[] {
	const out: RefPoint[] = [];
	for (const p of places) {
		if (p.pop !== null && p.pop >= PSN_TOWN_MIN) {
			out.push({ kind: 'town', id: p.id, label: p.name, lat: p.lat, lon: p.lon, pop: p.pop });
		}
	}
	return out;
}

/* ---- the index: whole-degree cells ---- */

export interface RefIndex {
	cells: ReadonlyMap<string, readonly RefPoint[]>;
}

function cellKey(latCell: number, lonCell: number): string {
	return `${latCell},${lonCell}`;
}

/** Wrap a longitude cell into [-180, 180). */
function wrapLonCell(c: number): number {
	return ((((c + 180) % 360) + 360) % 360) - 180;
}

export function buildRefIndex(points: readonly RefPoint[]): RefIndex {
	const cells = new Map<string, RefPoint[]>();
	for (const p of points) {
		const k = cellKey(Math.floor(p.lat), wrapLonCell(Math.floor(p.lon)));
		let cell = cells.get(k);
		if (!cell) {
			cell = [];
			cells.set(k, cell);
		}
		cell.push(p);
	}
	return { cells };
}

/** Every reference within `radiusNM` of the position, with its distance;
 *  the cells across the antimeridian included. */
function within(index: RefIndex, lat: number, lon: number, radiusNM: number): { p: RefPoint; nm: number }[] {
	const dLat = radiusNM / 60;
	const cos = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
	const dLon = Math.min(radiusNM / (60 * cos), 180);
	const out: { p: RefPoint; nm: number }[] = [];
	for (let la = Math.floor(lat - dLat); la <= Math.floor(lat + dLat); la++) {
		const seen = new Set<number>();
		for (let lo = Math.floor(lon - dLon); lo <= Math.floor(lon + dLon); lo++) {
			const w = wrapLonCell(lo);
			if (seen.has(w)) {
				continue;
			}
			seen.add(w);
			for (const p of index.cells.get(cellKey(la, w)) ?? []) {
				const nm = equirectangularDistanceM(lat, lon, p.lat, p.lon) / NM_TO_METERS;
				if (nm <= radiusNM) {
					out.push({ p, nm });
				}
			}
		}
	}
	return out;
}

function nearest(cands: readonly { p: RefPoint; nm: number }[]): { p: RefPoint; nm: number } | null {
	let best: { p: RefPoint; nm: number } | null = null;
	for (const c of cands) {
		if (!best || c.nm < best.nm || (c.nm === best.nm && c.p.id < best.p.id)) {
			best = c;
		}
	}
	return best;
}

/** The reading at a position, or null where no reference is near enough. */
export function positionRef(index: RefIndex, lat: number, lon: number): PositionRef | null {
	const cands = within(index, lat, lon, Math.max(PSN_FEATURE_NM, PSN_TOWN_NM));
	const pick =
		nearest(cands.filter((c) => c.nm < PSN_OVERHEAD_NM)) ??
		nearest(cands.filter((c) => c.p.kind !== 'town' && c.nm <= PSN_FEATURE_NM)) ??
		nearest(cands.filter((c) => c.p.kind === 'town' && (c.p.pop ?? 0) >= PSN_TOWN_LARGE && c.nm <= PSN_TOWN_NM)) ??
		nearest(cands.filter((c) => c.p.kind === 'town' && c.nm <= PSN_TOWN_NM));
	if (!pick) {
		return null;
	}
	const { p, nm } = pick;
	return {
		kind: p.kind,
		id: p.id,
		label: p.label,
		distNM: nm,
		bearingTrueDeg: initialBearingDeg(p.lat, p.lon, lat, lon),
		form: nm < PSN_OVERHEAD_NM ? 'ohd' : nm <= PSN_NEAR_NM ? 'near' : 'far',
	};
}

/** Where the position lies from its reference, in Doc 8400's words: "OHD",
 *  "NW", "4 NM NW" (whole miles). */
export function positionRefFigure(ref: PositionRef): string {
	switch (ref.form) {
		case 'ohd':
			return 'OHD';
		case 'near':
			return compassPoint(ref.bearingTrueDeg);
		case 'far':
			return `${Math.round(ref.distNM)} NM ${compassPoint(ref.bearingTrueDeg)}`;
	}
}

/** The reading on one line: "OHD Étampes", "NW Étampes", "4 NM NW Étampes". */
export function formatPositionRef(ref: PositionRef): string {
	return `${positionRefFigure(ref)} ${ref.label}`;
}
