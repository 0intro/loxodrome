/* A performance weather field's grey placeholder is the value in force, so
 * typing the value it shows changes nothing, in that field or any other
 * (flightprep/runwayPerf.ts autoQnh / autoTempC / autoWind, which the page's
 * placeholders and the computation both read). Found on F-GIRV at Lognes on
 * 2026-10-03, LFPO reading 030/08 22/10 Q1028 (5 kt of headwind on 08,
 * 0 of tailwind): typing either figure changed the distances.
 *
 * - The tailwind's own 0, typed, made the PAIR explicit and the headwind
 *   calm, so the 5 kt headwind went and the automatic runway with it.
 * - The headwind's own 5, typed, was credited to EVERY runway end the
 *   automatic choice weighs, the reciprocals included: at 1150 kg the
 *   choice left paved 08 (short-field take-off) for grass 26L, a 5 kt
 *   tailwind there computed as a 5 kt headwind.
 * - The automatic temperature was computed unrounded and shown to the
 *   degree (ISA at 359 ft is 14.3), and so was a dossier QNH typed with a
 *   decimal. */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Airport } from '$lib/data/airports';
import type { PerfPhase } from '$lib/aircraft/performance';
import { memoryStorage } from './helpers/storage';

/** LFPL as fr-airports.json publishes it (AIRAC 2026-10-01): a grass
 *  08R/26L of 1100 m whose TODA and LDA differ by end, and a paved 08/26 of
 *  700 m. */
const LFPL = {
	ident: 'LFPL',
	type: 'small_airport',
	name: 'LOGNES EMERAINVILLE',
	lat: 48.82194,
	lon: 2.62278,
	elevFt: 359,
	runways: [
		{
			le: '08R',
			he: '26L',
			lengthFt: 3609,
			widthFt: 328,
			surface: 'GRASS',
			lit: false,
			leLdaFt: 3150,
			leToraFt: 3609,
			leTodaFt: 3018,
			leAsdaFt: 3609,
			heLdaFt: 3018,
			heToraFt: 3609,
			heTodaFt: 3150,
			heAsdaFt: 3609,
			leLighting: null,
			heLighting: null,
			lePos: null,
			hePos: null,
		},
		{
			le: '08',
			he: '26',
			lengthFt: 2297,
			widthFt: 66,
			surface: 'ASPH',
			lit: false,
			leLdaFt: 2297,
			leToraFt: 2297,
			leTodaFt: 2297,
			leAsdaFt: 2297,
			heLdaFt: 2297,
			heToraFt: 2297,
			heTodaFt: 2297,
			heAsdaFt: 2297,
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
	return { ...real, airportByIdent: (i: string) => (i.toUpperCase() === 'LFPL' ? LFPL : null) };
});
vi.stubGlobal('localStorage', memoryStorage());

const { parseAircraftYaml } = await import('$lib/aircraft/schema');
const { weatherState } = await import('$lib/state/weather.svelte');
const { setLiveWeather } = await import('$lib/state/display.svelte');
const fp = await import('$lib/state/flightPrep.svelte');
const rp = await import('$lib/components/flightprep/runwayPerf');

const girv = parseAircraftYaml(readFileSync('public/data/aircraft/f-girv.yaml', 'utf8')).performance!;
const PHASES: PerfPhase[] = ['takeoff', 'landing'];
const MASSES = [1000, 1100, 1150, 1157];

/** LFPL's nearest station, 21 km away, observed ten minutes ago. */
function observe(m: { wdir: number; wspd: number; temp: number; altim: number }): void {
	const now = Date.now();
	weatherState.nearest.LFPL = {
		status: 'ok',
		metar: {
			icaoId: 'LFPO',
			obsTime: Math.floor(now / 1000) - 600,
			...m,
			rawOb: 'METAR LFPO',
			lat: 48.7233,
			lon: 2.3794,
		},
		distanceM: 21_000,
		fetchedAt: now,
	} as never;
}

const ctx = (massKg: number) => ({ perf: girv, massKg, nowMs: Date.now(), wmmYear: 2026.75 });

/** What the grid shows: the end, the conditions, every row's figures. */
function computed(phase: PerfPhase, massKg: number) {
	const col = rp.perfColumn('LFPL', phase, ctx(massKg));
	return {
		end: col.end?.key,
		conditions: rp.conditionsForEnd('LFPL', phase, col.end, ctx(massKg)),
		rows: col.rows.map((r) => ({ flapsDeg: r.flapsDeg, result: r.result, verdict: r.verdict })),
		pick: col.pick?.status === 'fits' ? col.pick.row.procedure : col.pick?.status,
	};
}

function autos(phase: PerfPhase, massKg = 1100) {
	return rp.perfColumn('LFPL', phase, ctx(massKg)).autos;
}

beforeEach(() => {
	setLiveWeather(true);
	fp.setDossier({ qnhHpa: null });
	for (const phase of PHASES) {
		fp.setPerfBlock('LFPL', phase, { qnhHpa: null, tempC: null, headwindKt: null, tailwindKt: null, runwayEnd: null, wet: false });
	}
	// LFPO on 2026-10-03 at 13:30Z.
	observe({ wdir: 30, wspd: 8, temp: 22, altim: 1028 });
});

describe('typing the value a field shows', () => {
	it('shows 5 kt of headwind and 0 of tailwind on 08, the case reported', () => {
		const a = autos('takeoff', 1150);
		expect(rp.perfColumn('LFPL', 'takeoff', ctx(1150)).end?.key).toBe('08');
		expect(a.headwindKt).toEqual({ value: 5, source: 'metar' });
		expect(a.tailwindKt).toEqual({ value: 0, source: 'metar' });
	});

	for (const field of ['qnhHpa', 'tempC', 'headwindKt', 'tailwindKt'] as const) {
		it(`changes nothing for ${field}, in either phase, at any mass`, () => {
			for (const phase of PHASES) {
				for (const mass of MASSES) {
					const before = computed(phase, mass);
					const shown = autos(phase, mass)[field].value;
					fp.setPerfBlock('LFPL', phase, { [field]: shown });
					expect(computed(phase, mass), `${phase} ${mass} kg`).toEqual(before);
					fp.setPerfBlock('LFPL', phase, { qnhHpa: null, tempC: null, headwindKt: null, tailwindKt: null });
				}
			}
		});
	}

	it('changes nothing with all four typed at once', () => {
		for (const phase of PHASES) {
			for (const mass of MASSES) {
				const before = computed(phase, mass);
				const a = autos(phase, mass);
				fp.setPerfBlock('LFPL', phase, {
					qnhHpa: a.qnhHpa.value,
					tempC: a.tempC.value,
					headwindKt: a.headwindKt.value,
					tailwindKt: a.tailwindKt.value,
				});
				expect(computed(phase, mass), `${phase} ${mass} kg`).toEqual(before);
				fp.setPerfBlock('LFPL', phase, { qnhHpa: null, tempC: null, headwindKt: null, tailwindKt: null });
			}
		}
	});

	it('keeps the ISA temperature to the degree it shows, and computes with it', () => {
		setLiveWeather(false);
		// QNH standard: the pressure altitude is the elevation, 359 ft, where
		// ISA is 14.282 C.
		const a = autos('takeoff');
		expect(a.qnhHpa).toEqual({ value: 1013, source: 'standard' });
		expect(a.tempC).toEqual({ value: 14, source: 'isa' });
		expect(rp.conditionsForEnd('LFPL', 'takeoff', rp.perfColumn('LFPL', 'takeoff', ctx(1100)).end, ctx(1100))?.temperatureC).toBe(14);
	});

	it("keeps a METAR temperature's tenths out (AWC reads a US station's remarks)", () => {
		observe({ wdir: 30, wspd: 8, temp: 14.4, altim: 1028 });
		expect(autos('landing').tempC).toEqual({ value: 14, source: 'metar' });
		const before = computed('landing', 1100);
		expect(before.conditions?.temperatureC).toBe(14);
	});

	it('shows a dossier QNH as typed, decimals included', () => {
		setLiveWeather(false);
		fp.setDossier({ qnhHpa: 1013.5 });
		expect(autos('takeoff').qnhHpa).toEqual({ value: 1013.5, source: 'dossier' });
		const before = computed('takeoff', 1100);
		fp.setPerfBlock('LFPL', 'takeoff', { qnhHpa: 1013.5 });
		expect(computed('takeoff', 1100)).toEqual(before);
	});
});

describe('a typed wind never moves the automatic runway', () => {
	it('keeps paved 08 at 1150 kg whatever wind is typed', () => {
		const base = computed('takeoff', 1150);
		expect(base.end).toBe('08');
		expect(base.pick).toBe('short-field');
		for (const typed of [{ headwindKt: 5 }, { headwindKt: 15 }, { tailwindKt: 10 }, { headwindKt: 0, tailwindKt: 0 }]) {
			fp.setPerfBlock('LFPL', 'takeoff', { headwindKt: null, tailwindKt: null, ...typed });
			expect(computed('takeoff', 1150).end, JSON.stringify(typed)).toBe('08');
		}
	});

	it('weighs 26L with the tailwind observed there, never the headwind typed on 08', () => {
		// The reciprocal really has 5 kt behind it: with that, the normal
		// take-off does not fit on 26L's 960 m of TODA at 1150 kg.
		fp.setPerfBlock('LFPL', 'takeoff', { runwayEnd: '26L' });
		const on26L = computed('takeoff', 1150);
		expect(on26L.conditions?.headwindKt).toBe(-5);
		expect(on26L.pick).toBe('short-field');
	});
});

describe('the two wind components', () => {
	it('lets a typed tailwind cancel the observed headwind', () => {
		fp.setPerfBlock('LFPL', 'takeoff', { tailwindKt: 3 });
		const a = autos('takeoff');
		expect(a.headwindKt).toEqual({ value: 0, source: 'cancelled' });
		expect(computed('takeoff', 1100).conditions?.headwindKt).toBe(-3);
	});

	it('lets a typed headwind cancel the observed tailwind', () => {
		fp.setPerfBlock('LFPL', 'landing', { runwayEnd: '26' });
		expect(autos('landing').tailwindKt).toEqual({ value: 5, source: 'metar' });
		fp.setPerfBlock('LFPL', 'landing', { headwindKt: 4 });
		expect(autos('landing').tailwindKt).toEqual({ value: 0, source: 'cancelled' });
		expect(computed('landing', 1100).conditions?.headwindKt).toBe(4);
	});

	it('keeps the observed tailwind under a typed 0 of headwind, the safe side', () => {
		fp.setPerfBlock('LFPL', 'landing', { runwayEnd: '26', headwindKt: 0 });
		expect(autos('landing').tailwindKt).toEqual({ value: 5, source: 'metar' });
		expect(computed('landing', 1100).conditions?.headwindKt).toBe(-5);
	});

	it('computes calm air from a 0 typed in both', () => {
		fp.setPerfBlock('LFPL', 'takeoff', { headwindKt: 0, tailwindKt: 0 });
		expect(computed('takeoff', 1100).conditions?.headwindKt).toBe(0);
	});

	it('assumes calm without an observation', () => {
		setLiveWeather(false);
		const a = autos('takeoff');
		expect(a.headwindKt).toEqual({ value: 0, source: 'calm' });
		expect(a.tailwindKt).toEqual({ value: 0, source: 'calm' });
	});
});

describe('the page', () => {
	const page = readFileSync('src/lib/components/flightprep/PerformancePage.svelte', 'utf8');

	it("shows the computation's own automatic values, never a copy of its rules", () => {
		expect(page).toContain('= col.autos;');
		for (const field of ['qnh', 'temp', 'headwind', 'tailwind']) {
			expect(page).toMatch(new RegExp(`const ${field}: WeatherField = \\{\\s*override: [^,]+,\\s*auto: \\w+\\.value,`));
		}
		expect(page).not.toMatch(/Math\.round\(m[qt] \?\?/);
		expect(page).not.toContain('headExplicit');
	});
});
