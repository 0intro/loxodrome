/* airportMerge.ts layers a per-country AIXM airport overlay onto the worldwide
 * OurAirports baseline (or an already-merged view). Pure; unit-tested in
 * tests/airportMerge.spec.ts. */

import type { Airport, AirportRadio, Runway } from './airports';
import type { Publisher } from '$lib/state/layers.svelte';
import { equirectangularDistanceM } from '$lib/notam/geometry';
import { classifySurface } from './runwaySurface';

/** An AIXM aerodrome whose ICAO is absent from the baseline may still BE a
 *  baseline aerodrome listed under a different ident: OurAirports keys some
 *  French fields by a local code (e.g. LF51), where the SIA uses the ICAO
 *  (LFPR). Within this radius the pair is treated as one aerodrome rather than
 *  drawing both symbols on top of each other. 400 m clears the same-field
 *  cases (the widest real pair is 230 m apart) and stays well under the
 *  nearest genuinely-distinct neighbour (820 m). */
const PROXIMITY_MERGE_M = 400;

/** An ICAO location indicator: four letters, no digits. Aerodromes the national
 *  AIP publishes without one carry the publisher's own national code instead
 *  (the SIA's `LF075` Créteil hospital helipad, the DFS's `ED0004`), and those
 *  codes are a DIFFERENT registry that overlaps the OurAirports baseline's
 *  local-code idents: the SIA's `LF51` is VITRY EN ARTOIS (CLOSED) while
 *  OurAirports' `LF51` is Orange Plan-de-Dieu, which the SIA itself publishes
 *  as `LFPR`. So only an ICAO-shaped ident may claim a baseline row by ident;
 *  a national code goes to the proximity pass, which still merges the pair
 *  when they really are one aerodrome. */
function isIcaoShaped(ident: string): boolean {
	return /^[A-Z]{4}$/.test(ident.toUpperCase());
}

/** Build the merged entry: AIXM supplies name / coords / runways / access /
 *  military / joint / VFR-IFR; the OurAirports `country` and size vocabulary
 *  (large / medium / small_airport, which the AIXM has no equivalent for) are
 *  kept so the SPA's types stay consistent. `closed` is the exception, being
 *  the national AIP's statement to make: a field the AIXM publishes is open
 *  however stale the baseline is (the DFS-published hospital heliport ED1983,
 *  which OurAirports still carries as the closed D346), and one the AIXM marks
 *  abandoned is closed however open the baseline looks (EDCK). `ident` is
 *  passed in: the
 *  shared ICAO for an exact match, the AIXM ICAO for a proximity match (so
 *  NOTAM links resolve to the proper code). The later-merging AIXM publisher
 *  wins the `source` tag; the per-publisher Layers toggle then hides the row
 *  when its last contributor is toggled off. Frequencies follow the runways
 *  rule: the authoritative AIXM list wins when present, else the OurAirports
 *  baseline survives (so Spanish fields, and any FR/UK field the AIXM doesn't
 *  publish radios for, keep their worldwide frequencies). The AIXM runways
 *  keep their own surfaces, except one nobody can read, which takes the
 *  baseline's for the same runway (withKnownSurfaces). */
function mergeEntry(baseAp: Airport, ax: Airport, ident: string): Airport {
	return {
		ident,
		type: ax.type === 'closed' || baseAp.type === 'closed' ? ax.type : baseAp.type,
		name: ax.name,
		lat: ax.lat,
		lon: ax.lon,
		elevFt: ax.elevFt ?? baseAp.elevFt,
		transitionAltFt: ax.transitionAltFt ?? baseAp.transitionAltFt,
		country: baseAp.country || ax.country,
		city: ax.city || baseAp.city,
		iata: ax.iata || baseAp.iata,
		runways: ax.runways.length > 0 ? withKnownSurfaces(ax.runways, baseAp.runways) : baseAp.runways,
		access: ax.access ?? baseAp.access,
		military: ax.military,
		joint: ax.joint,
		vfr: ax.vfr,
		ifr: ax.ifr,
		radios: ax.radios.length > 0 ? ax.radios : baseAp.radios,
		source: ax.source,
		charts: ax.charts.length > 0 ? ax.charts : baseAp.charts,
		pads: ax.pads.length > 0 ? ax.pads : baseAp.pads,
	};
}

/** A runway end designator as two publishers can compare it: trimmed,
 *  upper-cased, leading zeros dropped ('09' is '9'), the suffix kept
 *  ('35GLD'). */
function designatorKey(d: string): string {
	const s = d.trim().toUpperCase();
	const m = /^0*(\d+)(.*)$/.exec(s);
	return m ? `${m[1]}${m[2]}` : s;
}

/** The same runway, its ends listed either way round. */
function sameRunway(a: Runway, b: Runway): boolean {
	const al = designatorKey(a.le);
	const ah = designatorKey(a.he);
	const bl = designatorKey(b.le);
	const bh = designatorKey(b.he);
	return (al === bl && ah === bh) || (al === bh && ah === bl);
}

function endParts(d: string): { n: number; suffix: string } | null {
	const m = /^0*(\d{1,2})([A-Z]*)$/.exec(d.trim().toUpperCase());
	if (!m) {
		return null;
	}
	const n = parseInt(m[1], 10);
	return n >= 1 && n <= 36 ? { n, suffix: m[2] } : null;
}

/** Is `to` the end `from` renumbered by `delta` steps (mod 36), same suffix? */
function shifted(from: string, to: string, delta: 1 | -1): boolean {
	const a = endParts(from);
	const b = endParts(to);
	return a != null && b != null && a.suffix === b.suffix && ((a.n - 1 + delta + 36) % 36) + 1 === b.n;
}

/** The same runway renumbered for the magnetic drift (ENAIRE's LELC 04R/22L
 *  is OurAirports' 05R/23L): both ends one step apart the same way, the same
 *  suffixes, and the same length within max(100 ft, 5 %), which is what keeps
 *  a neighbouring runway from passing for it (LELN 06/24 is no 05/23). */
function renumbered(ax: Runway, base: Runway): boolean {
	if (ax.lengthFt == null || base.lengthFt == null) {
		return false;
	}
	const tolerance = Math.max(100, 0.05 * Math.max(ax.lengthFt, base.lengthFt));
	if (Math.abs(ax.lengthFt - base.lengthFt) > tolerance) {
		return false;
	}
	return ([1, -1] as const).some(
		(delta) =>
			(shifted(base.le, ax.le, delta) && shifted(base.he, ax.he, delta)) ||
			(shifted(base.le, ax.he, delta) && shifted(base.he, ax.le, delta)),
	);
}

/** The overlay's runways, each one whose surface nobody can read taking the
 *  baseline's for the same runway when the baseline's can be read: ENAIRE
 *  publishes every Spanish runway with an empty surface, which would draw
 *  LEMD as a field not known to be paved and give its runways the grass
 *  factor. The exact designator pair first, then the same runway renumbered.
 *  New objects only (the rows are never written), and the overlay's own list
 *  back unchanged when it has nothing to recover. */
function withKnownSurfaces(axRunways: Runway[], baseRunways: Runway[]): Runway[] {
	if (axRunways.every((r) => classifySurface(r.surface) !== 'unknown')) {
		return axRunways;
	}
	const known = baseRunways.filter((b) => classifySurface(b.surface) !== 'unknown');
	if (known.length === 0) {
		return axRunways;
	}
	return axRunways.map((r) => {
		if (classifySurface(r.surface) !== 'unknown') {
			return r;
		}
		const match = known.find((b) => sameRunway(r, b)) ?? known.find((b) => renumbered(r, b));
		return match ? { ...r, surface: match.surface } : r;
	});
}

/** The coarse 0.1 deg proximity cell of a position, as one number (a string
 *  key per row per overlay was most of the merge's cost). Math.round like
 *  the sweep below, so a position and its 3x3 neighbourhood agree. */
function cellKey(lat: number, lon: number): number {
	return (Math.round(lat * 10) + 1000) * 10000 + (Math.round(lon * 10) + 5000);
}

/** Index in `out` of the nearest not-yet-consumed baseline aerodrome to `ax`
 *  within PROXIMITY_MERGE_M, or -1. Uses the coarse 0.1 deg `grid` (a 3x3
 *  cell sweep covers the radius at any latitude). */
function nearestUnconsumed(
	ax: Airport,
	out: Airport[],
	grid: Map<number, number[]>,
	consumed: Set<number>,
): number {
	const clat = Math.round(ax.lat * 10);
	const clon = Math.round(ax.lon * 10);
	let best = -1;
	let bestM = PROXIMITY_MERGE_M;
	for (let dla = -1; dla <= 1; dla++) {
		for (let dlo = -1; dlo <= 1; dlo++) {
			const list = grid.get((clat + dla + 1000) * 10000 + (clon + dlo + 5000));
			if (!list) {
				continue;
			}
			for (const idx of list) {
				if (consumed.has(idx)) {
					continue;
				}
				const b = out[idx];
				const m = equirectangularDistanceM(ax.lat, ax.lon, b.lat, b.lon);
				if (m < bestM) {
					bestM = m;
					best = idx;
				}
			}
		}
	}
	return best;
}

/** Append `i` to the ascending index list under `key`. */
function addIndex<K>(m: Map<K, number[]>, key: K, i: number): void {
	const list = m.get(key);
	if (!list) {
		m.set(key, [i]);
		return;
	}
	// Indexes arrive ascending except when a row is re-filed after a merge
	// moved it: keep the list sorted, which is the order a rebuild from `out`
	// (forEach) would give, and which the nearest-match tie-break reads.
	let at = list.length;
	while (at > 0 && list[at - 1] > i) {
		at--;
	}
	list.splice(at, 0, i);
}

function removeIndex<K>(m: Map<K, number[]>, key: K, i: number): void {
	const list = m.get(key);
	if (!list) {
		return;
	}
	const at = list.indexOf(i);
	if (at >= 0) {
		list.splice(at, 1);
	}
	if (list.length === 0) {
		m.delete(key);
	}
}

/** Layer a per-country AIXM overlay on top of an existing airport view
 *  (worldwide baseline or already-merged with a previous country). An ICAO
 *  shared with the baseline is enriched in place; an AIXM-only ident (and every
 *  national code, see `isIcaoShaped`) is matched to a co-located baseline
 *  aerodrome listed under a different ident when one exists (see
 *  PROXIMITY_MERGE_M), else appended as a new aerodrome. Called once per country
 *  in precedence order (FR > UK > ES): mergeAixmOverlays below with one overlay. */
export function mergeAixmOverlay(base: Airport[], fr: Airport[]): Airport[] {
	return mergeAixmOverlays(base, [fr]);
}

/** Every overlay in precedence order onto `base`, exactly as folding
 *  mergeAixmOverlay over them would (tests/airportMerge.spec.ts pins it), but
 *  with the lookups built ONCE: the fold rebuilt an ident Map and a string-
 *  keyed grid over the whole ~42k-row view for each of the 18 publishers,
 *  empty ones included, at every country arrival, which was the boot's
 *  longest task (417 ms; 2.5 s on a phone-class CPU; docs/performance-2026-09.md).
 *
 *  What the fold's per-call rebuild meant is kept exactly:
 *  - The ident lookup a pass sees is the view at the pass's START, the last
 *    row carrying an ident winning (a Map built by forEach): `identRows`
 *    keeps every row's index under its ident, ascending, and answers the last.
 *  - The grid a pass sweeps is also the view at its start: rows appended
 *    during a pass are not matchable by the same overlay's later rows, and a
 *    row a merge moved or re-idented is re-filed only when the pass ends.
 *  - `consumed` is per overlay. */
export function mergeAixmOverlays(base: Airport[], overlays: readonly Airport[][]): Airport[] {
	const out: Airport[] = base.slice();
	const identRows = new Map<string, number[]>();
	const grid = new Map<number, number[]>();
	for (let i = 0; i < out.length; i++) {
		addIndex(identRows, out[i].ident.toUpperCase(), i);
		addIndex(grid, cellKey(out[i].lat, out[i].lon), i);
	}
	for (const fr of overlays) {
		if (fr.length === 0) {
			continue;
		}
		const consumed = new Set<number>();
		// The rows this pass rewrites, as they stood when it started, so the
		// lookups are brought up to date once it ends.
		const touched = new Map<number, { ident: string; cell: number }>();
		const touch = (i: number): void => {
			if (!touched.has(i)) {
				touched.set(i, { ident: out[i].ident.toUpperCase(), cell: cellKey(out[i].lat, out[i].lon) });
			}
		};
		const appendedFrom = out.length;

		// Pass 1: exact ICAO matches enrich in place; defer the rest (and every
		// national-code ident, which must never claim a baseline row by name).
		const unmatched: Airport[] = [];
		for (const ax of fr) {
			const rows = isIcaoShaped(ax.ident) ? identRows.get(ax.ident.toUpperCase()) : undefined;
			const i = rows ? rows[rows.length - 1] : undefined;
			if (i == null) {
				unmatched.push(ax);
				continue;
			}
			touch(i);
			out[i] = mergeEntry(out[i], ax, out[i].ident);
			consumed.add(i);
		}

		// Pass 2: proximity-match the AIXM-only aerodromes, else append.
		for (const ax of unmatched) {
			const idx = nearestUnconsumed(ax, out, grid, consumed);
			if (idx < 0) {
				out.push(ax);
				continue;
			}
			touch(idx);
			out[idx] = mergeEntry(out[idx], ax, ax.ident);
			consumed.add(idx);
		}

		// The next pass sees the view as it now stands.
		for (const [i, was] of touched) {
			const ident = out[i].ident.toUpperCase();
			const cell = cellKey(out[i].lat, out[i].lon);
			if (ident !== was.ident) {
				removeIndex(identRows, was.ident, i);
				addIndex(identRows, ident, i);
			}
			if (cell !== was.cell) {
				removeIndex(grid, was.cell, i);
				addIndex(grid, cell, i);
			}
		}
		for (let i = appendedFrom; i < out.length; i++) {
			addIndex(identRows, out[i].ident.toUpperCase(), i);
			addIndex(grid, cellKey(out[i].lat, out[i].lon), i);
		}
	}
	return out;
}

/** The iso_country each national AIXM authority is the authoritative source
 *  for. Inside these countries the AIXM dataset (SIA / NATS / ENAIRE) is taken
 *  as the complete aerodrome list, so a worldwide-baseline (OurAirports) field
 *  the AIXM does not list is treated as stale (closed or delisted, e.g. LFSY)
 *  and dropped, and the map never plots, nor offers a dead VAC link for, a
 *  field the national AIP no longer publishes.
 *
 *  Scoped by the baseline's own iso_country, not the ICAO prefix: prefixes
 *  collide (US `GE00`, Brazilian `GCV`, Egyptian `EG-AUE` would be mis-dropped)
 *  and would miss a home field filed under a placeholder ident (`ES-0051`,
 *  `FR-0182`). Only the home territory is claimed: French overseas (iso PF / NC
 *  / RE / ...) and UK Crown Dependencies (iso JE / GG / IM) keep their
 *  OurAirports fallback, the SIA / NATS exports there being partial; their AIXM
 *  entries are still added (their `source` is set), just not made exclusive. */
const AUTHORITATIVE_COUNTRY: Partial<Record<Publisher, string>> = {
	fr: 'FR',
	uk: 'GB',
	es: 'ES',
};

/** Remove OurAirports-baseline fields (`source === null`) located in a national
 *  AIXM authority's country that the authority did not list (so were never
 *  enriched to its `source` tag by mergeAixmOverlay). Enforced only for the
 *  publishers in `loaded` (those whose dataset actually returned rows), so a
 *  dataset that failed to load never blanks its whole country. Every
 *  AIXM-sourced row (`source !== null`) is kept unconditionally. Pure. */
export function dropStaleBaseline(airports: Airport[], loaded: Publisher[]): Airport[] {
	const countries = new Set<string>();
	for (const p of loaded) {
		const cc = AUTHORITATIVE_COUNTRY[p];
		if (cc != null) {
			countries.add(cc);
		}
	}
	if (countries.size === 0) {
		return airports;
	}
	return airports.filter((a) => a.source !== null || !countries.has(a.country));
}

/** France's air-air auto-information defaults. Uncontrolled French aerodromes
 *  with no assigned frequency use 123.500 MHz "A/A", altiports 123.065 MHz
 *  (Legende2026: "en l'absence de frequence attribuee, utiliser 123.500 MHz
 *  sur AD et 123.065 MHz sur altiports"); the SIA lists nothing for them.
 *  Applied AFTER the worldwide baseline + national overlays are merged,
 *  so a field that still has no frequency from any source gets this synthetic
 *  entry, while a real baseline frequency (the tower at fields the SIA
 *  mis-types as small, e.g. Jersey / Luxembourg) is kept rather than shadowed.
 *
 *  Scope: SIA small AERODROMES only (`source === 'fr'`, which also covers the
 *  French overseas territories in the SIA export). Heliports are excluded, as
 *  the legend's rule reads "sur AD": an helistation is not an aerodrome, and
 *  the SIA publishes no radio at all for the ~250 hospital helipads it carries,
 *  which are reserved for HEMS rather than open to an air-air call. Better no
 *  frequency than an invented one. */
const FR_AUTO_INFO: AirportRadio = { freq: '123.5', unit: 'A/A', call: '' };
const FR_ALTIPORT_AUTO_INFO: AirportRadio = { freq: '123.065', unit: 'A/A', call: '' };

/** The five SIA altiports, by ident. The SIA AIXM carries NO altiport
 *  marker (verified on the 2026-08-06 export: the five Ahp rows are coded
 *  plain AD, zero "altiport" strings anywhere), so membership is this
 *  curated set from the SIA VAC altiport series. */
const FR_ALTIPORTS = new Set([
	'LFHU', // L'Alpe d'Huez
	'LFHM', // Megeve
	'LFIP', // Peyresourde-Balestas
	'LFKX', // Meribel
	'LFLJ', // Courchevel
]);

/** Germany's active military aerodromes, by ident. The DFS AIXM dataset is the
 *  CIVIL AIP: it carries no `ET*` aerodrome at all, so these fields reach the app
 *  as worldwide-baseline rows, which have no military column either (OurAirports
 *  publishes none). Their status is therefore this curated table, read off the
 *  German AIP and the ICAO chart; the baseline keeps supplying position, runways
 *  and elevation.
 *
 *  Joint is what the AIP states by giving a field BOTH a military and a civil
 *  aerodrome category. Civil access alone cannot decide it: AIP VFR AD 1-8 lets
 *  civil aircraft land at any Bundeswehr or visiting-forces aerodrome with the
 *  commander's permission (PPR), and the chart draws Noervenich military though a
 *  resident sport-flying club flies there at weekends.
 *
 *  The other `ET*` idents OurAirports carries are former bases, closed or civil
 *  today, and keep their baseline status. */
const DE_MILITARY_AERODROMES = new Map<string, 'military' | 'joint'>([
	// Joint: the AIP VFR AD 2 entry prints a military and a civil category.
	['ETHN', 'joint'], // Niederstetten, "Militaerflugplatz/Verkehrslandeplatz"
	['ETND', 'joint'], // Diepholz, "Militaerflugplatz und Verkehrslandeplatz"
	['ETNL', 'joint'], // Rostock-Laage, "Militaer- und ziviler Verkehrsflughafen"
	['ETSI', 'joint'], // Ingolstadt/Manching, "Militaerflugplatz und Verkehrsflughafen"
	['ETMN', 'joint'], // Nordholz, civil airport co-using the naval airfield's runway
	// Military. ETNN / ETAD / ETAR / ETSB are read off the ICAO chart, the rest
	// from the AIP VFR and the Bundeswehr's own publications.
	['ETNN', 'military'], // Noervenich, TaktLwG 31; the club flying is PPR only
	['ETAD', 'military'], // Spangdahlem, USAF
	['ETAR', 'military'], // Ramstein, USAF
	['ETSB', 'military'], // Buechel; the civil co-use was revoked in 2023
	['ETHF', 'military'], // Fritzlar, "Militaerflugplatz, Zivile Nutzung auf PPR Basis"
	['ETNS', 'military'], // Schleswig / Jagel
	['ETNT', 'military'], // Wittmundhafen
	['ETNH', 'military'], // Hohn
	['ETSH', 'military'], // Holzdorf
	['ETSL', 'military'], // Lechfeld
	['ETSN', 'military'], // Neuburg
	['ETNW', 'military'], // Wunstorf
	['ETHB', 'military'], // Bueckeburg
	['ETHC', 'military'], // Celle
	['ETHS', 'military'], // Fassberg
	['ETHL', 'military'], // Laupheim
	['ETHA', 'military'], // Altenstadt
	['ETWM', 'military'], // Meppen
	['ETNG', 'military'], // Geilenkirchen, NATO E-3A
	['ETOU', 'military'], // Wiesbaden-Erbenheim, US Army
	['ETEB', 'military'], // Ansbach-Katterbach, US Army
	['ETIC', 'military'], // Grafenwoehr, US Army
	['ETIK', 'military'], // Illesheim, US Army
]);

/** Stamp the German military status onto the baseline rows that carry these
 *  aerodromes. Applied AFTER the national overlays, and only to rows no AIXM
 *  publisher claimed (`source === null`), so a future DFS export listing them
 *  wins outright. `joint` implies `military`, the AIXM's own convention.
 *
 *  `access` is left as the baseline has it: `airportStatus()` reads
 *  `military && access === 'cap'` as the joint bridge for the French dataset, so
 *  writing "cap" here would show every one of these fields as joint. */
export function applyDeMilitaryStatus(airports: Airport[]): Airport[] {
	return airports.map((a) => {
		const status = a.source === null ? DE_MILITARY_AERODROMES.get(a.ident.toUpperCase()) : null;
		return status == null ? a : { ...a, military: true, joint: status === 'joint' };
	});
}

export function applyFrAutoInfoFrequency(airports: Airport[]): Airport[] {
	return airports.map((a) =>
		a.source === 'fr' && a.type === 'small_airport' && a.radios.length === 0
			? { ...a, radios: [FR_ALTIPORTS.has(a.ident) ? FR_ALTIPORT_AUTO_INFO : FR_AUTO_INFO] }
			: a,
	);
}
