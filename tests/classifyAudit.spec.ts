/* Corpus audit of the marker-pictogram classifier: every France NOTAM in
 * the world briefings, judged against its own Q-line subject. The subject
 * is the cross-check, not the truth: France's real filing deviates from the
 * ICAO nominal meanings (WU carries mostly model flying, not drones; WZ
 * carries fireworks; WG is winching, never sailplanes; WA is unused, air
 * shows ride ZRT restrictions), so each subject maps to a SET of kinds the
 * corpus shows to be legitimate, and every remaining violation is pinned by
 * id with the reason established by reading it. classify.ts's
 * QSUBJECT_FALLBACK trusts exactly the subjects whose column here is a
 * single kind.
 *
 * The same audit runs over a fresh SOFIA sweep when AUDIT_DIR names a
 * directory of narrow-route PIB responses (sweep-*.json): each response
 * carries BOTH languages, converted through the production
 * parseSofiaResponse / sofiaNotamToIcaoText path, so the FR and EN corpora
 * align perfectly by id. That block is silent in CI and `npm test`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { byId, parseFranceByFir } from './worldFixtures';
import { parseNotams } from '$lib/notam';
import type { Notam } from '$lib/notam/types';
import {
	parseSofiaResponse,
	sofiaNotamKey,
	sofiaNotamToIcaoText,
} from '$lib/sofia/client';

const OBSTACLE_KINDS = [
	'crane', 'turbine', 'metmast', 'antenna', 'chimney', 'powerline',
	'cableway', 'terrain', 'trees', 'balisage',
];

/* Subject -> kinds the France corpora legitimise. A subject absent here is
 * not audited (RT / RR / FA restriction texts classify freely: a ZRT "DUE
 * TO AIRSHOW" legitimately wears the voltige pin). */
const ALLOWED: Record<string, string[]> = {
	WP: ['parachute'],
	WB: ['voltige'],
	WG: ['paragliding', 'glider'],
	WU: ['aeromodelisme', 'drone', 'ulm', ''],
	WC: ['balloon'],
	WL: ['balloon'],
	WZ: ['blasting'],
	WM: ['firing'],
	WD: ['blasting'],
	WE: ['', 'firing'],
	// Mass movement: whatever masses (an ULM fly-in, a paragliding
	// competition W1563/26); '' for the craft-less texts.
	WT: ['', 'ulm', 'paragliding'],
	WO: ['laser'],
	BU: ['bird'],
	OB: [...OBSTACLE_KINDS, ''],
	OL: [...OBSTACLE_KINDS],
};

function subjectOf(n: Notam): string {
	return n.qCode ? n.qCode.slice(1, 3) : '';
}

/** "id subject kind | first words", sorted, for every audited NOTAM whose
 *  kind is outside its subject's allowed set. */
function violations(notams: Notam[]): string[] {
	const out: string[] = [];
	for (const n of notams) {
		const allowed = ALLOWED[subjectOf(n)];
		if (!allowed || allowed.includes(n.obstacleType)) {
			continue;
		}
		out.push(`${n.id} ${subjectOf(n)}->${n.obstacleType || "''"}`);
	}
	return out.sort();
}

function franceById(fixture: string): Notam[] {
	return [...byId(parseFranceByFir(fixture)).values()];
}

describe('classifier vs Q-subject over the France corpora', () => {
	it('world-en-20260610', () => {
		expect(violations(franceById('world-en-20260610.txt'))).toEqual([]);
	});

	it('world-fr-20260610', () => {
		expect(violations(franceById('world-fr-20260610.txt'))).toEqual([]);
	});

	it('World-20260207 (EN, spaced Q-lines)', () => {
		expect(violations(franceById('World-20260207.txt'))).toEqual([]);
	});

	it('World-20260512 (FR, spaced Q-lines)', () => {
		expect(violations(franceById('World-20260512.txt'))).toEqual([]);
	});

	it('keeps the activity subjects classified (unclassified counts)', () => {
		const counts: Record<string, Record<string, number>> = {};
		for (const fixture of ['world-en-20260610.txt', 'world-fr-20260610.txt']) {
			const perSubject: Record<string, number> = {};
			for (const n of franceById(fixture)) {
				const s = subjectOf(n);
				if (s in ALLOWED && !n.obstacleType) {
					perSubject[s] = (perSubject[s] ?? 0) + 1;
				}
			}
			counts[fixture] = perSubject;
		}
		// The residue is read and understood: the OB entries are drills
		// (FOREUSE / DRILL stay bare by decision), fences, footbridges,
		// lightning rods, a hangar, forklifts, generic "obstacles" texts
		// and Type A chart amendments; WE is calibration flying; WU is a
		// drone NOTAM over a hospital helipad whose text names no craft.
		expect(counts).toEqual({
			'world-en-20260610.txt': { OB: 12, WE: 3, WU: 1 },
			'world-fr-20260610.txt': { OB: 17, WU: 1 },
		});
	});
});

/* The fresh-sweep block: AUDIT_DIR holds sweep-*.json narrow-route PIB
 * responses. Reports per-language stats and asserts the audit table plus
 * FR/EN classification parity (the two languages come from the same bytes,
 * so the id sets match exactly). */
describe.runIf(process.env.AUDIT_DIR)('fresh SOFIA sweep audit', () => {
	function sweepCorpus(lang: 'en' | 'fr'): Notam[] {
		const dir = process.env.AUDIT_DIR!;
		const seen = new Map<string, ReturnType<typeof parseSofiaResponse>[number]>();
		for (const f of readdirSync(dir).filter((f) => /^sweep-.*\.json$/.test(f))) {
			const payload: unknown = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
			for (const n of parseSofiaResponse(payload)) {
				seen.set(sofiaNotamKey(n), n);
			}
		}
		const text = [...seen.values()]
			.map((n) => sofiaNotamToIcaoText(n, lang))
			.join('\n\n');
		const france = parseNotams(text).filter((n) =>
			(n.qualifier?.fir ?? '').startsWith('LF'),
		);
		return [...byId(france).values()];
	}

	it('audits both languages and their parity', () => {
		const en = sweepCorpus('en');
		const fr = sweepCorpus('fr');
		if (process.env.AUDIT_WRITE) {
			// The reconstructed briefings, loadable by the app (?file= or
			// paste) for eyeballing the pins over the live map. fullContent
			// carries no id header, so each block gets one back.
			for (const [lang, list] of [['en', en], ['fr', fr]] as const) {
				writeFileSync(
					join(process.env.AUDIT_DIR!, `france-${lang}.txt`),
					list.map((n) => `${n.id} NOTAMN\n${n.fullContent}`).join('\n\n'),
				);
			}
		}
		const enById = new Map(en.map((n) => [n.id, n]));
		const frById = new Map(fr.map((n) => [n.id, n]));

		const kindCounts = (list: Notam[]) => {
			const m: Record<string, number> = {};
			for (const n of list) {
				m[n.obstacleType || "''"] = (m[n.obstacleType || "''"] ?? 0) + 1;
			}
			return Object.fromEntries(Object.entries(m).sort());
		};
		console.log(`sweep France NOTAMs: en=${en.length} fr=${fr.length}`);
		console.log('en kinds:', kindCounts(en));
		console.log('fr kinds:', kindCounts(fr));
		console.log('en violations:', violations(en));
		console.log('fr violations:', violations(fr));

		const parity: string[] = [];
		for (const [id, e] of enById) {
			const f = frById.get(id);
			if (f && f.obstacleType !== e.obstacleType) {
				parity.push(`${id} en=${e.obstacleType || "''"} fr=${f.obstacleType || "''"}`);
			}
		}
		console.log('FR/EN classification mismatches:', parity.sort());

		// Bounds, not lists: the sweep is a fresh snapshot, and some
		// divergence is the SOURCE's (the FR and EN texts are written
		// independently: the 2026-08 EN text of voltige zone NR 6815 says
		// MODEL FLYING while its FR twin says VOLTIGE; lighting NOTAMs
		// often name the obstacle in one language only). The printed report
		// is the deliverable; a real regression blows these bounds.
		expect(en.length).toBeGreaterThan(500);
		expect(Math.abs(en.length - fr.length)).toBeLessThan(10);
		expect(violations(en).length).toBeLessThanOrEqual(3);
		expect(violations(fr).length).toBeLessThanOrEqual(3);
		expect(parity.length).toBeLessThan(en.length * 0.05);
	});
});
