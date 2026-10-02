/* How a take-off pick reads, the same on the performance page, its print and
 * the Overview (flightprep/takeoffProcedureView.ts): the procedure in its ink,
 * on one line, or for the Overview's narrow cell the word over its flaps. And
 * the two qualifiers the Overview's title shares with the performance page's
 * weather strip (flightprep/runwayPerf.ts): an estimate only while live
 * weather is on and no observation answers, typed values read per phase. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TakeoffPick } from '$lib/aircraft/performance';
import type { TakeoffProcedure } from '$lib/aircraft/schema';
import type { PerfCtx, PerfRow } from '$lib/components/flightprep/runwayPerf';
import { flightprep as en } from '$lib/i18n/en/flightprep';
import { flightprep as fr } from '$lib/i18n/fr/flightprep';
import { memoryStorage } from './helpers/storage';

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** A row as the view reads it, its procedure and flaps: the figures and the
 *  verdict have already made the pick. */
function row(procedure: TakeoffProcedure | null, flapsDeg: number | null): PerfRow {
	return { config: null, procedure, flapsDeg, result: null, verdict: null } as unknown as PerfRow;
}

const fits = (r: PerfRow, rank: 0 | 1 = 0): TakeoffPick<PerfRow> => ({ status: 'fits', row: r, rank });

async function view(locale: 'en' | 'fr') {
	const { i18n } = await import('$lib/state/i18n.svelte');
	i18n.locale = locale;
	return import('$lib/components/flightprep/takeoffProcedureView');
}

describe('how a take-off pick reads', () => {
	it('names the normal procedure with its flaps, in the ok ink', async () => {
		const v = await view('en');
		const pick = fits(row('normal', 0));
		expect(v.procedureText(pick)).toBe(en.procNormal(0));
		expect(v.procedureLines(pick)).toEqual([en.procNormal(null), en.procFlapsOnly(0)]);
		expect(v.procedureInk(pick)).toBe('ok');
		expect(v.procedureTip(pick)).toBeUndefined();
	});

	it('names the short-field procedure in the accent, and says why', async () => {
		const v = await view('en');
		const pick = fits(row('short-field', 25), 1);
		expect(v.procedureText(pick)).toBe(en.procShortField(25));
		expect(v.procedureLines(pick)).toEqual([en.procShortField(null), en.procFlapsOnly(25)]);
		expect(v.procedureInk(pick)).toBe('proc-short');
		expect(v.procedureTip(pick)).toBe(en.procShortFieldTip(25));
	});

	it('reads a sheet naming no procedure by its charted flaps alone', async () => {
		const v = await view('en');
		const charted = fits(row(null, 25));
		expect(v.procedureText(charted)).toBe(en.procFlapsOnly(25));
		// The flaps ARE the word: one line, never the flaps repeated beneath.
		expect(v.procedureLines(charted)).toEqual([en.procFlapsOnly(25), '']);
		const bare = fits(row(null, null));
		expect(v.procedureText(bare)).toBe(en.procNormal(null));
		expect(v.procedureLines(bare)).toEqual([en.procNormal(null), '']);
	});

	it('reads none fitting in the danger ink, and nothing judged as the empty cell', async () => {
		const v = await view('en');
		const none: TakeoffPick<PerfRow> = { status: 'none' };
		expect(v.procedureText(none)).toBe(en.procNone);
		// The narrow cell's short word: the sentence broke inside a word there.
		expect(v.procedureLines(none)).toEqual([en.procNoneShort, '']);
		expect(v.procedureInk(none)).toBe('danger');
		expect(v.procedureTip(none)).toBeUndefined();
		for (const pick of [{ status: 'unknown' } as const, null]) {
			expect(v.procedureText(pick)).toBe('—');
			expect(v.procedureLines(pick)).toEqual(['—', '']);
			expect(v.procedureInk(pick)).toBe('');
			expect(v.procedureTip(pick)).toBeUndefined();
		}
	});

	it('reads the same in French', async () => {
		const v = await view('fr');
		expect(v.procedureText(fits(row('normal', 0)))).toBe(fr.procNormal(0));
		expect(v.procedureLines(fits(row('short-field', 25), 1))).toEqual([
			fr.procShortField(null),
			fr.procFlapsOnly(25),
		]);
		expect(v.procedureTip(fits(row('short-field', 25), 1))).toBe(fr.procShortFieldTip(25));
		expect(v.procedureLines({ status: 'none' })).toEqual([fr.procNoneShort, '']);
	});
});

describe("the qualifiers the Overview's title shares with the weather strip", () => {
	const ctx = (): PerfCtx => ({ perf: null, massKg: null, nowMs: Date.now(), wmmYear: 2026.75 });

	it('reads typed weather per phase, a QNH counting for both', async () => {
		const fp = await import('$lib/state/flightPrep.svelte');
		const { hasTypedWeather } = await import('$lib/components/flightprep/runwayPerf');
		expect(hasTypedWeather('LFPL')).toBe(false);
		fp.setPerfBlock('LFPL', 'landing', { tempC: 20 });
		expect(hasTypedWeather('LFPL')).toBe(true);
		expect(hasTypedWeather('LFPL', 'landing')).toBe(true);
		// A landing temperature says nothing about the take-off's figures.
		expect(hasTypedWeather('LFPL', 'takeoff')).toBe(false);
		fp.setPerfBlock('LFPL', 'takeoff', { headwindKt: 10 });
		expect(hasTypedWeather('LFPL', 'takeoff')).toBe(true);
		fp.setPerfQnh('LFBJ', 1002);
		expect(hasTypedWeather('LFBJ', 'takeoff')).toBe(true);
		expect(hasTypedWeather('LFBJ', 'landing')).toBe(true);
	});

	it('calls the automatic values an estimate only while live weather is on', async () => {
		const d = await import('$lib/state/display.svelte');
		const { weatherEstimated } = await import('$lib/components/flightprep/runwayPerf');
		d.setLiveWeather(true);
		// No observation for the field: the dossier QNH, ISA and calm air.
		expect(weatherEstimated('LFPL', ctx())).toBe(true);
		d.setLiveWeather(false);
		expect(weatherEstimated('LFPL', ctx())).toBe(false);
	});
});
