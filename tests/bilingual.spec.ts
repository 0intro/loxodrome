/* Bilingual parity harness.
 *
 * France publishes its metropolitan NOTAM series in both French and English
 * (AIP France GEN 3.1); the world-en / world-fr fixtures carry the SAME
 * France NOTAMs (same ids) in the two languages. Every extractor that feeds
 * a NOTAM-to-feature link is supposed to be language-invariant: this spec
 * pairs the France subsets by id and pins the per-extractor mismatch sets,
 * so a parser or extractor change that breaks one language fails here.
 * Q-line coordinates legitimately differ between the translations (arc-
 * minute rounding), so geometry is compared as presence booleans only. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	classifyOwner,
	extractArpIdents,
	extractRunwayDesignators,
	parseSections,
} from '$lib/notam';
import type { Notam, OwnerResolvers } from '$lib/notam';
import { extractCitedDesignators } from '$lib/notam/airspaceIds';
import { extractAipSups } from '$lib/notam/aipSup';
import { allReplacements, parseFreqAssignments, singleFreq } from '$lib/notam/freqChange';
import { parseServiceClosure } from '$lib/notam/serviceClosure';
import { parseFuelChange } from '$lib/notam/fuelChange';
import { gradeCovers, isFuelGrade, type FuelGrade } from '$lib/data/fuel';
import { isFlightInfoServiceQCode,
	isFrequencyChangeQCode,
	isFuelQCode,
	isUnserviceableCondition } from '$lib/notam/qcode';
import { isRtbaActivationNotam, parseRtbaZones } from '$lib/notam/rtba';
import { activatedAirspaceIds } from '$lib/state/notamLinks.svelte';
import { parseFranceSubset, byId } from './worldFixtures';

const enAll = parseFranceSubset('world-en-20260610.txt');
const frAll = parseFranceSubset('world-fr-20260610.txt');
const enById = byId(enAll);
const frById = byId(frAll);

interface Pair {
	id: string;
	en: Notam;
	fr: Notam;
}
const pairs: Pair[] = [];
for (const [id, en] of enById) {
	const fr = frById.get(id);
	if (fr) {
		pairs.push({ id, en, fr });
	}
}

/** Ids of the pairs whose serialised value differs between the languages. */
function mismatches(ser: (n: Notam) => string): string[] {
	const out: string[] = [];
	for (const p of pairs) {
		if (ser(p.en) !== ser(p.fr)) {
			out.push(p.id);
		}
	}
	return out;
}

function eText(n: Notam): string {
	return parseSections(n.fullContent).E ?? '';
}

// All entries of a source NOTAM (multi-area NOTAMs emit several), for the
// geometry-presence comparison.
function groupById(notams: Notam[]): Map<string, Notam[]> {
	const m = new Map<string, Notam[]>();
	for (const n of notams) {
		const arr = m.get(n.id);
		if (arr) {
			arr.push(n);
		} else {
			m.set(n.id, [n]);
		}
	}
	return m;
}
const enGroups = groupById(enAll);
const frGroups = groupById(frAll);

// Ownership resolvers: FIR idents from the committed pruatlas dataset, no
// airports, so classification is deterministic (the ownership.spec recipe).
const pruatlas = JSON.parse(
	readFileSync(new URL('../public/data/pruatlas-firs.json', import.meta.url), 'utf-8'),
) as { rows: unknown[][] };
const firIds = new Set(pruatlas.rows.map((r) => String(r[0]).toUpperCase()));
const resolvers: OwnerResolvers = {
	isAirport: () => false,
	isFir: (c) => firIds.has(c),
};

describe('bilingual France pairing', () => {
	it('pairs a stable share of the two subsets', () => {
		expect(enById.size).toBe(1648);
		expect(frById.size).toBe(1857);
		expect(pairs.length).toBe(1242);
	});

	it('anchors: the F0543/26 VOR MEN pair exists in both languages', () => {
		const p = pairs.find((x) => x.id === 'F0543/26');
		expect(p).toBeTruthy();
		expect(p!.en.fullContent).toContain('U/S');
		expect(p!.fr.fullContent).toContain('HORS SERVICE');
	});
});

describe('language-invariant header data', () => {
	it('Q-codes match', () => {
		expect(mismatches((n) => n.qCode)).toEqual([]);
	});

	it('validity windows match', () => {
		expect(
			mismatches(
				(n) =>
					`${n.startDate?.getTime() ?? 'x'}|${n.permanent ? 'PERM' : (n.endDate?.getTime() ?? 'x')}|${n.estimated ? 'EST' : ''}`,
			),
		).toEqual([]);
	});

	it('F)/G) vertical limits match', () => {
		expect(
			mismatches((n) => JSON.stringify([n.fgLower, n.fgUpper])),
		).toEqual([]);
	});

	it('A) codes match', () => {
		expect(
			mismatches((n) => n.icaoCodes.map((c) => c.toUpperCase()).join(' ')),
		).toEqual([]);
	});

	it('ownership classification matches', () => {
		expect(mismatches((n) => JSON.stringify(classifyOwner(n, resolvers)))).toEqual([]);
	});

	it('marker-pictogram classification matches', () => {
		// The residue is id collisions across states, not language drift:
		// the world files carry several states' NOTAMs under one id, and
		// byId's first-wins picks different states in the two files (the
		// "FR twin" of A3315/26 is a JFK crane, of A3533/26 a Swedish
		// fuelling notice, of M1341/26 a Croatian TSA; A2564/26 pairs two
		// same-text NOTAMs whose Q subjects differ, so the Q fallback does).
		expect(mismatches((n) => n.obstacleType)).toEqual([
			'A2564/26',
			'A3315/26',
			'A3533/26',
			'M1341/26',
		]);
	});
});

describe('language-invariant link extractors', () => {
	it('activation designator ids match', () => {
		expect(mismatches((n) => activatedAirspaceIds(n).join(' '))).toEqual([]);
	});

	it('cited designator keys match', () => {
		// Two known French-phrasing gaps: the FR texts cite bare designators
		// without the LF prefix ("ZONES R65-R66 ET D67", "ZONES CONCERNEES :
		// R20") where the EN texts write "LF-R65" / "LF-R20". A bare-token
		// grammar is deferred (prefix-less D67 collides with road and
		// department numbering); these two ids document the gap.
		expect(
			mismatches((n) =>
				extractCitedDesignators(n.fullContent, n.qualifier?.fir ?? '')
					.map((c) => c.key)
					.join(' '),
			),
		).toEqual(['M1345/26', 'M1921/26']);
	});

	it('AIP SUP references match (the French AIRAC order included)', () => {
		// Compared as unique keys: the link semantics dedupe citations, and
		// the FR A3815/26 cites its SUP twice with one occurrence garbled by
		// an SIA typo ("SUP AIP AIARAC 085/26"), which must not read as a
		// language gap. R0832/26 is a genuine SIA discrepancy: the English
		// NOTAM cites SUP 046/26 where the French one cites 047/26.
		expect(
			mismatches((n) =>
				[...new Set(extractAipSups(n.fullContent).map((r) => `${r.number}/${r.year}`))]
					.sort()
					.join(' '),
			),
		).toEqual(['R0832/26']);
	});

	it('the LFPG A0188/26 trigger pair yields SUP 4/2026 in both languages', () => {
		const p = pairs.find((x) => x.id === 'A0188/26');
		expect(p).toBeTruthy();
		for (const n of [p!.en, p!.fr]) {
			expect(extractAipSups(n.fullContent).map((r) => `${r.number}/${r.year}`)).toEqual([
				'4/2026',
			]);
		}
	});

	it('RTBA zone lists match over the paired RTBA NOTAMs', () => {
		const rtbaPairs = pairs.filter(
			(p) => isRtbaActivationNotam(p.en) || isRtbaActivationNotam(p.fr),
		);
		expect(rtbaPairs.length).toBe(0); // Z-series present in EN only; pinned
		for (const p of rtbaPairs) {
			expect(parseRtbaZones(p.en).map((z) => z.airspaceId)).toEqual(
				parseRtbaZones(p.fr).map((z) => z.airspaceId),
			);
		}
	});

	it('ARP-cited idents match', () => {
		expect(mismatches((n) => extractArpIdents(eText(n)).join(' '))).toEqual([]);
	});

	it('runway designators match (PISTES/SEUIL vs RWY/THR normalise together)', () => {
		// A2826/26: the EN text genuinely cites "QFU 31" prose the FR text
		// phrases differently. C1581/26: the EN text carries an SIA typo,
		// "RWY O4/22" with the letter O for the zero.
		expect(
			mismatches((n) => extractRunwayDesignators(eText(n)).sort().join(' ')),
		).toEqual(['A2826/26', 'C1581/26']);
	});

	it('service-closure statements match (the June BEAUVAIS pair is in the corpus)', () => {
		// The authoritative closure family: FIS subject + unserviceable
		// CONDITION (the resolver's close path). The FR half prints a comma
		// decimal on the withdrawn frequency, which is exactly what this pin
		// guards: unnormalised, the FR side would extract nothing and the
		// closure would apply in one language only.
		const closurePairs = pairs.filter(
			(p) => isFlightInfoServiceQCode(p.en.qCode) && isUnserviceableCondition(p.en.qCode),
		);
		// The paired family in this corpus: the BEAUVAIS sector closure (freq
		// stated, substitutes designated), and the RENNES whole-FIS outage in
		// its A and F series (NO frequency stated, and "ALERT ON 121.500" is
		// not a CONTACT, so both halves read freq null + no substitutes: the
		// flag-only path). The LYON QCAAS withdrawal exists in one language
		// only, so it is not a pair.
		expect(closurePairs.map((p) => p.id).sort()).toEqual([
			'A3345/26',
			'A3741/26',
			'F1229/26',
		]);
		const ser = (n: Notam): string => {
			const c = parseServiceClosure(eText(n));
			return `${c.freq ?? ''}|${c.substitutes.map((s) => s.freq).join(' ')}`;
		};
		const out: string[] = [];
		for (const p of closurePairs) {
			if (ser(p.en) !== ser(p.fr)) {
				out.push(`${p.id}: ${ser(p.en)} vs ${ser(p.fr)}`);
			}
		}
		expect(out).toEqual([]);
		// The BEAUVAIS pair really reads its value out of BOTH halves.
		const beauvais = closurePairs.find((p) => p.id === 'A3345/26')!;
		expect(parseServiceClosure(eText(beauvais.fr)).freq).toBe('119.800');
		expect(parseServiceClosure(eText(beauvais.en)).freq).toBe('119.800');
	});

	it('the out-of-service tier matches, or is a listed wording asymmetry', () => {
		// serviceStatus is the tier gate under BOTH the FIS service closures
		// (mechanism 14) and the fuel withdrawals (15), so a phrase only one
		// language carries silently changes a nav-log frequency or a fuel
		// chip. It was pinned for the fuel family alone and the gap showed:
		// French agrees its adjectives, and INDISPONIBLES / INUTILISABLES
		// read as nothing while NOT AVBL read as an outage.
		//
		// The remainder is the corpus's own translation asymmetry, where the
		// two halves genuinely say different things, and each is listed so a
		// regression cannot hide in the count:
		//   A1354/26 B2259/26 W2690/25 W2691/25  EN "WITHDRAWN" against FR
		//       "SUPPRESSION / SUPPRIMES / SUPPRIMEE", which is a deletion
		//       from the AIP rather than an outage. Left as it is on purpose:
		//       serviceStatusFromText does not fold accents, so SUPPRIMEE
		//       would read and SUPPRIMÉE would not, and half a rule here is
		//       worse than none.
		//   A1538/26 B5276/25 C0425/26 C1366/26  minima tables, EN only
		//   A3510/26  EN "FATO CLSD" / FR "FATO INUTILISABLE"
		//   C1454/26 C2104/26  EN "U/S" / FR "NON SECOURUE" (not backed up)
		//   E1705/26 E2335/26  FR "HORS SERVICE ATS", which here means
		//                      OUTSIDE the ATS service hours, not out of order
		const differing = pairs
			.filter((p) => p.en.serviceStatus !== p.fr.serviceStatus)
			.map((p) => p.id)
			.sort();
		expect(differing).toEqual([
			'A1354/26',
			'A1538/26',
			'A3510/26',
			'B2259/26',
			'B5276/25',
			'C0425/26',
			'C1366/26',
			'C1454/26',
			'C2104/26',
			'E1705/26',
			'E2335/26',
			'W2690/25',
			'W2691/25',
		]);
	});

	it('fuel withdrawals match', () => {
		// The withdrawal family: fuel subject + a text this build reads as
		// unserviceable. Whether a NOTAM strikes a chip must not depend on
		// which language the pilot has the app in.
		const fuelPairs = pairs.filter(
			(p) => isFuelQCode(p.en.qCode) && p.en.serviceStatus === 'unserviceable',
		);
		expect(fuelPairs.length).toBeGreaterThan(0);

		// The tier itself is part of the pin: 'AVGAS NON DISPONIBLE' read as
		// nothing in French while its English half read as an outage, until
		// the phrase went into serviceStatus.ts.
		for (const p of fuelPairs) {
			expect(p.fr.serviceStatus, p.id).toBe('unserviceable');
		}

		// Shape first, which is language-invariant on its face.
		const shape = (n: Notam): string =>
			parseFuelChange(eText(n))
				.map((st) => `${st.scope}${st.bare ? '!' : '?'}`)
				.join(' ');
		expect(fuelPairs.filter((p) => shape(p.en) !== shape(p.fr)).map((p) => p.id)).toEqual([]);

		// Then the grades, folded the way the resolver folds them. Raw
		// equality would fail on D3065/26, whose halves name the family and
		// the grade, and pinning THAT as a known mismatch would hide the very
		// thing the family exists to fix: against a published row the two
		// resolve to the same chip.
		const struck = (n: Notam, published: readonly FuelGrade[]): string =>
			published
				.filter((pg) =>
					parseFuelChange(eText(n)).some(
						(st) =>
							st.bare &&
							(st.scope === 'all' ||
								st.grades.some((g) => isFuelGrade(g) && gradeCovers(pg, g))),
					),
				)
				.join(',');
		// Against the aerodrome's OWN published grades, which is what the
		// resolver folds against and the only question that has an answer.
		// A family word genuinely covers more than a grade does, so the two
		// halves of D3065/26 differ over a hypothetical row publishing every
		// avgas; over Corte's row, which publishes one, they meet.
		const published = new Map<string, FuelGrade[]>(
			(
				JSON.parse(readFileSync('public/data/fr-fuel.json', 'utf8')) as {
					fields: string[];
					rows: unknown[][];
				}
			).rows.map((r) => [
				r[0] as string,
				(r[2] as [string, string][]).map(([g]) => g as FuelGrade),
			]),
		);
		const out: string[] = [];
		let checked = 0;
		for (const p of fuelPairs) {
			const rows = p.en.icaoCodes.map((c) => published.get(c.toUpperCase())).filter(Boolean);
			if (rows.length === 0) {
				continue;
			}
			checked++;
			for (const row of rows) {
				if (struck(p.en, row!) !== struck(p.fr, row!)) {
					out.push(`${p.id}: ${struck(p.en, row!)} vs ${struck(p.fr, row!)}`);
				}
			}
		}
		expect(out).toEqual([]);
		expect(checked).toBeGreaterThan(0);
	});

	it('frequency-change values match', () => {
		const freqPairs = pairs.filter((p) => isFrequencyChangeQCode(p.en.qCode));
		expect(freqPairs.length).toBe(32);
		const out: string[] = [];
		// Every value the resolver can act on, including the pair each labelled
		// row states: the two halves reach it through DIFFERENT connectors
		// (INSTEAD OF vs AU LIEU DE, REPLACES vs REMPLACE), which is exactly the
		// asymmetry that once left the French half of E3291/26 value-less.
		const values = (n: Notam): string => {
			const e = eText(n);
			const freqs = [...new Set(parseFreqAssignments(e).map((a) => `${a.was ?? '-'}>${a.freq}`))].sort();
			const repls = allReplacements(e).map((r) => `${r.was}>${r.freq}`).sort();
			return `${freqs.join(' ')}|${repls.join(' ')}|${singleFreq(e) ?? ''}`;
		};
		for (const p of freqPairs) {
			if (values(p.en) !== values(p.fr)) {
				out.push(p.id);
			}
		}
		expect(out).toEqual([]);
	});
});

describe('geometry presence (never compared numerically)', () => {
	it('PSN / polygon presence matches', () => {
		const present = (entries: Notam[] | undefined): string => {
			if (!entries) {
				return 'x';
			}
			const psn = entries.some((e) => e.coordinates.some((c) => c.type === 'psn'));
			const poly = entries.some((e) => e.isPolygon);
			return `${psn ? 'P' : '-'}${poly ? 'A' : '-'}`;
		};
		const out: string[] = [];
		for (const p of pairs) {
			if (present(enGroups.get(p.id)) !== present(frGroups.get(p.id))) {
				out.push(p.id);
			}
		}
		// Known gap: the ENGLISH prose contains an area keyword ("LATERAL
		// PROTECTION AREA") that promotes a list of separate obstacle
		// positions to one polygon, while the French wording ("SERVITUDE
		// LATERALE") keeps them as positions (which is the more faithful
		// reading). An area-keyword refinement is deferred; the id documents
		// the asymmetry. (R1572/26 left the list when tagged arc centres
		// started promoting their group to a polygon in both languages, and
		// W0528/26 when parseAerobaticAxis learned the "AXE : ORIENTE"
		// form.)
		expect(out).toEqual(['P1226/26']);
	});
});
