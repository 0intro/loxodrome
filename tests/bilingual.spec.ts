/* Bilingual parity harness.
 *
 * France publishes its metropolitan NOTAM series in both French and English
 * (AIP France GEN 3.1). Each pair of world-en / world-fr fixtures carries
 * the SAME France NOTAMs (same ids) in the two languages. Every extractor
 * that feeds a NOTAM-to-feature link is supposed to be language-invariant:
 * this spec pairs the France subsets by id and pins the per-extractor
 * mismatch sets of each pair, so a parser or extractor change that breaks
 * one language fails here. The June pair took its English half from
 * Autorouter and its French half from SOFIA-Briefing, and the November
 * pair both halves from one SOFIA-Briefing sweep.
 * Q-line coordinates legitimately differ between the translations (arc-
 * minute rounding), so geometry is compared as presence booleans only. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	classifyOwner,
	ownerPinOnField,
	ON_FIELD_NM,
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
import { firSubjectGroup,
	isFlightInfoServiceQCode,
	isFrequencyChangeQCode,
	isFuelQCode,
	isUnserviceableCondition } from '$lib/notam/qcode';
import { isRtbaActivationNotam, parseRtbaZones } from '$lib/notam/rtba';
import { extractObstacleHeights } from '$lib/notam/obstacleHeights';
import { activatedAirspaceIds, notamNamesAirspace } from '$lib/state/notamLinks.svelte';
import { arpCitedIdents } from '$lib/state/notamAirportLinks.svelte';
import { equirectangularDistanceM } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import type { Airspace } from '$lib/data/airspaces';
import { parseFranceSubset, byId } from './worldFixtures';

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

/** A pair of world briefings, the same France NOTAMs in English and in
 *  French, and the ids where its two halves are known to differ, each list
 *  with the reason the texts give for it. */
interface Corpus {
	name: string;
	en: string;
	fr: string;
	/** The France NOTAMs of each half, by id, and the pairs of them. */
	sizes: [number, number, number];
	/** Pairs whose halves hold the words given, one in each language. */
	anchors: { id: string; en: string; fr: string }[];
	pictograms: string[];
	designators: string[];
	sups: string[];
	/** Pairs that cite AIP SUPs, and the SUPs both halves read. */
	supAnchors: { id: string; sups: string[] }[];
	rtba: number;
	arp: string[];
	heights: string[];
	runways: string[];
	/** The pairs of the closure family. */
	closures: string[];
	/** Closure pairs whose halves both read the frequency withdrawn. */
	closureAnchors: { id: string; freq: string }[];
	tiers: string[];
	fuelShapes: string[];
	fuelGrades: string[];
	freqPairs: number;
	freqValues: string[];
	onField: string[];
	fis: string[];
	fisLinked: number;
	presence: string[];
}

const corpora: Corpus[] = [
	{
		name: '2026-06-10',
		en: 'world-en-20260610.txt',
		fr: 'world-fr-20260610.txt',
		sizes: [1648, 1857, 1242],
		// The VOR MEN pair.
		anchors: [{ id: 'F0543/26', en: 'U/S', fr: 'HORS SERVICE' }],
		pictograms: [],
		// The French halves write a designator with no prefix at all
		// ("ZONES R65-R66 ET D67", "ZONES CONCERNEES : R20") where the
		// English write "LF-R65" and "LF-R20". The citation tier leaves such
		// a designator out, as a bare "AREA P2" names a parking area as
		// often as the zone LF-P2.
		designators: ['M1345/26', 'M1921/26'],
		// The FR A3815/26 cites its SUP twice with one occurrence garbled by
		// an SIA typo ("SUP AIP AIARAC 085/26"), which must not read as a
		// language gap. R0832/26 is a genuine SIA discrepancy: the English
		// NOTAM cites SUP 046/26 where the French one cites 047/26.
		sups: ['R0832/26'],
		// The LFPG trigger pair.
		supAnchors: [{ id: 'A0188/26', sups: ['4/2026'] }],
		// The Z series is in the English file alone.
		rtba: 0,
		arp: [],
		// The SIA's English text carries two typos in a height label:
		// P1487/26 "HGR : 112FT" and P1543/26 "HEIGT : 178FT".
		heights: ['P1487/26', 'P1543/26'],
		// A2826/26: the EN text genuinely cites "QFU 31" prose the FR text
		// phrases differently. C1581/26: the EN text carries an SIA typo,
		// "RWY O4/22" with the letter O for the zero.
		runways: ['A2826/26', 'C1581/26'],
		// The BEAUVAIS sector closure (freq stated, substitutes designated),
		// and the RENNES whole-FIS outage in its A and F series (NO frequency
		// stated, and "ALERT ON 121.500" is not a CONTACT, so both halves read
		// freq null + no substitutes: the flag-only path). The LYON QCAAS
		// withdrawal exists in one language only, so it is not a pair.
		closures: ['A3345/26', 'A3741/26', 'F1229/26'],
		closureAnchors: [{ id: 'A3345/26', freq: '119.800' }],
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
		tiers: [
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
		],
		fuelShapes: [],
		fuelGrades: [],
		freqPairs: 32,
		freqValues: [],
		// Three pairs straddle the ring: their halves state positions an
		// arcminute apart, one inside 3 NM of the ARP and one outside, so the
		// pin hides in one language and shows in the other. The SIA's two
		// texts disagree there and the rule cannot know which is right. They
		// are pinned so that a new one, or a disagreement with no such drift
		// behind it, is seen.
		onField: ['C2055/26 LFAQ', 'C2217/26 LFBU', 'R0832/26 LFNA'],
		// A5453/26 is the pair whose halves once linked different sectors.
		fis: [],
		fisLinked: 13,
		// Known gap: the ENGLISH prose contains an area keyword ("LATERAL
		// PROTECTION AREA") that promotes a list of separate obstacle
		// positions to one polygon, while the French wording ("SERVITUDE
		// LATERALE") keeps them as positions (which is the more faithful
		// reading). An area-keyword refinement is deferred. The id documents
		// the asymmetry. (R1572/26 left the list when tagged arc centres
		// started promoting their group to a polygon in both languages, and
		// W0528/26 when parseAerobaticAxis learned the "AXE : ORIENTE"
		// form.)
		presence: ['P1226/26'],
	},
	{
		name: '2026-11-22',
		en: 'world-en-20261122.txt',
		fr: 'world-fr-20261122.txt',
		// Both halves come from one sweep, so every NOTAM pairs.
		sizes: [2413, 2413, 2413],
		anchors: [{ id: 'P2309/26', en: 'RADIO MAST', fr: 'MAT RADIO' }],
		//   A6610/26 A7258/26  the English names its lights as the label of a
		//       field ("EDGE LIGHTING : READ", "TDZ LIGHTS : -"), which the
		//       lighting rule reads as an obstacle's lighting field, and the
		//       French as the subject (BALISAGE LATERAL, FEUX)
		//   B5166/26 D6744/26 E4036/26  the French writes BALISEE/ECLAIREE,
		//       ALLUMAGE and NON ECLAIREE where the English writes LGT
		//   E5419/26 M3615/26  the French BALISAGE is a beacon and red and
		//       white markers (BEACON TRIAL, RED AND WHITE MARKERS)
		//   P2907/26  the English drops the word CRANES ("2 MOBILE OPR")
		//   W1646/26  the halves call activity 6815 of ENR 5.5 MODEL FLYING
		//       and VOLTIGE
		pictograms: [
			'A6610/26',
			'A7258/26',
			'B5166/26',
			'D6744/26',
			'E4036/26',
			'E5419/26',
			'M3615/26',
			'P2907/26',
			'W1646/26',
		],
		// The French halves write a bare R20, as M1921/26 of June does, after
		// a ZONES that ends the line before ("CONCERNEES : R20" opens the
		// next).
		designators: ['M4079/26', 'M4082/26'],
		sups: [],
		supAnchors: [{ id: 'P2857/26', sups: ['129/2026'] }],
		// Both files carry the Z series.
		rtba: 2,
		// One half writes its radial "RDL 289/6.22NM LFLD ARP", the other
		// "RDL 289/6.2NM LFLD" without ARP.
		arp: ['P4028/26', 'P4255/26'],
		// P0297/26: the halves state two heights, 109FT and 103FT. The
		// English carries a typo in a label: P3664/26 "HEIGT", P3978/26
		// "ELEC" for ELEV, and P4272/26 "HIGHT".
		heights: ['P0297/26', 'P3664/26', 'P3978/26', 'P4272/26'],
		// The half named writes a runway number with no RWY or PISTE before
		// it: the French of D6070/26 ("FEUX ECLATS 03"), E3699/26 ("PROC APCH
		// RNP 10"), E5240/26 ("PROCEDURES RNP 04 ET 22") and M2970/26 ("INS
		// GNSS29"), and the English of P4032/26 ("LDG FUNNEL 23").
		runways: ['D6070/26', 'E3699/26', 'E5240/26', 'M2970/26', 'P4032/26'],
		// Two ground frequencies, the automatic information transmitter of
		// LF-R65, LF-R66 and LF-R325, the NANTES FIS outage in its A and F
		// series (no frequency stated, the flag-only path), and the 8.33 kHz
		// instructions of LFSB removed.
		closures: ['A4422/26', 'A7829/26', 'C4250/26', 'C4806/26', 'F2434/26', 'R3484/26'],
		closureAnchors: [{ id: 'C4250/26', freq: '121.880' }],
		//   A7835/26 B5590/26 C3442/26 C3443/26 C3922/26 C4485/26 E5071/26
		//       E5080/26 E5296/26 M3715/26  EN "SECONDARY POWER SUPPLY U/S"
		//       against FR "NON SECOURUE" (not backed up), as in June
		//   A4899/26 B0986/26 B3097/26 D4827/26 D5292/26 H0115/26  EN
		//       "WITHDRAWN" against FR "SUPPRIME / SUPPRESSION", as in June
		//   A7838/26 B3727/26 C0425/26  EN "NOT AVBL" against FR "PAS DE
		//       PRODUCTION" and "ABSENCE ATS"
		//   A3510/26 D5143/26 E5292/26  EN "CLSD / CLOSED", outside the
		//       tier's vocabulary, against FR "INUTILISABLE / INDISPONIBLE"
		//   D6830/26  EN "NOT PROVIDED", which also says an obstacle goes
		//       unlit ("NGT SGL NOT PROVIDED"), against FR "INDISPONIBLE"
		//   E5225/26  EN "REMOVED" against FR "RETIRE DU SERVICE"
		//   A7826/26 M3993/26  a typo, EN "UNVAILABLE" and FR "INUTLISABLE"
		//   E4036/26  EN "LGT U/S" against FR "NON ECLAIREE" (not lit)
		tiers: [
			'A3510/26',
			'A4899/26',
			'A7826/26',
			'A7835/26',
			'A7838/26',
			'B0986/26',
			'B3097/26',
			'B3727/26',
			'B5590/26',
			'C0425/26',
			'C3442/26',
			'C3443/26',
			'C3922/26',
			'C4485/26',
			'D4827/26',
			'D5143/26',
			'D5292/26',
			'D6830/26',
			'E4036/26',
			'E5071/26',
			'E5080/26',
			'E5225/26',
			'E5292/26',
			'E5296/26',
			'H0115/26',
			'M3715/26',
			'M3993/26',
		],
		fuelShapes: [],
		fuelGrades: [],
		freqPairs: 70,
		// C3963/26: the English writes "INSREAD OF" for INSTEAD OF.
		freqValues: ['C3963/26'],
		onField: [],
		fis: [],
		fisLinked: 39,
		presence: [],
	},
];

describe.each(corpora)('the pair of $name', (c) => {
	const enAll = parseFranceSubset(c.en);
	const frAll = parseFranceSubset(c.fr);
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

	describe('bilingual France pairing', () => {
		it('pairs a stable share of the two subsets', () => {
			expect([enById.size, frById.size, pairs.length]).toEqual(c.sizes);
		});

		it('anchors: its known pairs exist in both languages', () => {
			expect(c.anchors.length).toBeGreaterThan(0);
			for (const a of c.anchors) {
				const p = pairs.find((x) => x.id === a.id);
				expect(p, a.id).toBeTruthy();
				expect(p!.en.fullContent).toContain(a.en);
				expect(p!.fr.fullContent).toContain(a.fr);
			}
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
			expect(mismatches((n) => n.obstacleType)).toEqual(c.pictograms);
		});
	});

	describe('language-invariant link extractors', () => {
		it('activation designator ids match', () => {
			expect(mismatches((n) => activatedAirspaceIds(n).join(' '))).toEqual([]);
		});

		it('cited designator keys match', () => {
			expect(
				mismatches((n) =>
					extractCitedDesignators(n.fullContent, n.qualifier?.fir ?? '')
						.map((c) => c.key)
						.join(' '),
				),
			).toEqual(c.designators);
		});

		it('AIP SUP references match (the French AIRAC order included)', () => {
			// Compared as unique keys: the link semantics dedupe citations.
			expect(
				mismatches((n) =>
					[...new Set(extractAipSups(n.fullContent).map((r) => `${r.number}/${r.year}`))]
						.sort()
						.join(' '),
				),
			).toEqual(c.sups);
		});

		it('its trigger pairs yield their SUPs in both languages', () => {
			expect(c.supAnchors.length).toBeGreaterThan(0);
			for (const a of c.supAnchors) {
				const p = pairs.find((x) => x.id === a.id);
				expect(p, a.id).toBeTruthy();
				for (const n of [p!.en, p!.fr]) {
					expect(extractAipSups(n.fullContent).map((r) => `${r.number}/${r.year}`)).toEqual(a.sups);
				}
			}
		});

		it('RTBA zone lists match over the paired RTBA NOTAMs', () => {
			const rtbaPairs = pairs.filter(
				(p) => isRtbaActivationNotam(p.en) || isRtbaActivationNotam(p.fr),
			);
			expect(rtbaPairs.length).toBe(c.rtba);
			for (const p of rtbaPairs) {
				expect(parseRtbaZones(p.en).map((z) => z.airspaceId)).toEqual(
					parseRtbaZones(p.fr).map((z) => z.airspaceId),
				);
			}
		});

		it('ARP-cited idents match', () => {
			expect(mismatches((n) => arpCitedIdents(n).join(' '))).toEqual(c.arp);
		});

		it('obstacle heights match over the paired obstacle NOTAMs', () => {
			const heights = (n: Notam): string =>
				firSubjectGroup(n.qCode).key === 'obstacles'
					? JSON.stringify(extractObstacleHeights(n.fullContent))
					: '';
			expect(mismatches(heights)).toEqual(c.heights);
		});

		it('runway designators match (PISTES/SEUIL vs RWY/THR normalise together)', () => {
			expect(
				mismatches((n) => extractRunwayDesignators(eText(n)).sort().join(' ')),
			).toEqual(c.runways);
		});

		it('service-closure statements match', () => {
			// The authoritative closure family: FIS subject + unserviceable
			// CONDITION (the resolver's close path). The FR half prints a comma
			// decimal on the withdrawn frequency, which is exactly what this pin
			// guards: unnormalised, the FR side would extract nothing and the
			// closure would apply in one language only.
			const closurePairs = pairs.filter(
				(p) => isFlightInfoServiceQCode(p.en.qCode) && isUnserviceableCondition(p.en.qCode),
			);
			expect(closurePairs.map((p) => p.id).sort()).toEqual(c.closures);
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
			// A closure pair really reads its value out of BOTH halves.
			for (const a of c.closureAnchors) {
				const p = closurePairs.find((x) => x.id === a.id)!;
				expect(parseServiceClosure(eText(p.fr)).freq, a.id).toBe(a.freq);
				expect(parseServiceClosure(eText(p.en)).freq, a.id).toBe(a.freq);
			}
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
			// two halves genuinely say different things, and each is listed in
			// its corpus so a regression cannot hide in the count.
			const differing = pairs
				.filter((p) => p.en.serviceStatus !== p.fr.serviceStatus)
				.map((p) => p.id)
				.sort();
			expect(differing).toEqual(c.tiers);
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
			expect(fuelPairs.filter((p) => shape(p.en) !== shape(p.fr)).map((p) => p.id)).toEqual(c.fuelShapes);

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
			// avgas. Over Corte's row, which publishes one, they meet.
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
			expect(out).toEqual(c.fuelGrades);
			expect(checked).toBeGreaterThan(0);
		});

		it('frequency-change values match', () => {
			const freqPairs = pairs.filter((p) => isFrequencyChangeQCode(p.en.qCode));
			expect(freqPairs.length).toBe(c.freqPairs);
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
			expect(out).toEqual(c.freqValues);
		});
	});

	describe('the map states of a NOTAM read the same in both languages', () => {
		// The two halves of one NOTAM may carry Q-line positions an arcminute
		// apart (see the header): the pin rule asks whether that position is ON
		// the aerodrome, so the DRIFT between the halves has to stay well inside
		// the radius or the verdict could differ by language alone.
		it('the two halves place a NOTAM within the on-field radius of each other', () => {
			const out: string[] = [];
			for (const p of pairs) {
				const qe = p.en.coordinates.find((c) => c.type === 'qualifierLine');
				const qf = p.fr.coordinates.find((c) => c.type === 'qualifierLine');
				if (!qe || !qf) {
					continue;
				}
				const nm = equirectangularDistanceM(qe.lat, qe.lon, qf.lat, qf.lon) / NM_TO_METERS;
				if (nm >= ON_FIELD_NM) {
					out.push(`${p.id} ${nm.toFixed(1)} NM`);
				}
			}
			expect(out).toEqual([]);
		});

		// ... and given that, the verdict itself agrees, asked the way the map asks
		// it: against the OWNER aerodrome's position, the dataset's ARP. Asked
		// against the EN half's own Q point, the EN verdict was true by
		// construction and the case repeated the drift test above.
		it('the on-field verdict agrees against the owner aerodrome', () => {
			const doc = JSON.parse(readFileSync('public/data/fr-airports.json', 'utf8')) as {
				fields: string[];
				rows: unknown[][];
			};
			const fi = doc.fields.indexOf('ident');
			const fla = doc.fields.indexOf('lat');
			const flo = doc.fields.indexOf('lon');
			const arp = new Map(
				doc.rows.map((r) => [String(r[fi]), { lat: Number(r[fla]), lon: Number(r[flo]) }]),
			);
			const byAirport: OwnerResolvers = {
				isAirport: (i) => arp.has(i),
				isFir: (i) => resolvers.isFir(i),
			};
			const out: string[] = [];
			let asked = 0;
			for (const p of pairs) {
				const owner = classifyOwner(p.en, byAirport);
				if (owner.kind !== 'aerodrome') {
					continue;
				}
				const pos = arp.get(owner.ident);
				if (!pos) {
					continue;
				}
				asked++;
				const en = ownerPinOnField(p.en, owner, pos);
				if (en !== ownerPinOnField(p.fr, classifyOwner(p.fr, byAirport), pos)) {
					const qe = p.en.coordinates.find((c) => c.type === 'qualifierLine');
					const qf = p.fr.coordinates.find((c) => c.type === 'qualifierLine');
					const drift = qe && qf ? equirectangularDistanceM(qe.lat, qe.lon, qf.lat, qf.lon) : 0;
					out.push(`${p.id} ${owner.ident}${drift > 0 ? '' : ' (no drift)'}`);
				}
			}
			expect(asked).toBeGreaterThan(700);
			expect(out).toEqual(c.onField);
		});

		// The FIS by-name link: the SIA writes SIV in French and FIS AREA in
		// English, and names a sector's cardinal in each language, so the two
		// halves used to link different sectors (A5595/26 and A6001/26, from the
		// 2026-09-21 corpus, are pinned by their shapes in notamFisLink.spec).
		it('a FIS NOTAM links the same sectors in both languages', () => {
			// The SIV and FIC sectors France publishes.
			const doc = JSON.parse(readFileSync('public/data/fr-airspaces.json', 'utf8')) as {
				fields: string[];
				rows: unknown[][];
			};
			const f = (k: string) => doc.fields.indexOf(k);
			const rows = doc.rows
				.filter((r) => r[f('type')] === 'SIV' || r[f('type')] === 'FIC')
				.map(
					(r) =>
						({
							id: r[f('id')],
							key: r[f('id')],
							name: r[f('name')],
							type: r[f('type')],
							source: 'fr',
							category: 'siv',
							radio: [],
							ring: [],
						}) as unknown as Airspace,
				);
			expect(rows.length).toBeGreaterThan(100);
			const named = (n: Notam): string =>
				rows
					.filter((a) => notamNamesAirspace(n, a, true))
					.map((a) => a.name)
					.sort()
					.join(',');
			const out: string[] = [];
			let linked = 0;
			for (const p of pairs.filter((p) => isFlightInfoServiceQCode(p.en.qCode))) {
				if (named(p.en) !== named(p.fr)) {
					out.push(`${p.id}: en [${named(p.en)}] fr [${named(p.fr)}]`);
				}
				if (named(p.en) !== '') {
					linked++;
				}
			}
			expect(out).toEqual(c.fis);
			// Agreement over pairs that link nothing would be vacuous.
			expect(linked).toBeGreaterThanOrEqual(c.fisLinked);
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
			expect(out).toEqual(c.presence);
		});
	});
});
