/* Geometry audit over the France corpora: the parser's shape decisions
 * judged against the texts' own geometry grammar, plus the structural
 * invariants the emitter promises. Complements classifyAudit.spec.ts (the
 * pictogram side) and parser.spec.ts (per-case pins): this file sweeps whole
 * corpora and pins the residue by id, so a parser change that silently
 * degrades a shape class fails here with the ids in hand.
 *
 * With AUDIT_DIR set (a directory of SOFIA narrow-route responses,
 * sweep-*.json), the same audit also compares the FR and EN parses of every
 * aligned pair: the two languages carry the same coordinate blocks, so
 * their GEOMETRY should agree even where wording differs. */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseFranceByFir } from './worldFixtures';
import { parseNotams } from '$lib/notam';
import type { Notam } from '$lib/notam/types';
import { radiusToNM } from '$lib/notam/radius';
import {
	parseSofiaResponse,
	sofiaNotamKey,
	sofiaNotamToIcaoText,
} from '$lib/sofia/client';

const FIXTURES = [
	'world-en-20260610.txt',
	'world-fr-20260610.txt',
	'World-20260207.txt',
	'World-20260512.txt',
];

function eText(n: Notam): string {
	const m = n.fullContent.match(/(?:^|\n)E\)\s*([^]*?)(?=\nF\)|\nG\)|$)/);
	return (m ? m[1] : n.fullContent).toUpperCase();
}

function entriesById(notams: Notam[]): Map<string, Notam[]> {
	const m = new Map<string, Notam[]>();
	for (const n of notams) {
		const list = m.get(n.id);
		if (list) {
			list.push(n);
		} else {
			m.set(n.id, [n]);
		}
	}
	return m;
}

describe('parser geometry invariants over the France corpora', () => {
	it.each(FIXTURES)('%s', (fixture) => {
		const entries = parseFranceByFir(fixture);
		const groups = entriesById(entries);
		const bad: string[] = [];
		for (const n of entries) {
			if (n.isPolygon && n.coordinates.length < 3) {
				bad.push(`${n.id} polygon with ${n.coordinates.length} coords`);
			}
			for (const c of n.coordinates) {
				if ((c.radius != null) !== (c.radiusUnit != null)) {
					bad.push(`${n.id} radius/unit mismatch`);
				}
				if (c.type === 'qualifierLine') {
					if (n.coordinates.length !== 1) {
						bad.push(`${n.id} qualifierLine among ${n.coordinates.length} coords`);
					}
					if ((groups.get(n.id) ?? []).length !== 1) {
						bad.push(`${n.id} qualifierLine beside sibling entries`);
					}
					if (c.radius != null && c.radiusUnit !== 'NM') {
						bad.push(`${n.id} qualifierLine radius in ${c.radiusUnit}`);
					}
				}
			}
			if (n.coordinates.some((c) => c.original === 'corridor')) {
				if (n.coordinates.length !== 4 || !n.isPolygon || n.obstacleType !== 'voltige') {
					bad.push(`${n.id} malformed corridor`);
				}
			}
			// A surviving arcRadius means an arc centre that never expanded:
			// expandArcs runs only on polygons, and replaces the centre with
			// samples there, so any survivor is an un-drawn arc.
			if (n.coordinates.some((c) => c.arcRadius != null)) {
				bad.push(`${n.id} unexpanded arc`);
			}
		}
		expect([...new Set(bad)].sort()).toEqual([]);
	});
});

/* Text-vs-parse consistency: when the E) text states a shape in one of the
 * corpus grammars, the parse must carry it. Checked per source id over all
 * its entries. */
describe('text-vs-parse geometry consistency (France)', () => {
	const CIRCLE_RE =
		/CERCLE\s+DE\s+(?:RAYON\s+)?(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\b|CIRCLE\s+OF\s+(?:A\s+)?(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\s+RADIUS|(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\s+RADIUS\s+CIRCLE|DANS\s+UN\s+RAYON\s+DE\s+(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\b/;
	const COORD_RE = /\d{4,7}(?:[.,]\d+)?\s*[NS](?:\s+|\s*[,-]\s*)?\d{5,8}(?:[.,]\d+)?\s*[EW]/g;
	const AREA_RE = /LATERAL\s+LIMITS?|LIMITES?\s+LATERALES?/;
	const ARC_RE = /ARC\s+HORAIRE|CLOCKWISE\s+ARC/;

	function circleViolations(fixture: string): string[] {
		const out: string[] = [];
		for (const [id, entries] of entriesById(parseFranceByFir(fixture))) {
			// A radius phrase with no E) coordinate at all ("CONTACT EVX APP
			// ... DANS UN RAYON DE 25NM/FL100 ARP LFOE") has nothing to
			// anchor a circle to; the Q-line fallback carries the position.
			if (
				!entries.some((n) => n.coordinates.some((c) => c.type === 'psn'))
			) {
				continue;
			}
			const text = eText(entries[0]);
			const m = text.match(CIRCLE_RE);
			if (!m) {
				continue;
			}
			const val = parseFloat(
				(m[1] ?? m[3] ?? m[5] ?? m[7] ?? '').replace(',', '.'),
			);
			const unit = (m[2] ?? m[4] ?? m[6] ?? m[8] ?? 'NM') as 'NM' | 'KM' | 'M';
			const wantNM = radiusToNM(val, unit);
			const found = entries.some((n) =>
				n.coordinates.some(
					(c) =>
						c.radius != null &&
						c.radiusUnit != null &&
						Math.abs(radiusToNM(c.radius, c.radiusUnit) - wantNM) < 1e-6,
				),
			);
			if (!found) {
				out.push(`${id} circle ${val}${unit} not parsed`);
			}
		}
		return out.sort();
	}

	function polygonViolations(fixture: string): string[] {
		const out: string[] = [];
		for (const [id, entries] of entriesById(parseFranceByFir(fixture))) {
			const text = eText(entries[0]);
			if (!AREA_RE.test(text)) {
				continue;
			}
			const coordCount = (text.match(COORD_RE) ?? []).length;
			if (coordCount >= 3 && !entries.some((n) => n.isPolygon)) {
				out.push(`${id} lateral-limits list of ${coordCount} not a polygon`);
			}
			// The SAME-AS zone references carry the header but no coordinates:
			// they must fall back to the Q-line circle.
			if (
				coordCount === 0 &&
				!entries.some((n) =>
					n.coordinates.some((c) => c.type === 'qualifierLine'),
				)
			) {
				out.push(`${id} coordinate-free zone without Q-line fallback`);
			}
		}
		return out.sort();
	}

	function arcViolations(fixture: string): string[] {
		const out: string[] = [];
		for (const [id, entries] of entriesById(parseFranceByFir(fixture))) {
			if (!ARC_RE.test(eText(entries[0]))) {
				continue;
			}
			const drawn = entries.some((n) =>
				n.coordinates.some((c) => c.original === 'arc'),
			);
			if (!drawn) {
				out.push(`${id} clockwise arc not expanded`);
			}
		}
		return out.sort();
	}

	it.each(FIXTURES)('circles state their parsed radius: %s', (fixture) => {
		expect(circleViolations(fixture)).toEqual([]);
	});

	it.each(FIXTURES)('lateral-limit lists become polygons: %s', (fixture) => {
		expect(polygonViolations(fixture)).toEqual([]);
	});

	it.each(FIXTURES)('clockwise arcs expand: %s', (fixture) => {
		expect(arcViolations(fixture)).toEqual([]);
	});
});

/* The fresh-sweep parity block: the FR and EN texts of one NOTAM carry the
 * same coordinate blocks, so the parsed geometry should agree; wording-driven
 * divergence (the P1226/26-class AREA-keyword asymmetry) is the residue. */
describe.runIf(process.env.AUDIT_DIR)('fresh SOFIA sweep geometry parity', () => {
	function sweepEntries(lang: 'en' | 'fr'): Notam[] {
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
		return parseNotams(text).filter((n) =>
			(n.qualifier?.fir ?? '').startsWith('LF'),
		);
	}

	function geomSig(entries: Notam[]): string {
		return entries
			.map((n) => {
				const coords = n.coordinates
					.map(
						(c) =>
							`${c.lat.toFixed(4)},${c.lon.toFixed(4)}` +
							(c.radius != null ? `r${c.radius}${c.radiusUnit}` : ''),
					)
					.join(' ');
				return `${n.isPolygon ? 'A' : 'P'}${n.coordinates.length}[${coords}]`;
			})
			.join(';');
	}

	it('parses the same geometry from both languages', () => {
		const en = entriesById(sweepEntries('en'));
		const fr = entriesById(sweepEntries('fr'));
		const mismatches: string[] = [];
		for (const [id, e] of en) {
			const f = fr.get(id);
			if (f && geomSig(e) !== geomSig(f)) {
				mismatches.push(id);
			}
		}
		mismatches.sort();
		console.log(`sweep geometry pairs: ${[...en.keys()].filter((id) => fr.has(id)).length}`);
		console.log('geometry mismatches:', mismatches);
		for (const id of mismatches.slice(0, 12)) {
			console.log(
				`  ${id} en=${geomSig(en.get(id)!)}\n  ${id} fr=${geomSig(fr.get(id)!)}`,
			);
		}
		// Some residue is wording-driven (AREA-keyword asymmetries); a real
		// parser regression blows the bound.
		expect(mismatches.length).toBeLessThan(en.size * 0.03);
	});
});
