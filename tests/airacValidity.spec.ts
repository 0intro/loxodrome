/* The shipped data's validity (src/lib/data/airacValidity.ts): the Play app
 * carries its datasets and says when they are past their cycle. */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
	AIRAC_CYCLE_MS,
	HOME_DATASETS,
	dataExpired,
	dataValidUntilMs,
	isHomeSidecar,
	newestEffectiveMs,
	shippedDataValidUntilMs,
	type ShippedSidecar,
} from '$lib/data/airacValidity';

const BUILD = Date.parse('2026-09-24T00:00:00Z');

const DATA_DIR = join(new URL('..', import.meta.url).pathname, 'public/data');

/** Every sidecar the tree ships, as vite.shared.ts reads them. */
function shippedSidecars(): ShippedSidecar[] {
	return readdirSync(DATA_DIR)
		.filter((file) => file.endsWith('.meta.json'))
		.map((file) => ({
			file,
			effective: (JSON.parse(readFileSync(join(DATA_DIR, file), 'utf-8')) as { effective?: unknown })
				.effective,
		}));
}

describe('newestEffectiveMs', () => {
	it('takes the latest date whatever its spelling', () => {
		expect(
			newestEffectiveMs(
				['2026-09-03T00:00:00.000+02:00', '2026-10-01T00:00:00.000Z', '2026-10-01'],
				BUILD,
			),
		).toBe(Date.parse('2026-10-01T00:00:00Z'));
	});

	it('skips blanks, nulls and garbage', () => {
		// ENAIRE stamps an empty effective; a publisher can omit it.
		expect(newestEffectiveMs(['', null, undefined, 'soon', '2026-09-03'], BUILD)).toBe(
			Date.parse('2026-09-03'),
		);
		expect(newestEffectiveMs(['', null], BUILD)).toBeNull();
	});

	it('ignores a date implausibly far after the build', () => {
		// A pre-release is a month ahead; a stamp a year out would make the
		// build look current for a year.
		expect(newestEffectiveMs(['2026-10-01', '2027-10-01'], BUILD)).toBe(
			Date.parse('2026-10-01'),
		);
	});

	it('lets an old publication date not hide a newer cycle', () => {
		// LVNL's aerodromes are dated 2022; the newest date is what counts.
		expect(newestEffectiveMs(['2022-05-19', '2026-10-01'], BUILD)).toBe(
			Date.parse('2026-10-01'),
		);
	});

	it('reads a stamp at local midnight as its calendar date, as the slot picker does', () => {
		// The SIA's own spelling: 22:00Z the eve of the cycle, which a plain
		// Date.parse took for the date and so ended the validity two hours
		// early.
		expect(newestEffectiveMs(['2026-10-01T00:00:00.000+02:00'], BUILD)).toBe(
			Date.parse('2026-10-01T00:00:00Z'),
		);
		expect(dataValidUntilMs(['2026-10-01T00:00:00.000+02:00'], BUILD)).toBe(
			Date.parse('2026-10-29T00:00:00Z'),
		);
	});
});

describe('dataValidUntilMs', () => {
	it('is one AIRAC cycle after the newest slot', () => {
		expect(dataValidUntilMs(['2026-09-03', '2026-10-01'], BUILD)).toBe(
			Date.parse('2026-10-29'),
		);
		expect(AIRAC_CYCLE_MS).toBe(28 * 86_400_000);
	});

	it('knows nothing without a date', () => {
		expect(dataValidUntilMs([], BUILD)).toBeNull();
	});

	it('never runs past the home State, whose data is built by hand', () => {
		// The others' pre-releases are in (a scheduled workflow builds them);
		// France's is not yet: the build is current until France's cycle ends.
		const home = ['2026-09-03T00:00:00.000+02:00', '2026-09-03'];
		expect(dataValidUntilMs([...home, '2026-10-01', '2022-05-19'], BUILD, home)).toBe(
			Date.parse('2026-10-01'),
		);
		// With France's pre-release built, the newest date governs again.
		const homeNext = [...home, '2026-10-01T00:00:00.000+02:00'];
		expect(dataValidUntilMs([...homeNext, '2026-10-01'], BUILD, homeNext)).toBe(
			Date.parse('2026-10-29'),
		);
		// A home State that states nothing caps nothing.
		expect(dataValidUntilMs(['2026-10-01'], BUILD, [''])).toBe(Date.parse('2026-10-29'));
	});
});

describe('the home State', () => {
	it('is the six datasets cmd/fr writes, current and pre-release alike', () => {
		const src = readFileSync(
			join(new URL('..', import.meta.url).pathname, 'cmd/fr/main.go'),
			'utf-8',
		);
		const written = [...src.matchAll(/WriteDataset\(\*outDir, "([^"]+)"/g)].map((m) => m[1]);
		expect([...written].sort()).toEqual([...HOME_DATASETS].sort());
		expect(isHomeSidecar('fr-airspaces.meta.json')).toBe(true);
		expect(isHomeSidecar('fr-airspaces.next.meta.json')).toBe(true);
		// The scraped French sets are refreshed by a workflow, like any
		// other publisher: fr-adcharts even builds its own pre-release.
		expect(isHomeSidecar('fr-adcharts.meta.json')).toBe(false);
		expect(isHomeSidecar('fr-supaip.meta.json')).toBe(false);
	});

	it('bounds the stamp of a tree whose French pre-release is not built yet', () => {
		// Today's tree less the fr-* pre-releases: what a release cut before
		// cmd/fr -target next would carry. Every other AIRAC publisher's
		// pre-release is in, so the newest date alone ran a cycle past France.
		const sidecars = shippedSidecars().filter(
			(s) => !(isHomeSidecar(s.file) && s.file.endsWith('.next.meta.json')),
		);
		const french = newestEffectiveMs(
			sidecars.filter((s) => isHomeSidecar(s.file)).map((s) => s.effective as string),
			BUILD,
		);
		expect(french).not.toBeNull();
		expect(shippedDataValidUntilMs(sidecars, BUILD)).toBe(french! + AIRAC_CYCLE_MS);
	});
});

describe('dataExpired', () => {
	const until = '2026-10-29T00:00:00.000Z';

	it('turns at the instant the cycle ends', () => {
		expect(dataExpired(until, Date.parse(until) - 1)).toBe(false);
		expect(dataExpired(until, Date.parse(until))).toBe(true);
	});

	it('never cries wolf over an unknown validity', () => {
		expect(dataExpired(null, Date.parse('2099-01-01'))).toBe(false);
		expect(dataExpired('not a date', Date.parse('2099-01-01'))).toBe(false);
	});
});

describe('the expiry flag', () => {
	it('is re-judged on the minute tick', () => {
		// dataState.dataExpired is what AiracBanner reads, and nothing else
		// sets it: a session left open across the stamp must turn it on
		// without a reload. Module effects do not run under this test runner,
		// so the wiring is pinned in the source: the tick's effect root reads
		// notamState.tick and judges the build stamp against the current time.
		const src = readFileSync(
			join(new URL('..', import.meta.url).pathname, 'src/lib/state/data.svelte.ts'),
			'utf-8',
		);
		const root = src.slice(src.indexOf('$effect.root(() => {'));
		const body = root.slice(0, root.indexOf('\n});') + 4);
		expect(body).toContain('void notamState.tick;');
		expect(body).toMatch(
			/dataState\.dataExpired = dataExpired\(__DATA_VALID_UNTIL__, now\.getTime\(\)\);/,
		);
	});
});

describe('the build stamp', () => {
	it('is what the shipped sidecars say', () => {
		// The define vite.shared.ts computes, recomputed here from the same
		// files, so a change to either side of the stamp shows.
		const ms = shippedDataValidUntilMs(shippedSidecars(), Date.now());
		expect(__DATA_VALID_UNTIL__).toBe(ms === null ? null : new Date(ms).toISOString());
	});
});
