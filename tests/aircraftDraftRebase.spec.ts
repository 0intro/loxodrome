/* The open editor's draft carried over onto its sheet as stored meanwhile
 * (rebaseDraft, $lib/aircraft/edit.ts). The editor stays up beside the
 * Aircraft tab, so its sheet can change elsewhere while it is open: the card's
 * inline basics, a revert, an import, a sync. Before, the draft kept the
 * figures it was seeded with, and the next Save wrote them back over the
 * change. Now every part the pilot has not changed in the editor takes the new
 * value, every part they changed keeps theirs, and a part changed on both
 * sides says so. Drafts come from the real seeding, aircraftToDraft. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { aircraftToDraft, rebaseDraft, type AircraftDraft, type TablePerformanceDraft } from '$lib/aircraft/edit';
import { parseAircraftYaml } from '$lib/aircraft/schema';

const SHEET = `version: 1
aircraft: { registration: F-GORQ, type: DR400/120, name: Robin DR400/120 }
fuel: { capacityL: 110, usableL: 109, consumptionLph: 25, type: 100LL, types: [100LL] }
cruise: { speedKt: 100 }
climb: { speedKt: 76, rateFtMin: 590 }
`;

const draftOf = (yaml: string): AircraftDraft => aircraftToDraft(parseAircraftYaml(yaml));
const base = draftOf(SHEET);
const clone = (d: AircraftDraft): AircraftDraft => JSON.parse(JSON.stringify(d)) as AircraftDraft;

describe('a change made elsewhere reaches the open draft', () => {
	it('is taken whole by an untouched draft', () => {
		const next = draftOf(SHEET.replace('speedKt: 100', 'speedKt: 105'));
		const { draft, conflict } = rebaseDraft(clone(base), base, next);
		expect(draft).toEqual(next);
		expect(conflict).toBe(false);
	});

	it('lands beside the pilot’s own edits, which stay', () => {
		const current = clone(base);
		current.climb!.rateFtMin = '600';
		const next = draftOf(SHEET.replace('speedKt: 100', 'speedKt: 105'));
		const { draft, conflict } = rebaseDraft(current, base, next);
		expect(draft.cruise!.speedKt).toBe('105');
		expect(draft.climb!.rateFtMin).toBe('600');
		expect(conflict).toBe(false);
		// Measured against the new base, only the pilot's edit is left unsaved.
		expect(JSON.stringify({ ...draft, climb: { ...draft.climb!, rateFtMin: '590' } })).toBe(JSON.stringify(next));
	});

	it('keeps the pilot’s value where both changed the same field, and says so', () => {
		const current = clone(base);
		current.cruise!.speedKt = '102';
		const next = draftOf(SHEET.replace('speedKt: 100', 'speedKt: 105'));
		const { draft, conflict } = rebaseDraft(current, base, next);
		expect(draft.cruise!.speedKt).toBe('102');
		expect(conflict).toBe(true);
	});

	it('agrees without a conflict where both made the same change', () => {
		const current = clone(base);
		current.cruise!.speedKt = '105';
		const next = draftOf(SHEET.replace('speedKt: 100', 'speedKt: 105'));
		expect(rebaseDraft(current, base, next).conflict).toBe(false);
	});

	it('takes a section added or dropped elsewhere, and keeps one the pilot dropped', () => {
		const added = draftOf(`${SHEET}descent: { speedKt: 90, rateFtMin: 500 }\n`);
		expect(rebaseDraft(clone(base), base, added).draft.descent).toEqual({ speedKt: '90', rateFtMin: '500' });

		const current = clone(base);
		current.climb = null;
		const next = draftOf(SHEET.replace('speedKt: 100', 'speedKt: 105'));
		const { draft } = rebaseDraft(current, base, next);
		expect(draft.climb).toBeNull();
		expect(draft.cruise!.speedKt).toBe('105');
	});

	it('takes a list as one part: the pilot’s stays whole when theirs differs', () => {
		const withSettings = (s: string): AircraftDraft =>
			draftOf(SHEET.replace('cruise: { speedKt: 100 }', `cruise: { speedKt: 100, settings: [${s}] }`));
		const listBase = withSettings('{ name: 65 %, speedKt: 95, consumptionLph: 21 }');
		const current = clone(listBase);
		current.cruise!.settings[0].speedKt = '96';
		const next = withSettings('{ name: 65 %, speedKt: 95, consumptionLph: 22 }');
		const { draft, conflict } = rebaseDraft(current, listBase, next);
		expect(draft.cruise!.settings).toEqual(current.cruise!.settings);
		expect(conflict).toBe(true);
	});

	it('keeps every key in the order the seeding writes it, so an untouched draft reads as clean', () => {
		const current = clone(base);
		current.name = 'Robin';
		const next = draftOf(SHEET.replace('speedKt: 100', 'speedKt: 105'));
		const { draft } = rebaseDraft(current, base, next);
		expect(Object.keys(draft)).toEqual(Object.keys(next));
		expect(Object.keys(draft.cruise!)).toEqual(Object.keys(next.cruise!));
	});
});

/* A POH grid is three parts read together, its altitudes, its columns and
 * the cells under them, and a table's masses are what its cells are read
 * at. Merged key by key, a column taken out elsewhere left the pilot's
 * three-wide cells under two columns (the ISA column reading the ISA-20
 * figures), and a column added left a cell missing, which the grid editor
 * dereferenced. Changed on both sides, the grid is one part: the pilot's,
 * whole. */
describe('a POH grid changed on both sides', () => {
	const gorq = aircraftToDraft(
		parseAircraftYaml(readFileSync(new URL('../public/data/aircraft/f-gorq.yaml', import.meta.url), 'utf-8')),
	);
	const table = (d: AircraftDraft): TablePerformanceDraft => d.performance as TablePerformanceDraft;
	/** The pilot's draft: one take-off cell retyped. */
	const edited = (): AircraftDraft => {
		const d = clone(gorq);
		table(d).takeoff.cells[0][1].massMaxRoll = '999';
		return d;
	};
	const rectangular = (d: AircraftDraft): boolean =>
		table(d).takeoff.cells.every((row) => row.length === table(d).takeoff.temperaturesC.length) &&
		table(d).takeoff.cells.length === table(d).takeoff.altitudesFt.length;

	it('keeps the pilot\'s grid whole where a column was taken out elsewhere', () => {
		const next = clone(gorq);
		table(next).takeoff.temperaturesC.splice(0, 1);
		table(next).takeoff.cells.forEach((row) => row.splice(0, 1));
		const { draft, conflict } = rebaseDraft(edited(), gorq, next);
		expect(rectangular(draft)).toBe(true);
		expect(table(draft).takeoff).toEqual(table(edited()).takeoff);
		expect(conflict).toBe(true);
	});

	it('and where a column was added elsewhere', () => {
		const next = clone(gorq);
		table(next).takeoff.temperaturesC.push('40');
		table(next).takeoff.cells.forEach((row) => row.push({ ...row[0] }));
		const { draft, conflict } = rebaseDraft(edited(), gorq, next);
		expect(rectangular(draft)).toBe(true);
		expect(table(draft).takeoff.cells[0][1].massMaxRoll).toBe('999');
		expect(conflict).toBe(true);
	});

	it('keeps the masses the pilot\'s cells are read at', () => {
		const next = clone(gorq);
		table(next).massMaxKg = '850';
		const { draft, conflict } = rebaseDraft(edited(), gorq, next);
		expect(table(draft).massMaxKg).toBe(table(gorq).massMaxKg);
		expect(conflict).toBe(true);
	});

	it('still merges a grid the pilot left alone, and one changed on this side only', () => {
		const next = clone(gorq);
		table(next).landing.cells[0][0].massMinRoll = '111';
		const { draft, conflict } = rebaseDraft(edited(), gorq, next);
		expect(table(draft).landing.cells[0][0].massMinRoll).toBe('111');
		expect(table(draft).takeoff.cells[0][1].massMaxRoll).toBe('999');
		expect(conflict).toBe(false);
	});
});
