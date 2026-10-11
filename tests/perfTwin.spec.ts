/* A twin on the performance page's runway recipe (flightprep/runwayPerf.ts):
 * its accelerate-stop distance computed per take-off column and read, with
 * the margin, within the ASDA by every take-off block's verdict, so the
 * automatic runway end follows it; its one-engine climb judged against
 * CAT.POL.A.340 at each column (the take-off's two legs, the landing's
 * one), a hot day failing it; and a single getting neither. */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Airport } from '$lib/data/airports';
import { parseAircraftYaml } from '$lib/aircraft/schema';
import { memoryStorage } from './helpers/storage';

const M = 1 / 0.3048;

/** A paved 09/27 at 200 ft: 800 m of TORA, TODA and LDA both ways, the
 *  ASDA 700 m on 09 and 900 m on 27. */
const LFXX = {
	ident: 'LFXX',
	type: 'small_airport',
	name: 'TWIN TEST',
	lat: 47,
	lon: 3,
	elevFt: 200,
	runways: [
		{
			le: '09',
			he: '27',
			lengthFt: 900 * M,
			widthFt: 98,
			surface: 'ASPH',
			lit: false,
			leToraFt: 800 * M,
			leTodaFt: 800 * M,
			leAsdaFt: 700 * M,
			leLdaFt: 800 * M,
			heToraFt: 800 * M,
			heTodaFt: 800 * M,
			heAsdaFt: 900 * M,
			heLdaFt: 800 * M,
			leLighting: null,
			heLighting: null,
			lePos: null,
			hePos: null,
		},
	],
	radios: [],
	source: 'fr',
} as unknown as Airport;

vi.mock('$lib/state/data.svelte', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/state/data.svelte')>();
	return { ...real, airportByIdent: (i: string) => (i.toUpperCase() === 'LFXX' ? LFXX : null) };
});
vi.stubGlobal('localStorage', memoryStorage());

const fp = await import('$lib/state/flightPrep.svelte');
const rp = await import('$lib/components/flightprep/runwayPerf');

const seneca = parseAircraftYaml(readFileSync('public/data/aircraft/generic/pa34-200.yaml', 'utf-8'));
const single = parseAircraftYaml(readFileSync('public/data/aircraft/generic/pa28-181-archer2.yaml', 'utf-8'));
const NOW = Date.now();
const ctx = (a = seneca, massKg = 1905) => ({
	perf: a.performance ?? null,
	oei: a.oneEngineInoperative ?? null,
	massKg,
	nowMs: NOW,
	wmmYear: 2026.75,
	atMs: null,
});

describe('a twin on the runway recipe', () => {
	it('reads its accelerate-stop distance, with the margin, within the ASDA', () => {
		fp.setPerfBlock('LFXX', 'takeoff', { tempC: 15, qnhHpa: 1013, runwayEnd: '09' });
		const col = rp.perfColumn('LFXX', 'takeoff', ctx());
		expect(col.end?.id).toBe('09');
		expect(col.asd?.ok).toBe(true);
		const asd = col.asd?.ok ? col.asd.figure : null;
		// About 2000 ft at 4200 lb, sea level, standard (8-6): x1.3 is past
		// 09's 700 m, short of 27's 900.
		expect(asd!.requiredM).toBeGreaterThan(700);
		expect(asd!.requiredM).toBeLessThan(900);
		const v = col.rows[0].verdict!;
		expect(v.sufficient).toBe(false);
		expect(v.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(['asd-asda']);
	});

	it('takes the end whose ASDA holds it when the end is automatic', () => {
		fp.setPerfBlock('LFXX', 'takeoff', { tempC: 15, qnhHpa: 1013, runwayEnd: null });
		const col = rp.perfColumn('LFXX', 'takeoff', ctx());
		expect(col.end?.id).toBe('27');
		expect(col.rows[0].verdict?.sufficient).toBe(true);
	});

	it('judges its one-engine climb against CAT.POL.A.340, a hot day failing it', () => {
		fp.setPerfBlock('LFXX', 'takeoff', { tempC: 15, qnhHpa: 1013, runwayEnd: null });
		fp.setPerfBlock('LFXX', 'landing', { tempC: 15, qnhHpa: 1013 });
		const to = rp.perfColumn('LFXX', 'takeoff', ctx());
		expect(to.oei?.checks.map((c) => c.heightFt)).toEqual([400, 1500]);
		expect(to.oei?.sufficient).toBe(true);
		const ld = rp.perfColumn('LFXX', 'landing', ctx());
		expect(ld.oei?.checks.map((c) => c.heightFt)).toEqual([1500]);
		expect(ld.asd).toBeNull();
		fp.setPerfBlock('LFXX', 'takeoff', { tempC: 35 });
		const hot = rp.perfColumn('LFXX', 'takeoff', ctx());
		expect(hot.oei?.sufficient).toBe(false);
		expect(hot.oei?.checks.find((c) => c.heightFt === 1500)?.ok).toBe(false);
	});

	it('gives a single neither', () => {
		fp.setPerfBlock('LFXX', 'takeoff', { tempC: 15, qnhHpa: 1013, runwayEnd: null });
		const col = rp.perfColumn('LFXX', 'takeoff', ctx(single, 1150));
		expect(col.asd).toBeNull();
		expect(col.oei).toBeNull();
		expect(col.rows.length).toBeGreaterThan(0);
	});
});
