/* A next pair a build has RETIRED, over a served site
 * (tests/helpers/coverageSite.ts).
 *
 * The sidecar loaders keep an answer for the session, and a publisher's
 * build deletes its next pair once the current slot has caught up with it
 * (pruneSupersededNext in internal/aip). A session that read the pair before
 * that build, and first wanted the country after it, picked a file that was
 * gone: a fail-soft loader read the missing file as nothing there and stored
 * the country as loaded with no rows, no retry and nothing said; France's,
 * which requires its file, failed every retry on the same kept sidecars. A
 * next pick that answers nothing is now checked against fresh sidecars, which
 * pick the current slot, holding that cycle now. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INNSBRUCK, KANSAS, PARIS, fetched, log, serve, serveCoverageSite } from './helpers/coverageSite';

const BOOT = Date.parse('2026-09-27T12:00:00Z');
const CYCLE = '2026-09-30T00:00:00Z';
const AFTER = Date.parse('2026-10-02T12:00:00Z');
const AT_BOX = [9.5, 46.3, 17.2, 49.1];
const FR_BOX = [-5.2, 41.3, 9.6, 51.1];
const OBSTACLE_FIELDS = ['id', 'type', 'name', 'lat', 'lon', 'elev', 'hgt', 'lit', 'group'];

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(BOOT);
	serveCoverageSite();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
	(await import('$lib/state/dataRetry.svelte')).resetDataRetryForTest();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** The build after the cycle date: the current pair holds the new cycle,
 *  the next pair is gone. */
function retire(base: string, box: number[], doc: unknown): void {
	serve(`/data/${base}.meta.json`, { effective: CYCLE, bbox: box });
	serve(`/data/${base}.json`, doc);
	serve(`/data/${base}.next.meta.json`, undefined);
	serve(`/data/${base}.next.json`, undefined);
}

describe('a country first wanted after its next pair was retired', () => {
	it('is read from its current file, not stored empty', async () => {
		serve('/data/at-obstacles.next.meta.json', { effective: CYCLE, bbox: AT_BOX });
		const cov = await import('$lib/state/coverage.svelte');
		const data = await import('$lib/state/data.svelte');
		const retry = await import('$lib/state/dataRetry.svelte');
		// Over Paris before the date: Austria is gated out, its sidecars read
		// and kept.
		cov.setCoverageViewport(PARIS);
		await data.ensureObstacles();
		expect(fetched('/data/at-obstacles.next.meta.json')).toBe(1);

		vi.setSystemTime(AFTER);
		retire('at-obstacles', AT_BOX, {
			fields: OBSTACLE_FIELDS,
			rows: [['at:OB1', 'mast', 'MAST', 47.26, 11.35, 3500, 300, true, false]],
		});
		cov.setCoverageViewport(INNSBRUCK);
		await data.extendCoverage();

		expect(fetched('/data/at-obstacles.next.json')).toBe(1);
		expect(fetched('/data/at-obstacles.json')).toBe(1);
		// The sidecars read again past the browser's cache, which GitHub
		// Pages lets hold them ten minutes: within those, the kept answer
		// came back and picked the retired file once more.
		expect(log.filter((e) => e.path === '/data/at-obstacles.next.meta.json').map((e) => e.cache)).toEqual([
			undefined,
			'no-cache',
		]);
		expect(data.getObstacles()?.map((o) => o.id)).toContain('at:OB1');
		expect(data.dataState.airac.obstacles.at).toEqual({ effective: CYCLE, nextEffective: null, slot: 'current' });
		expect(retry.dataRetry.pending).toEqual([]);
	});

	it('does not fail every retry when its loader requires the file (France)', async () => {
		serve('/data/fr-airspaces.next.meta.json', { effective: CYCLE, bbox: FR_BOX });
		const cov = await import('$lib/state/coverage.svelte');
		const data = await import('$lib/state/data.svelte');
		const retry = await import('$lib/state/dataRetry.svelte');
		// Over Kansas before the date: France is gated out.
		cov.setCoverageViewport(KANSAS);
		await data.ensureAirspaces();
		expect(fetched('/data/fr-airspaces.next.meta.json')).toBe(1);

		vi.setSystemTime(AFTER);
		retire('fr-airspaces', FR_BOX, { fields: [], rows: [] });
		cov.setCoverageViewport(PARIS);
		await data.extendCoverage();

		expect(fetched('/data/fr-airspaces.next.json')).toBe(1);
		expect(fetched('/data/fr-airspaces.json')).toBe(1);
		// France's current sidecar is a required one, read by the other
		// loader, past the browser's cache the same.
		expect(log.filter((e) => e.path === '/data/fr-airspaces.meta.json').map((e) => e.cache)).toEqual([
			undefined,
			'no-cache',
		]);
		expect(data.dataState.airac.airspaces.fr?.slot).toBe('current');
		expect(retry.dataRetry.pending.map((p) => p.key)).not.toContain('airspaces');
	});
});

describe('loadActiveSlot, the single-file sets', () => {
	it('reads the current file when the kept next pick is gone, and keeps a real empty next', async () => {
		const meta = await import('$lib/data/meta');
		const { readDataJsonSoft } = await import('$lib/data/fetchData');
		const rowsOf = (url: string): Promise<unknown[]> =>
			readDataJsonSoft<{ rows: unknown[] }>(url).then((d) => d?.rows ?? []);
		serve('/data/fr-fuel.next.meta.json', { effective: CYCLE });
		// The About dialog read both sidecars at boot.
		await meta.loadFrFuelMeta();
		await meta.loadFrFuelNextMeta();

		vi.setSystemTime(AFTER);
		retire('fr-fuel', FR_BOX, { fields: ['ident'], rows: [['LFPL']] });
		const rows = await meta.loadActiveSlot(
			meta.loadFrFuelMeta,
			meta.loadFrFuelNextMeta,
			'/data/fr-fuel.json',
			'/data/fr-fuel.next.json',
			rowsOf,
		);
		expect(rows).toEqual([['LFPL']]);

		// A next file that is really there and empty stands, the sidecars
		// still naming it.
		serve('/data/fr-fuel.next.meta.json', { effective: CYCLE });
		serve('/data/fr-fuel.meta.json', { effective: '2026-09-02T00:00:00Z' });
		serve('/data/fr-fuel.next.json', { fields: ['ident'], rows: [] });
		await meta.loadFrFuelNextMeta(true);
		await meta.loadFrFuelMeta(true);
		const before = fetched('/data/fr-fuel.json');
		const empty = await meta.loadActiveSlot(
			meta.loadFrFuelMeta,
			meta.loadFrFuelNextMeta,
			'/data/fr-fuel.json',
			'/data/fr-fuel.next.json',
			rowsOf,
		);
		expect(empty).toEqual([]);
		expect(fetched('/data/fr-fuel.json')).toBe(before);
	});

	it('reads the current file for a set that requires its file, the kept next pick gone', async () => {
		// A strict reader rejects a missing file (DataReadError, absent)
		// rather than answering nothing: the same retired pair, the other road.
		const meta = await import('$lib/data/meta');
		const { readDataJson } = await import('$lib/data/fetchData');
		const strict = (url: string): Promise<unknown[]> =>
			readDataJson<{ rows: unknown[] }>(url).then((d) => d.rows);
		serve('/data/fr-fuel.next.meta.json', { effective: CYCLE });
		await meta.loadFrFuelMeta();
		await meta.loadFrFuelNextMeta();
		vi.setSystemTime(AFTER);
		retire('fr-fuel', FR_BOX, { fields: ['ident'], rows: [['LFPL']] });
		const rows = await meta.loadActiveSlot(
			meta.loadFrFuelMeta,
			meta.loadFrFuelNextMeta,
			'/data/fr-fuel.json',
			'/data/fr-fuel.next.json',
			strict,
		);
		expect(rows).toEqual([['LFPL']]);
		// Still gone on fresh sidecars that pick it: the failure stands.
		serve('/data/fr-fuel.next.meta.json', { effective: CYCLE });
		serve('/data/fr-fuel.meta.json', { effective: '2026-09-02T00:00:00Z' });
		await meta.loadFrFuelNextMeta(true);
		await meta.loadFrFuelMeta(true);
		await expect(
			meta.loadActiveSlot(meta.loadFrFuelMeta, meta.loadFrFuelNextMeta, '/data/fr-fuel.json', '/data/fr-fuel.next.json', strict),
		).rejects.toMatchObject({ absent: true });
	});
});
