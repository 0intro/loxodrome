/* airportMerge.ts layers a per-country AIXM airport overlay onto the worldwide
 * OurAirports baseline (or an already-merged view). Pure; unit-tested in
 * tests/airportMerge.spec.ts. */

import type { Airport, AirportRadio } from './airports';
import type { Publisher } from '$lib/state/layers.svelte';
import { equirectangularDistanceM } from '$lib/notam/geometry';

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
 *  publish radios for, keep their worldwide frequencies). */
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
		runways: ax.runways.length > 0 ? ax.runways : baseAp.runways,
		access: ax.access ?? baseAp.access,
		military: ax.military,
		joint: ax.joint,
		vfr: ax.vfr,
		ifr: ax.ifr,
		radios: ax.radios.length > 0 ? ax.radios : baseAp.radios,
		source: ax.source,
		charts: ax.charts.length > 0 ? ax.charts : baseAp.charts,
	};
}

/** Index in `out` of the nearest not-yet-consumed baseline aerodrome to `ax`
 *  within PROXIMITY_MERGE_M, or -1. Uses the coarse 0.1 deg `grid` (a 3x3
 *  cell sweep covers the radius at any latitude). */
function nearestUnconsumed(
	ax: Airport,
	out: Airport[],
	grid: Map<string, number[]>,
	consumed: Set<number>,
): number {
	const clat = Math.round(ax.lat * 10);
	const clon = Math.round(ax.lon * 10);
	let best = -1;
	let bestM = PROXIMITY_MERGE_M;
	for (let dla = -1; dla <= 1; dla++) {
		for (let dlo = -1; dlo <= 1; dlo++) {
			const list = grid.get(`${clat + dla}/${clon + dlo}`);
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

/** Layer a per-country AIXM overlay on top of an existing airport view
 *  (worldwide baseline or already-merged with a previous country). An ICAO
 *  shared with the baseline is enriched in place; an AIXM-only ident (and every
 *  national code, see `isIcaoShaped`) is matched to a co-located baseline
 *  aerodrome listed under a different ident when one exists (see
 *  PROXIMITY_MERGE_M), else appended as a new aerodrome. Called once per country
 *  in precedence order (FR > UK > ES). */
export function mergeAixmOverlay(base: Airport[], fr: Airport[]): Airport[] {
	const out: Airport[] = base.slice();
	const outIdx = new Map<string, number>();
	out.forEach((a, i) => outIdx.set(a.ident.toUpperCase(), i));
	// Coarse 0.1 deg grid over the baseline for the proximity fallback.
	const grid = new Map<string, number[]>();
	out.forEach((a, i) => {
		const k = `${Math.round(a.lat * 10)}/${Math.round(a.lon * 10)}`;
		const list = grid.get(k);
		if (list) {
			list.push(i);
		} else {
			grid.set(k, [i]);
		}
	});
	const consumed = new Set<number>();

	// Pass 1: exact ICAO matches enrich in place; defer the rest (and every
	// national-code ident, which must never claim a baseline row by name).
	const unmatched: Airport[] = [];
	for (const ax of fr) {
		const i = isIcaoShaped(ax.ident) ? outIdx.get(ax.ident.toUpperCase()) : undefined;
		if (i == null) {
			unmatched.push(ax);
			continue;
		}
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
		const old = out[idx].ident.toUpperCase();
		out[idx] = mergeEntry(out[idx], ax, ax.ident);
		consumed.add(idx);
		outIdx.delete(old);
		outIdx.set(ax.ident.toUpperCase(), idx);
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
