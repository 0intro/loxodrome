/* Symbol-coverage net over the SHIPPED datasets: every distinct type /
 * subtype value in public/data must route to its INTENDED symbology branch,
 * so a data refresh that introduces a new value (say a CBA row, which the
 * Legende2026 draws like R / D) fails here instead of silently riding a
 * default branch. Set-membership only, never counts, so routine AIRAC
 * refreshes pass untouched. Colour hexes are deliberately NOT asserted here;
 * the palette is pinned by tests/airspaceSymbology.spec.ts. */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
	activityGlyph,
	aemBandColor,
	AEM_BAND,
	isRtba,
	symbolFor,
	type GlyphKind,
	type SymbolInput,
} from '../src/lib/map/airspaceSymbology';
import { facilityKind, airportStatus } from '../src/lib/map/airportSymbols';
import { NAVAID_LABELS } from '../src/lib/data/navaids';
import { OBSTACLE_LABELS } from '../src/lib/data/obstacles';

interface RawDataset {
	fields: string[];
	rows: unknown[][];
}

function dataset(name: string): RawDataset {
	return JSON.parse(
		readFileSync(new URL(`../public/data/${name}.json`, import.meta.url), 'utf-8'),
	) as RawDataset;
}

/* Every shipped dataset of one kind, read off the committed directory
 * rather than a hand-kept list: a hardcoded list silently stops covering
 * a publisher the day it is added, which is exactly what happened to
 * de-airspaces and at-airspaces. The `.next` twins are skipped; they are
 * the same builder's output one cycle ahead. */
function shippedDatasets(suffix: string): string[] {
	const dir = new URL('../public/data/', import.meta.url);
	return readdirSync(dir)
		.filter((f) => f.endsWith(`${suffix}.json`) && !f.endsWith(`${suffix}.next.json`))
		.map((f) => f.slice(0, -'.json'.length))
		.sort();
}

/* Stringify a JSON scalar cell, mapping a missing (null) cell to ''. A
 * dedicated helper keeps the type-aware linter happy: String() over a bare
 * `unknown ?? ''` widens to {} and trips no-base-to-string. */
function cellText(v: unknown): string {
	if (typeof v === 'string') return v;
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	return '';
}

/* ------------------------------------------------------------------ */
/* Airspaces: type -> symbol family                                    */
/* ------------------------------------------------------------------ */

/** The intended Legende2026 / GEN 2.3 family for every airspace type the
 *  datasets may carry. A NEW type must be added here (and to symbolFor's
 *  routing) deliberately; the "every type is mapped" test below fails on
 *  anything unknown. */
const TYPE_FAMILY: Record<string, string> = {
	// rubine 45-degree hatch fringe (Legende2026 "R D CBA" row; the be
	// dataset types its CBA rows CBA from its next weekly refresh)
	R: 'hatch', D: 'hatch', CBA: 'hatch', MOA: 'hatch', W: 'hatch', A: 'hatch', TFR: 'hatch',
	// rubine crosshatch chain ("P" row)
	P: 'cross',
	// dashed blue edge over a continuous band
	CTR: 'ctr',
	// blue round-dot ring
	ATZ: 'atz',
	// ink dashes, interior untouched
	TMZ: 'mandatory', RMZ: 'mandatory', 'TMZ-RMZ': 'mandatory',
	ADIZ: 'adiz',
	TRA: 'tra',
	TSA: 'tra',
	SIV: 'siv',
	// FIR-level FIS sectors: not charted, the resolver draws nothing
	FIC: 'fic',
	'DLG-ATS': 'dlg',
	// FIR comb (alternating ticks)
	FIR: 'fir', UIR: 'fir', OCA: 'fir', ARTCC: 'fir', ACC: 'fir',
	// upper / en-route constructs: thin blue line only
	UTA: 'enroute', FRA: 'enroute', TRSA: 'enroute', SATA: 'enroute',
	// activity family: official pictogram
	ACTIVITY: 'activity', PARACHUTE: 'activity', PARAGLIDER: 'activity',
	GLIDER: 'activity', BALLOON: 'activity', TOWING: 'activity', FBZ: 'activity',
	// controlled airspace banded by ICAO class (LTA rides the TMA / CTA row
	// of the Legende2026 class table)
	TMA: 'classBanded', CTA: 'classBanded', LTA: 'classBanded', CLASS: 'classBanded',
};

/** Official pictogram per AIXM txtLocalType (subtype routes first). */
const GLYPH_BY_SUBTYPE: Record<string, GlyphKind | null> = {
	AER: 'modelAircraft',
	VOL: 'aerobatics',
	PJE: 'parachute',
	TRPLA: 'glider',
	TRVL: 'paraglider',
	TRPVL: 'paraglider',
	BAL: 'balloon',
	AP: 'drone',
	// SUR / PRN sites keep natureLayer's bullseye as their only mark.
	SUR: null,
	PRN: null,
};

/** Pictogram per emitted type when the subtype does not route. */
const GLYPH_BY_TYPE: Record<string, GlyphKind> = {
	PARACHUTE: 'parachute',
	PARAGLIDER: 'paraglider',
	TOWING: 'paraglider',
	GLIDER: 'glider',
	BALLOON: 'balloon',
	FBZ: 'balloon',
};

const AIRSPACE_DATASETS: Array<{ name: string; source: string }> = [
	...shippedDatasets('-airspaces').map((name) => ({
		name,
		source: name.slice(0, name.indexOf('-')),
	})),
	// The worldwide FIR overlay does not follow the <cc>-<dataset> naming.
	{ name: 'pruatlas-firs', source: 'pruatlas' },
];

// [id, type, name, class, upper, lower, ...8 workHr, ...13 subtype]
function airspaceInputs(): Map<string, SymbolInput> {
	const combos = new Map<string, SymbolInput>();
	for (const { name, source } of AIRSPACE_DATASETS) {
		for (const r of dataset(name).rows) {
			const a: SymbolInput = {
				id: cellText(r[0]),
				type: cellText(r[1]),
				airClass: cellText(r[3]),
				upper: (r[4] as SymbolInput['upper']) ?? null,
				subtype: cellText(r[13]),
				source: source as SymbolInput['source'],
			};
			const upperKey =
				a.subtype === 'AER' && a.upper ? aemBandColor(a) : '';
			const key = `${a.type}|${a.airClass}|${a.subtype}|${source}|${isRtba(a.id) ? 1 : 0}|${upperKey}`;
			if (!combos.has(key)) {
				combos.set(key, a);
			}
		}
	}
	return combos;
}

describe('airspace dataset coverage', () => {
	const combos = airspaceInputs();

	it('maps every shipped airspace type to an intended family', () => {
		const unmapped = [...new Set([...combos.values()].map((a) => a.type))].filter(
			(t) => !(t in TYPE_FAMILY),
		);
		expect(unmapped, `unmapped airspace types: ${unmapped.join(', ')}`).toEqual([]);
	});

	it('routes every distinct combo to its intended branch', () => {
		for (const a of combos.values()) {
			const family = TYPE_FAMILY[a.type];
			const spec = symbolFor(a);
			const what = `${a.type} class=${a.airClass} subtype=${a.subtype} (${a.source} ${a.id})`;
			switch (family) {
				case 'hatch':
					expect(spec.band?.kind, what).toBe(
						a.type === 'R' && isRtba(a.id) ? 'hatchPecked' : 'hatch',
					);
					break;
				case 'cross':
					expect(spec.band?.kind, what).toBe('cross');
					break;
				case 'ctr':
					expect(spec.band?.kind, what).toBe('solid');
					expect(spec.line?.dashArray, what).toBeTruthy();
					break;
				case 'atz':
					expect(spec.line?.lineCap, what).toBe('round');
					break;
				case 'mandatory':
					expect(spec.line?.dashArray, what).toBe('10 4 3 4');
					expect(spec.band, what).toBeNull();
					break;
				case 'adiz':
					expect(spec.line?.dashArray, what).toBe('12 4 2 4 2 4');
					break;
				case 'tra':
					expect(spec.line, what).toBeTruthy();
					expect(spec.band, what).toBeNull();
					expect(spec.marks, what).toBeNull();
					break;
				case 'siv':
					expect(spec.marks?.kind, what).toBe('squareDots');
					expect(spec.line, what).toBeNull();
					break;
				case 'fic':
					expect(spec.line, what).toBeNull();
					expect(spec.band, what).toBeNull();
					expect(spec.marks, what).toBeNull();
					expect(spec.glyph, what).toBeNull();
					break;
				case 'dlg':
					expect(spec.marks?.kind, what).toBe('fineComb');
					expect(spec.line, what).toBeNull();
					break;
				case 'fir':
					expect(spec.marks?.kind, what).toBe('comb');
					break;
				case 'enroute':
					expect(spec.line, what).toBeTruthy();
					expect(spec.band, what).toBeNull();
					expect(spec.marks, what).toBeNull();
					expect(spec.glyph, what).toBeNull();
					break;
				case 'activity': {
					const expected =
						a.subtype in GLYPH_BY_SUBTYPE
							? GLYPH_BY_SUBTYPE[a.subtype]
							: (GLYPH_BY_TYPE[a.type] ?? 'generic');
					expect(spec.glyph, what).toBe(expected);
					expect(spec.band, what).toBeNull();
					break;
				}
				case 'classBanded':
					if (a.airClass === 'F' || a.airClass === 'G') {
						expect(spec.band, what).toBeNull();
					} else {
						expect(spec.band?.kind, what).toBe('solid');
					}
					break;
			}
		}
	});

	it('exercises every official activity pictogram', () => {
		const seen = new Set<string>();
		for (const a of combos.values()) {
			if (TYPE_FAMILY[a.type] === 'activity') {
				const g = activityGlyph(a);
				if (g) {
					seen.add(g);
				}
			}
		}
		// Every kind except ulm, which is NOTAM-pin-driven: no airspace
		// subtype keys it, classifyObstacle('ulm') does (markerIcons.ts).
		for (const kind of [
			'parachute', 'aerobatics', 'glider', 'paraglider',
			'balloon', 'modelAircraft', 'drone',
		]) {
			expect(seen.has(kind), `no dataset row drives the ${kind} pictogram`).toBe(true);
		}
	});

	it('resolves an aeromodelling height band for every AER combo', () => {
		const bands = new Set<string>();
		for (const a of combos.values()) {
			if (a.subtype === 'AER') {
				const c = aemBandColor(a);
				expect(Object.values(AEM_BAND)).toContain(c);
				bands.add(c);
			}
		}
		// The shipped data spans the full band rule (low / mid / high).
		expect(bands.size, 'AER ceiling bands exercised').toBe(3);
	});
});

/* ------------------------------------------------------------------ */
/* Airports / navaids / obstacles / nature                             */
/* ------------------------------------------------------------------ */

describe('point-feature dataset coverage', () => {
	it('maps every airport type and status', () => {
		const KNOWN = new Set([
			'large_airport', 'medium_airport', 'small_airport',
			'heliport', 'seaplane_base', 'balloonport', 'closed',
		]);
		const KINDS = new Set(['aerodrome', 'heliport', 'seaplane', 'closed', 'emergency']);
		const STATUSES = new Set(['civil', 'military', 'joint', 'restricted']);
		const statusesSeen = new Set<string>();
		for (const name of ['airports', ...shippedDatasets('-airports')]) {
			for (const r of dataset(name).rows) {
				const type = String(r[1]);
				expect(KNOWN.has(type), `${name}: unknown airport type ${type}`).toBe(true);
				expect(KINDS.has(facilityKind(type))).toBe(true);
				const status = airportStatus({
					access: (r[10] as 'cap' | 'restricted' | null) ?? null,
					military: r[11] === true,
					vfr: r[12] === true,
					ifr: r[13] === true,
					joint: r[14] === true,
				} as Parameters<typeof airportStatus>[0]);
				expect(STATUSES.has(status)).toBe(true);
				statusesSeen.add(status);
			}
		}
		// The map legend's civil + military rows are both data-driven.
		expect(statusesSeen.has('civil')).toBe(true);
		expect(statusesSeen.has('military')).toBe(true);
		// Dataset-scale walk (~83k airports x 5 files); the default 5 s
		// budget sits within noise of the real runtime once the sibling
		// airspace parses share the worker.
	}, 15000);

	it('keeps every navaid type inside the painters domain', () => {
		for (const name of shippedDatasets('-navaids')) {
			for (const r of dataset(name).rows) {
				const type = String(r[1]);
				expect(
					type in NAVAID_LABELS,
					`${name}: unknown navaid type ${type}`,
				).toBe(true);
			}
		}
	});

	it('needs no fallback for any shipped obstacle type', () => {
		for (const name of shippedDatasets('-obstacles')) {
			for (const r of dataset(name).rows) {
				const type = String(r[1]);
				expect(
					type in OBSTACLE_LABELS,
					`${name}: unknown obstacle type ${type}`,
				).toBe(true);
			}
		}
	});

	it('keeps nature rows inside the two drawn types', () => {
		for (const r of dataset('fr-nature').rows) {
			expect(['NATURE', 'SENSITIVE']).toContain(String(r[1]));
		}
	});
});
