/* The aircraft library's index, public/data/aircraft.meta.json, is the one
 * scripts/gen-aircraft-meta.js writes from the sheets. Kept by hand it
 * drifted: its date stood two days behind the library's last change in the
 * About panel, and its counts kept the order they were typed in, which is
 * the order About prints. The generator sorts every list, keeps the two
 * `source` texts as written, moves `generatedAt` when and only when the
 * sheets' VALUES change (`digest`), and refuses a sheet out of its place;
 * the sheets' figures are the schema's, which tests/aircraftData.spec.ts
 * reads. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAircraftYaml, stringifyAircraftYaml } from '$lib/aircraft/schema';
import { buildMeta, promotionTarget, readSheets, renderMeta, type Sheet } from '../scripts/gen-aircraft-meta.js';

const META = new URL('../public/data/aircraft.meta.json', import.meta.url);

const sheet = (path: string, text: string): Sheet => ({ path, text });
const club = (reg: string, type = 'DR400/120', more = ''): string =>
	`version: 1\naircraft: { registration: ${reg}, type: ${type} }\n${more}`;
const generic = (id: string, type: string): string => `version: 1\naircraft: { type: ${type}, generic: ${id} }\n`;

describe('the committed index', () => {
	it('is the one the sheets make', () => {
		const committed = readFileSync(META, 'utf8');
		const previous = JSON.parse(committed) as Parameters<typeof buildMeta>[1];
		const made = renderMeta(buildMeta(readSheets(), previous, previous?.generatedAt ?? 0));
		expect(made, 'run npm run gen:aircraft-meta').toBe(committed);
	});
});

describe('the index the sheets make', () => {
	const library = [
		sheet('f-hpcp.yaml', club('F-HPCP', 'SR22')),
		sheet('f-brue.yaml', club('F-BRUE', 'PA28R-200')),
		sheet('generic/dr400-120-sn2210.yaml', generic('dr400-120-sn2210', 'DR400/120')),
		sheet('f-gorq.yaml', club('F-GORQ', 'DR400/120')),
		sheet('generic/c152.yaml', generic('c152', 'C152')),
		sheet('f-gikp.yaml', club('F-GIKP', 'DR400/100')),
		sheet('generic/dr400-120-pre2210.yaml', generic('dr400-120-pre2210', 'DR400/120')),
		sheet('f-gjqk.yaml', club('F-GJQK', 'DR400/100')),
	];
	const prose = { source: 'Club workbook', generic: { source: 'Flight manuals', files: [], counts: {} } };

	it('lists every sheet in code-point order and counts each type in that order, the generic sheets apart', () => {
		const meta = buildMeta(library, prose, '2026-10-11T08:00:00Z');
		expect(meta.files).toEqual(['f-brue.yaml', 'f-gikp.yaml', 'f-gjqk.yaml', 'f-gorq.yaml', 'f-hpcp.yaml']);
		expect(meta.aircraftCount).toBe(5);
		// The order About prints them in.
		expect(Object.entries(meta.counts)).toEqual([
			['DR400/100', 2],
			['DR400/120', 1],
			['PA28R-200', 1],
			['SR22', 1],
		]);
		expect(meta.generic?.files).toEqual([
			'generic/c152.yaml',
			'generic/dr400-120-pre2210.yaml',
			'generic/dr400-120-sn2210.yaml',
		]);
		expect(Object.entries(meta.generic?.counts ?? {})).toEqual([
			['C152', 1],
			['DR400/120', 2],
		]);
		expect(meta.source).toBe('Club workbook');
		expect(meta.generic?.source).toBe('Flight manuals');
		expect(renderMeta(meta)).toBe(`${JSON.stringify(meta, null, 2)}\n`);
	});

	it('keeps its date while the sheets’ values stand, a comment or a key order changed included', () => {
		const first = buildMeta(library, prose, '2026-10-11T08:00:00.123Z');
		expect(first.generatedAt).toBe('2026-10-11T08:00:00Z');
		expect(renderMeta(buildMeta(library, first, '2026-12-01T00:00:00Z'))).toBe(renderMeta(first));
		const reworded = library.map((s) =>
			s.path === 'f-gorq.yaml'
				? sheet(s.path, '# Weighed in 2026.\nversion: 1\naircraft: { type: DR400/120, registration: F-GORQ }\n')
				: s,
		);
		expect(buildMeta(reworded, first, '2026-12-01T00:00:00Z').generatedAt).toBe(first.generatedAt);
	});

	it('moves its date when a figure changes, or a sheet comes or goes', () => {
		const first = buildMeta(library, prose, '2026-10-11T08:00:00Z');
		const refigured = library.map((s) =>
			s.path === 'f-gorq.yaml' ? sheet(s.path, club('F-GORQ', 'DR400/120', 'cruise: { speedKt: 105 }\n')) : s,
		);
		expect(buildMeta(refigured, first, '2026-12-01T00:00:00Z').generatedAt).toBe('2026-12-01T00:00:00Z');
		const fewer = buildMeta(library.slice(1), first, '2026-12-02T00:00:00Z');
		expect(fewer.generatedAt).toBe('2026-12-02T00:00:00Z');
		expect(fewer.files).not.toContain('f-hpcp.yaml');
	});

	it('leaves out a generic block with no sheet, and a source nobody wrote', () => {
		const meta = buildMeta([sheet('f-gorq.yaml', club('F-GORQ'))], null, '2026-10-11T08:00:00Z');
		expect(meta.generic).toBeUndefined();
		expect(Object.keys(meta)).toEqual(['generatedAt', 'digest', 'aircraftCount', 'files', 'counts']);
	});

	it('refuses a sheet out of its place, naming it', () => {
		const refused = (s: Sheet): string | null => {
			try {
				buildMeta([s], null, 0);
				return null;
			} catch (e) {
				return e instanceof Error ? e.message : String(e);
			}
		};
		expect(refused(sheet('f-gorq.yaml', generic('f-gorq', 'DR400/120')))).toMatch(/^f-gorq\.yaml: a generic sheet sits under generic\//);
		expect(refused(sheet('gorq.yaml', club('F-GORQ')))).toBe('gorq.yaml: a club sheet is named by its registration: f-gorq.yaml');
		expect(refused(sheet('F-GORQ.yaml', club('F-GORQ')))).toMatch(/named by its registration: f-gorq\.yaml$/);
		expect(refused(sheet('dr400.yaml', 'version: 1\naircraft: { type: DR400/120 }\n'))).toMatch(/states its aircraft's registration/);
		expect(refused(sheet('generic/c152.yaml', generic('c150', 'C152')))).toMatch(/states generic: c152, the name of its file/);
		expect(refused(sheet('generic/c152.yaml', 'version: 1\naircraft: { registration: F-TEST, type: C152, generic: c152 }\n'))).toMatch(
			/a generic sheet is a type, with no registration/,
		);
		expect(refused(sheet('f-gorq.yaml', 'version: 3\naircraft: { registration: F-GORQ, type: DR400 }\n'))).toMatch(/not an aircraft data sheet/);
		expect(refused(sheet('f-gorq.yaml', 'version: 1\naircraft: { registration: F-GORQ }\n'))).toMatch(/not an aircraft data sheet/);
		expect(refused(sheet('f-gorq.yaml', 'version: 1\naircraft: [\n'))).toMatch(/^f-gorq\.yaml: /);
	});
});

describe('the library directory', () => {
	it('is read whole: sheets at the top and in generic/, nothing else', () => {
		const dir = mkdtempSync(join(tmpdir(), 'aircraft-meta-'));
		try {
			mkdirSync(join(dir, 'generic'));
			writeFileSync(join(dir, 'f-gorq.yaml'), club('F-GORQ'));
			writeFileSync(join(dir, 'generic', 'c152.yaml'), generic('c152', 'C152'));
			expect(readSheets(dir).map((s) => s.path)).toEqual(['f-gorq.yaml', 'generic/c152.yaml']);
			writeFileSync(join(dir, 'notes.txt'), 'x');
			expect(() => readSheets(dir)).toThrow('notes.txt: not a .yaml data sheet');
			rmSync(join(dir, 'notes.txt'));
			mkdirSync(join(dir, 'old'));
			expect(() => readSheets(dir)).toThrow(/^old: a directory the library does not hold/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		expect(readSheets(join(dir, 'gone'))).toEqual([]);
	});
});

describe('a plane promoted into the library', () => {
	const exported = (yaml: string): string => stringifyAircraftYaml(parseAircraftYaml(yaml));

	it('is filed under its registration, as the Aircraft tab exported it', () => {
		const text = exported(club('F-TEST', 'DR400/120', 'cruise: { speedKt: 100 }\n'));
		expect(promotionTarget(text, 'f-test_aircraft.yaml')).toBe('f-test.yaml');
		const meta = buildMeta([sheet('f-test.yaml', text)], null, 0);
		expect(meta.files).toEqual(['f-test.yaml']);
	});

	it('is a club aircraft: a generic sheet or a plane without a registration is refused', () => {
		expect(() => promotionTarget(generic('c152', 'C152'), 'c152.yaml')).toThrow(/^c152\.yaml: a generic sheet is written by hand under generic\//);
		expect(() => promotionTarget(exported('version: 1\naircraft: { type: DR400/120 }\n'), 'dr400.yaml')).toThrow(
			'dr400.yaml: a club aircraft states its registration',
		);
	});
});
