/* Every gap at once (aircraft/edit.ts draftGaps). The schema stops at its
 * first error, so a section built from scratch revealed its empty boxes one
 * at a time; the editor now counts them all, dots every page holding one and
 * marks each box (its `required`). The sweep restates the schema's rules
 * about single boxes, so it is held to the schema here: every box of every
 * library sheet is emptied, then given a non-number, one at a time, and the
 * two must agree: no gap where the schema takes the draft, and the box the
 * schema names first among the gaps where it does not. */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	aircraftToDraft,
	blankClosedFormPerformanceDraft,
	blankMassBalanceDraft,
	blankAccelerateStopDraft,
	blankOneEngineDraft,
	blankTablePerformanceDraft,
	draftGaps,
	draftToAircraft,
	duplicateDraft,
	type AircraftDraft,
} from '$lib/aircraft/edit';
import { parseAircraftYaml, type Aircraft } from '$lib/aircraft/schema';

function library(): [string, Aircraft][] {
	const out: [string, Aircraft][] = [];
	for (const dir of ['public/data/aircraft', 'public/data/aircraft/generic']) {
		for (const f of readdirSync(new URL(`../${dir}`, import.meta.url))) {
			if (f.endsWith('.yaml')) {
				out.push([f, parseAircraftYaml(readFileSync(new URL(`../${dir}/${f}`, import.meta.url), 'utf8'))]);
			}
		}
	}
	return out;
}

/** The draft's boxes: every string leaf a text or number box edits. A
 *  select's value, a list of grades and the generic flag are no box. */
function boxes(d: AircraftDraft): (string | number)[][] {
	const out: (string | number)[][] = [];
	const NOT_BOXES = new Set(['phase', 'procedure', 'takeoffProcedure', 'axis', 'generic', 'kind', 'types', 'engines']);
	const walk = (v: unknown, path: (string | number)[]): void => {
		if (typeof v === 'string') {
			const fuelGrade = path.length === 2 && path[0] === 'fuel' && path[1] === 'type';
			if (!fuelGrade) {
				out.push(path);
			}
		} else if (Array.isArray(v)) {
			v.forEach((x, i) => walk(x, [...path, i]));
		} else if (v !== null && typeof v === 'object') {
			for (const [k, x] of Object.entries(v)) {
				if (!NOT_BOXES.has(k)) {
					walk(x, [...path, k]);
				}
			}
		}
	};
	walk(d, []);
	return out;
}

function withBox(d: AircraftDraft, path: (string | number)[], value: string): AircraftDraft {
	const copy = JSON.parse(JSON.stringify(d)) as AircraftDraft;
	let at: Record<string | number, unknown> = copy as unknown as Record<string, unknown>;
	for (const k of path.slice(0, -1)) {
		at = at[k] as Record<string | number, unknown>;
	}
	at[path[path.length - 1]] = value;
	return copy;
}

const PREFIX = 'Invalid aircraft file: ';
const schemaPath = (message: string): string => message.slice(PREFIX.length).split(' ')[0];

/** The schema's rules spanning boxes, which draftGaps leaves to the schema's
 *  own message: the tanks holding the fuel section's litres. An optional box
 *  emptied (fuel.usableL, a tank's usableL) takes its capacity, which only
 *  that rule refuses, so the draft has no gap of its own. */
const SPANNING = [/^massAndBalance\.fuelTanks hold /];

/** The two agree on this draft. */
function agree(d: AircraftDraft, what: string, opts: { requireRegistration?: boolean } = {}): void {
	const gaps = draftGaps(d, opts).map((g) => g.path);
	const r = draftToAircraft(d, opts);
	if (r.ok) {
		expect(gaps, `${what}: gaps on a sheet the schema takes`).toEqual([]);
	} else if (SPANNING.some((re) => re.test(r.errors[0].slice(PREFIX.length)))) {
		expect(gaps, `${what}: "${r.errors[0]}" spans boxes, no single one a gap`).toEqual([]);
	} else {
		expect(gaps, `${what}: the schema's "${r.errors[0]}" among the gaps`).toContain(schemaPath(r.errors[0]));
	}
}

describe('every gap at once', () => {
	// The library (the generic PA-34-200 Seneca its twin) and the specs'
	// small twin fixture.
	const sheets: [string, Aircraft][] = [
		...library(),
		['aircraft-twin.yaml (fixture)', parseAircraftYaml(readFileSync(new URL('./fixtures/aircraft-twin.yaml', import.meta.url), 'utf8'))],
	];

	it('finds none on the library sheets', () => {
		for (const [file, a] of sheets) {
			expect(draftGaps(aircraftToDraft(a)), file).toEqual([]);
		}
	});

	it('agrees with the schema on every box of every library sheet, emptied or holding no number', () => {
		let checked = 0;
		for (const [file, a] of sheets) {
			const d = aircraftToDraft(a);
			for (const path of boxes(d)) {
				const original = path.reduce<unknown>((v, k) => (v as Record<string | number, unknown>)[k], d) as string;
				agree(withBox(d, path, ''), `${file} ${path.join('.')} emptied`);
				if (original.trim() !== '' && Number.isFinite(Number(original))) {
					agree(withBox(d, path, 'abc'), `${file} ${path.join('.')} = abc`);
				}
				checked++;
			}
		}
		// The library's boxes, every one of them: a walk that found few would
		// pass in silence.
		expect(checked).toBeGreaterThan(3000);
	});

	it('lists a fresh section’s every required box, each on its page', () => {
		const d = aircraftToDraft(parseAircraftYaml('version: 1\naircraft: { registration: F-TEST, type: DR400 }\n'));
		d.massBalance = blankMassBalanceDraft();
		d.performance = blankTablePerformanceDraft();
		const gaps = draftGaps(d);
		expect(gaps.filter((g) => g.page === 'mb').map((g) => g.path)).toEqual([
			'massAndBalance.envelope[0].armM',
			'massAndBalance.envelope[0].massKg',
			'massAndBalance.envelope[1].armM',
			'massAndBalance.envelope[1].massKg',
			'massAndBalance.envelope[2].armM',
			'massAndBalance.envelope[2].massKg',
			'massAndBalance.emptyMassKg',
			'massAndBalance.emptyArmM',
			'massAndBalance.fuelArmM',
		]);
		// Two masses, then per grid 2 altitudes, 2 columns and 2 x 2 cells of
		// four figures: 2 + 2 x (2 + 2 + 16).
		expect(gaps.filter((g) => g.page === 'perf')).toHaveLength(42);
		expect(gaps.every((g) => g.page !== 'general')).toBe(true);
		agree(d, 'a fresh table section');
		d.performance = blankClosedFormPerformanceDraft();
		agree(d, 'a fresh closed-form section');
		// The flaps, then per metric four coefficients and two wind rates, and
		// the reference mass.
		expect(draftGaps(d).filter((g) => g.page === 'perf')).toHaveLength(1 + 2 * 6 + 1);
	});

	it('lists a fresh one engine inoperative section’s every required box, on the performance page', () => {
		const d = aircraftToDraft(parseAircraftYaml('version: 1\naircraft: { registration: F-TEST, type: PA34-200, engines: 2 }\n'));
		d.oneEngine = blankOneEngineDraft();
		const gaps = draftGaps(d);
		// The two speeds, then the climb table's two masses, 2 altitudes, 2
		// columns and 2 x 2 cells of two figures.
		expect(gaps.map((g) => g.path)).toEqual([
			'oneEngineInoperative.vmcKt',
			'oneEngineInoperative.vyseKt',
			'oneEngineInoperative.climb.massMaxKg',
			'oneEngineInoperative.climb.massMinKg',
			'oneEngineInoperative.climb.rows[0].altFt',
			'oneEngineInoperative.climb.rows[2].altFt',
			'oneEngineInoperative.climb.rows[0].isaOffsetC',
			'oneEngineInoperative.climb.rows[1].isaOffsetC',
			'oneEngineInoperative.climb.rows[0].massMax',
			'oneEngineInoperative.climb.rows[0].massMin',
			'oneEngineInoperative.climb.rows[1].massMax',
			'oneEngineInoperative.climb.rows[1].massMin',
			'oneEngineInoperative.climb.rows[2].massMax',
			'oneEngineInoperative.climb.rows[2].massMin',
			'oneEngineInoperative.climb.rows[3].massMax',
			'oneEngineInoperative.climb.rows[3].massMin',
		]);
		expect(gaps.every((g) => g.page === 'perf')).toBe(true);
		agree(d, 'a fresh one engine inoperative section');
		// A single's draft holding one writes none, and asks nothing of it.
		expect(draftGaps({ ...d, engines: '1' })).toEqual([]);
		// A fresh accelerate-stop table: its masses, axes and cells.
		d.oneEngine = null;
		d.performance = { ...blankTablePerformanceDraft(), accelerateStop: blankAccelerateStopDraft() };
		expect(draftGaps(d).filter((g) => g.path.startsWith('performance.accelerateStop'))).toHaveLength(2 + 2 + 2 + 8);
	});

	it('asks a copy of a generic sheet for its registration and its weighing', () => {
		const generic = sheets.find(([f]) => f === 'c172s.yaml')![1];
		const d = duplicateDraft(generic);
		expect(draftGaps(d, { requireRegistration: true }).map((g) => g.path)).toEqual([
			'aircraft.registration',
			'massAndBalance.emptyMassKg',
			'massAndBalance.emptyArmM',
		]);
		agree(d, 'a generic copy', { requireRegistration: true });
	});
});
