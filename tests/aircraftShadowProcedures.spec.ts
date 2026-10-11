/* A pilot's copy of a library sheet inherits the library's take-off
 * procedure tags (state/aircraft.svelte.ts withLibraryProcedures).
 *
 * A cruise speed typed into F-GIEQ copies the WHOLE sheet into the user
 * store, so a copy saved before the procedures existed kept its untagged
 * charts for good, and the performance page could never name the
 * short-field take-off for it. The tags come across when every take-off
 * chart is the library's; a copy whose charts the pilot edited is theirs. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serve, serveCoverageSite, serveText } from './helpers/coverageSite';
import { memoryStorage } from './helpers/storage';
import type { ClosedFormPerformance } from '$lib/aircraft/schema';

const GIEQ = readFileSync('public/data/aircraft/f-gieq.yaml', 'utf8');
const GIRV = readFileSync('public/data/aircraft/f-girv.yaml', 'utf8');

/** The sheet as an older build stored it: no procedure, the short-field
 *  chart marked default, which drove the verdict then. */
function untagged(yaml: string): string {
	return yaml
		.replace(/\n {6}procedure: normal[^\n]*/, '')
		.replace(/procedure: short-field[^\n]*/, 'default: true');
}

let storage: Storage;

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	const gieqCopy = untagged(GIEQ).replace(/speedKt: \d+/, 'speedKt: 93');
	// Its take-off chart edited: the pilot's own, left alone.
	const girvCopy = untagged(GIRV).replace('coefficients: [0.000594, 9.285, 0.096, 488.5]', 'coefficients: [0.000594, 9.285, 0.096, 500]');
	storage = memoryStorage({
		'loxodrome:aircraft-user': JSON.stringify({ v: 1, planes: { 'F-GIEQ': gieqCopy, 'F-GIRV': girvCopy } }),
	});
	vi.stubGlobal('localStorage', storage);
	serveCoverageSite();
	serve('/data/aircraft.meta.json', {
		generatedAt: 'x',
		aircraftCount: 2,
		files: ['f-gieq.yaml', 'f-girv.yaml'],
		counts: {},
	});
	serveText('/data/aircraft/f-gieq.yaml', GIEQ);
	serveText('/data/aircraft/f-girv.yaml', GIRV);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const procedures = (p: unknown): unknown[] =>
	(p as ClosedFormPerformance).configs.filter((c) => c.phase === 'takeoff').map((c) => c.procedure);

describe("a pilot's copy saved before the take-off procedures", () => {
	it('takes the library tags when its charts are the library ones, and keeps its own speed', async () => {
		expect(untagged(GIEQ)).not.toContain('procedure:');
		const aircraft = await import('$lib/state/aircraft.svelte');
		const retry = await import('$lib/state/dataRetry.svelte');
		void aircraft.ensureAircraftLibrary();
		await vi.advanceTimersByTimeAsync(0);
		expect(aircraft.aircraftState.libraryLoaded).toBe(true);
		const gieq = aircraft.aircraftByKey('F-GIEQ');
		expect(procedures(gieq?.performance)).toEqual(['normal', 'short-field']);
		// Still the pilot's copy, speed and all.
		expect(aircraft.isShadowed('F-GIEQ')).toBe(true);
		expect(gieq?.cruise?.speedKt).toBe(93);
		// Persisted, so it syncs once.
		const stored = JSON.parse(storage.getItem('loxodrome:aircraft-user') ?? '{}') as { planes: Record<string, string> };
		expect(stored.planes['F-GIEQ']).toContain('procedure: short-field');
		retry.resetDataRetryForTest();
	});

	it('leaves a copy whose charts were edited untagged', async () => {
		const aircraft = await import('$lib/state/aircraft.svelte');
		const retry = await import('$lib/state/dataRetry.svelte');
		void aircraft.ensureAircraftLibrary();
		await vi.advanceTimersByTimeAsync(0);
		expect(procedures(aircraft.aircraftByKey('F-GIRV')?.performance)).toEqual([undefined, undefined]);
		retry.resetDataRetryForTest();
	});
});
