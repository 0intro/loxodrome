/* The country datasets, their overlays and SUP AIP read again what failed
 * (state/data.svelte.ts over state/dataRetry.svelte.ts), over a served site
 * that fails the way a network and a server do (tests/helpers/coverageSite.ts).
 *
 * What was wrong: a country whose file answered a 5xx was stored as an empty
 * list, its rows for the session; one country's network error discarded
 * every other country of the same pass; a failed first load was asked again
 * only by whatever gesture next called its ensure, and meanwhile by every
 * one, the alert effect's on every GPS fix; the FAA airspace overlay was
 * latched before its fetch and never asked again; pruatlas was read once;
 * and a SUP AIP publisher that failed beside two that loaded was forgotten.
 *
 * The clock is fake (setTimeout, setInterval and Date): the retries run on
 * it. Each case is a fresh module graph. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	FOLIGNO,
	INNSBRUCK,
	KANSAS,
	PARIS,
	asked,
	fail,
	failAlways,
	failTimes,
	fetched,
	hold,
	serve,
	serveCoverageSite,
	settle,
	times,
} from './helpers/coverageSite';

let retry: typeof import('$lib/state/dataRetry.svelte');

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
	vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
	serveCoverageSite();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	retry.resetDataRetryForTest();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

async function mods(): Promise<{
	cov: typeof import('$lib/state/coverage.svelte');
	data: typeof import('$lib/state/data.svelte');
	scope: typeof import('$lib/state/planScope.svelte');
}> {
	retry = await import('$lib/state/dataRetry.svelte');
	return {
		cov: await import('$lib/state/coverage.svelte'),
		data: await import('$lib/state/data.svelte'),
		scope: await import('$lib/state/planScope.svelte'),
	};
}

const pendingKeys = (): string[] => retry.dataRetry.pending.map((p) => p.key);

/** Open sea, far from every publisher but the worldwide FIR rings. */
const SOUTH_ATLANTIC = { minLat: -50, minLon: -20, maxLat: -49, maxLon: -19 };

describe('a country that fails beside one that loads', () => {
	it.each([503, 'network'] as const)('publishes the rest, then reads only it again at 5 s (%s)', async (how) => {
		const { cov, data, scope } = await mods();
		cov.setCoverageViewport(PARIS);
		scope.planScope.extent = () => [FOLIGNO];
		failTimes('/data/it-airports.json', 1, how);
		await data.ensureAirports();
		// France published, Italy left to the baseline's row.
		expect(data.airportByIdent('LFPL')?.radios.map((r) => r.freq)).toEqual(['118.605']);
		expect(data.airportByIdent('LIAF')?.runways).toHaveLength(1);
		expect(pendingKeys()).toEqual(['airports:it']);
		const before = asked.length;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(asked.slice(before)).toEqual(['/data/it-airports.json']);
		expect(data.airportByIdent('LIAF')?.runways).toHaveLength(2);
		expect(retry.dataRetry.pending).toEqual([]);
	});

	it.each([404, 'html'] as const)('is the deployment answering nothing there for a %s, never asked again', async (how) => {
		const { cov, data, scope } = await mods();
		cov.setCoverageViewport(PARIS);
		scope.planScope.extent = () => [FOLIGNO];
		failAlways('/data/it-airports.json', how);
		await data.ensureAirports();
		expect(retry.dataRetry.pending).toEqual([]);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(fetched('/data/it-airports.json')).toBe(1);
	});

	it('is a portal page in a production build, asked again, never "nothing there"', async () => {
		vi.stubEnv('DEV', false);
		const { cov, data, scope } = await mods();
		cov.setCoverageViewport(PARIS);
		scope.planScope.extent = () => [FOLIGNO];
		failTimes('/data/it-airports.json', 1, 'html');
		await data.ensureAirports();
		expect(pendingKeys()).toEqual(['airports:it']);
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(data.airportByIdent('LIAF')?.runways).toHaveLength(2);
	});

	it('is asked again on the schedule while it keeps failing', async () => {
		const { cov, data, scope } = await mods();
		cov.setCoverageViewport(PARIS);
		scope.planScope.extent = () => [FOLIGNO];
		failAlways('/data/it-airports.json', 503);
		const t0 = Date.now();
		await data.ensureAirports();
		await vi.advanceTimersByTimeAsync(4_999);
		expect(retry.dataRetry.pending[0]?.announced).toBe(false);
		await vi.advanceTimersByTimeAsync(1 + 15_000 + 60_000 + 120_000);
		const at = times('/data/it-airports.json');
		expect(at.map((t, i) => t - (i === 0 ? t0 : at[i - 1]))).toEqual([0, 5_000, 15_000, 60_000, 120_000]);
		expect(retry.dataRetry.pending[0]?.announced).toBe(true);
	});

	it('is not read again by a coverage pass while it waits, and is dropped once nothing wants it', async () => {
		const { cov, data, scope } = await mods();
		cov.setCoverageViewport(PARIS);
		scope.planScope.extent = () => [FOLIGNO];
		failTimes('/data/it-airports.json', 1, 503);
		await data.ensureAirports();
		cov.setCoverageViewport(INNSBRUCK);
		await data.extendCoverage();
		expect(fetched('/data/at-airports.json')).toBe(1);
		expect(fetched('/data/it-airports.json')).toBe(1);
		// The plan and the view leave Italy before its retry comes due.
		scope.planScope.extent = () => [];
		cov.setCoverageViewport(KANSAS);
		await data.extendCoverage();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fetched('/data/it-airports.json')).toBe(1);
		expect(retry.dataRetry.pending).toEqual([]);
	});

	it('is read once by a retry that comes due behind a widening still running', async () => {
		const { cov, data, scope } = await mods();
		cov.setCoverageViewport(PARIS);
		scope.planScope.extent = () => [FOLIGNO];
		failTimes('/data/it-airports.json', 1, 503);
		await data.ensureAirports();
		const release = hold('/data/at-airports.json');
		cov.setCoverageViewport(INNSBRUCK);
		const widened = data.extendCoverage();
		await vi.advanceTimersByTimeAsync(5_000);
		release();
		await widened;
		await vi.advanceTimersByTimeAsync(0);
		await settle();
		expect(fetched('/data/it-airports.json')).toBe(2);
		expect(data.airportByIdent('LIAF')?.runways).toHaveLength(2);
	});
});

describe('a gesture', () => {
	it('awaits the country a published dataset is still missing', async () => {
		// The ensures of a published dataset answer at once, whatever of it
		// is still being read: a print, a file opened or Restore it awaited
		// them and read the set without the country its own gesture asked.
		const { cov, data, scope } = await mods();
		cov.setCoverageViewport(PARIS);
		scope.planScope.extent = () => [FOLIGNO];
		failTimes('/data/it-airports.json', 1, 503);
		await data.ensureAirports();
		expect(data.airportByIdent('LIAF')?.runways).toHaveLength(1);
		const release = hold('/data/it-airports.json');
		const asked = retry.retryDataNow();
		await data.ensureAirports();
		expect(data.airportByIdent('LIAF')?.runways).toHaveLength(1);
		release();
		await asked;
		expect(data.airportByIdent('LIAF')?.runways).toHaveLength(2);
		expect(retry.dataRetry.pending).toEqual([]);
	});
});

describe('a first load that fails', () => {
	it('answers its failure without reading again, whoever asks, until its retry', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(PARIS);
		failTimes('/data/airports.json', 1, 503);
		const first = await data.ensureAirports().catch((e: unknown) => e);
		expect(String(first)).toMatch(/airports\.json: HTTP 503/);
		expect(data.dataState.airportsError).toMatch(/HTTP 503/);
		for (let i = 0; i < 50; i++) {
			await expect(data.ensureAirports()).rejects.toBe(first);
			expect(data.dataState.airportsLoading).toBe(false);
		}
		expect(fetched('/data/airports.json')).toBe(1);
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(fetched('/data/airports.json')).toBe(2);
		expect(data.dataState.airportsLoaded).toBe(true);
		expect(data.dataState.airportsError).toBeNull();
		await data.ensureAirports();
		expect(fetched('/data/airports.json')).toBe(2);
	});

	it('keeps its failure line while the retry reads, then clears it', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(PARIS);
		failTimes('/data/airports.json', 1, 503);
		await data.ensureAirports().catch(() => {});
		const error = data.dataState.airportsError;
		const release = hold('/data/airports.json');
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fetched('/data/airports.json')).toBe(2);
		expect(data.dataState.airportsError).toBe(error);
		expect(data.dataState.airportsLoading).toBe(false);
		release();
		await settle();
		expect(data.dataState.airportsError).toBeNull();
		expect(data.dataState.airportsLoaded).toBe(true);
	});

	it('asks a fact about the deployment again only at the longest wait, and says so at once', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(PARIS);
		fail('/data/airports.json', 503, 404);
		await data.ensureAirports().catch(() => {});
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(data.dataState.airportsError).toMatch(/HTTP 404/);
		expect(pendingKeys()).toEqual(['airports']);
		expect(retry.bannerEntries()).toEqual([{ group: 'airports', parts: [] }]);
		// The alert effect asks on every fix: nothing is read meanwhile.
		for (let i = 0; i < 50; i++) {
			await data.ensureAirports().catch(() => {});
		}
		await vi.advanceTimersByTimeAsync(299_999);
		expect(fetched('/data/airports.json')).toBe(2);
		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(fetched('/data/airports.json')).toBe(3);
		expect(data.dataState.airportsLoaded).toBe(true);
	});

	it('rejects when nothing wanted landed, and publishes at its retry', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(FOLIGNO);
		failTimes('/data/it-navaids.json', 1, 503);
		await expect(data.ensureNavaids()).rejects.toThrow(/it-navaids\.json: HTTP 503/);
		expect(data.dataState.navaidsError).toMatch(/HTTP 503/);
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(data.dataState.navaidsLoaded).toBe(true);
		expect(data.dataState.navaidsError).toBeNull();
	});
});

describe('every country dataset', () => {
	it.each([
		['obstacles', 'ensureObstacles', '/data/at-obstacles.json', INNSBRUCK],
		['navaids', 'ensureNavaids', '/data/it-navaids.json', FOLIGNO],
		['nature', 'ensureNature', '/data/it-nature.json', FOLIGNO],
		['airspaces', 'ensureAirspaces', '/data/it-airspaces.json', FOLIGNO],
	] as const)('reads a failed %s country again at 5 s and republishes', async (kind, ensure, file, area) => {
		const { cov, data, scope } = await mods();
		cov.setCoverageViewport(PARIS);
		scope.planScope.extent = () => [area];
		failTimes(file, 1, 503);
		await data[ensure]();
		const rev = data.dataState.revision[kind];
		expect(retry.retryingGroup(kind)).toBe(true);
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(fetched(file)).toBe(2);
		expect(data.dataState.revision[kind]).toBeGreaterThan(rev);
		expect(retry.retryingGroup(kind)).toBe(false);
	});
});

describe('a country that failed and matters', () => {
	it('is named and counted when its sidecar failed with it, near the pilot', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(PARIS);
		failTimes('/data/fr-airspaces.meta.json', 1, 'network');
		failTimes('/data/fr-airspaces.json', 1, 'network');
		failTimes('/data/is-airspaces.meta.json', 1, 'network');
		failTimes('/data/is-airspaces.json', 1, 'network');
		await data.ensureAirspaces();
		// France is under the pilot: the alerts' caveat, the banner, the
		// prints and the panel all count it. Iceland, whose envelope is as
		// unknown, is far away: retried, and nobody is told.
		expect(retry.retryingGroup('airspaces')).toBe(true);
		expect(retry.dataRetry.pending.find((p) => p.key === 'airspaces:fr')?.quiet).toBe(false);
		expect(retry.dataRetry.pending.find((p) => p.key === 'airspaces:is')?.quiet).toBe(true);
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(retry.dataRetry.pending).toEqual([]);
	});

	it('is kept and named when a widening meets a document that does not parse, and not read again on every pass', async () => {
		const { cov, data, scope } = await mods();
		cov.setCoverageViewport(INNSBRUCK);
		await data.ensureAirspaces();
		expect(fetched('/data/fr-airspaces.json')).toBe(0);
		failAlways('/data/fr-airspaces.json', 'bad-json');
		scope.planScope.extent = () => [PARIS];
		await data.extendCoverage();
		expect(pendingKeys()).toEqual(['airspaces:fr']);
		expect(retry.bannerEntries()).toEqual([{ group: 'airspaces', parts: ['fr'] }]);
		for (const dLon of [0.1, 0.2, 0.3, 0.4]) {
			cov.setCoverageViewport({ ...INNSBRUCK, minLon: INNSBRUCK.minLon + dLon });
			await data.extendCoverage();
		}
		expect(fetched('/data/fr-airspaces.json')).toBe(1);
		await vi.advanceTimersByTimeAsync(300_000);
		await settle();
		expect(fetched('/data/fr-airspaces.json')).toBe(2);
	});

	it('is asked again soon for a refusal a firewall or a portal makes', async () => {
		const { cov, data, scope } = await mods();
		cov.setCoverageViewport(PARIS);
		scope.planScope.extent = () => [INNSBRUCK];
		failTimes('/data/at-obstacles.json', 1, 403);
		await data.ensureObstacles();
		expect(pendingKeys()).toEqual(['obstacles:at']);
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(fetched('/data/at-obstacles.json')).toBe(2);
		expect(retry.dataRetry.pending).toEqual([]);
	});
});

describe('the airspace overlays', () => {
	it('reads the FIR rings again when they failed', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(PARIS);
		failTimes('/data/pruatlas-firs.json', 1, 503);
		await data.ensureAirspaces();
		expect(pendingKeys()).toEqual(['airspaces:pruatlas']);
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(fetched('/data/pruatlas-firs.json')).toBe(2);
		expect(retry.dataRetry.pending).toEqual([]);
	});

	it('reads the FAA overlay again when it failed, once, whatever widens meanwhile', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(KANSAS);
		failTimes('/data/faa-airspaces.json', 1, 'network');
		await data.ensureAirspaces();
		expect(pendingKeys()).toEqual(['airspaces:faa']);
		await Promise.all([data.extendCoverage(), data.extendCoverage()]);
		expect(fetched('/data/faa-airspaces.json')).toBe(1);
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(fetched('/data/faa-airspaces.json')).toBe(2);
		await data.extendCoverage();
		expect(fetched('/data/faa-airspaces.json')).toBe(2);
		expect(retry.dataRetry.pending).toEqual([]);
	});

	it('never asks again for an FAA overlay the deployment does not hold', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(KANSAS);
		failAlways('/data/faa-airspaces.json', 404);
		await data.ensureAirspaces();
		await vi.advanceTimersByTimeAsync(600_000);
		await data.extendCoverage();
		expect(fetched('/data/faa-airspaces.json')).toBe(1);
		expect(retry.dataRetry.pending).toEqual([]);
	});

	it('publishes beside a missing France and a failing Italy, each retried at its own pace', async () => {
		const { cov, data, scope } = await mods();
		cov.setCoverageViewport(PARIS);
		scope.planScope.extent = () => [FOLIGNO];
		failAlways('/data/fr-airspaces.json', 404);
		failTimes('/data/it-airspaces.json', 1, 503);
		// The FIR rings answered: the dataset is published, France (a
		// required file the site lacks) said at once, Italy once its first
		// retry fails, and neither read again by the passes.
		await data.ensureAirspaces();
		expect(pendingKeys()).toEqual(['airspaces:fr', 'airspaces:it']);
		expect(retry.bannerEntries()).toEqual([{ group: 'airspaces', parts: ['fr'] }]);
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(fetched('/data/it-airspaces.json')).toBe(2);
		expect(pendingKeys()).toEqual(['airspaces:fr']);
		await vi.advanceTimersByTimeAsync(295_000);
		await settle();
		expect(fetched('/data/fr-airspaces.json')).toBe(2);
	});

	it('publishes an empty set around a missing France when all else answered nothing, naming it', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(PARIS);
		failAlways('/data/fr-airspaces.json', 404);
		failAlways('/data/pruatlas-firs.json', 404);
		await expect(data.ensureAirspaces()).resolves.toEqual([]);
		expect(pendingKeys()).toEqual(['airspaces:fr']);
	});

	it('rejects when the FIR rings failed and no country was wanted', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(SOUTH_ATLANTIC);
		failTimes('/data/pruatlas-firs.json', 1, 503);
		await expect(data.ensureAirspaces()).rejects.toThrow(/pruatlas-firs\.json: HTTP 503/);
		expect(data.dataState.airspacesLoaded).toBe(false);
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(data.dataState.airspacesLoaded).toBe(true);
	});

	it('keeps an FAA overlay that failed, then did not parse, failed and quiet on the passes', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(KANSAS);
		fail('/data/faa-airspaces.json', 'network', 'bad-json', 'bad-json');
		await data.ensureAirspaces();
		expect(pendingKeys()).toEqual(['airspaces:faa']);
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(fetched('/data/faa-airspaces.json')).toBe(2);
		expect(retry.retryRefusal('airspaces:faa')?.message).toMatch(/JSON/);
		cov.setCoverageViewport({ ...KANSAS, minLon: KANSAS.minLon - 1 });
		await data.extendCoverage();
		expect(fetched('/data/faa-airspaces.json')).toBe(2);
		// A fact: read again at the longest wait, not on the ladder.
		await vi.advanceTimersByTimeAsync(15_000 + 60_000);
		expect(fetched('/data/faa-airspaces.json')).toBe(2);
		await vi.advanceTimersByTimeAsync(300_000);
		await settle();
		expect(fetched('/data/faa-airspaces.json')).toBe(3);
	});
});

describe('a failed country whose sidecar states no envelope', () => {
	it('is judged on its own territory, quiet over Paris and news over Innsbruck', async () => {
		// Its sidecar answered without a bbox: the gate cannot judge it, so
		// it loads, and its failure was counted as wanted wherever the pilot
		// was, the banner naming Austria over Paris.
		serve('/data/at-obstacles.meta.json', { effective: '2026-01-01T00:00:00Z' });
		failAlways('/data/at-obstacles.json', 503);
		const { cov, data } = await mods();
		cov.setCoverageViewport(PARIS);
		await data.ensureObstacles();
		expect(retry.dataRetry.pending.find((p) => p.key === 'obstacles:at')?.quiet).toBe(true);
		cov.setCoverageViewport(INNSBRUCK);
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(retry.dataRetry.pending.find((p) => p.key === 'obstacles:at')?.quiet).toBe(false);
	});
});

describe('a print asking only what matters', () => {
	it('asks a failed country the plan has just brought in, before any coverage pass', async () => {
		// Quiet over Paris; an aerodrome near Innsbruck added to the plan puts
		// Austria in the areas, and the print, asking only the parts known to
		// matter, skipped it on the last report's judgement: its retry was
		// not due, so the paper went out saying "incomplete" without the read
		// ever asked.
		serve('/data/at-obstacles.meta.json', { effective: '2026-01-01T00:00:00Z' });
		failAlways('/data/at-obstacles.json', 503);
		const { cov, data, scope } = await mods();
		cov.setCoverageViewport(PARIS);
		await data.ensureObstacles();
		expect(retry.dataRetry.pending.find((p) => p.key === 'obstacles:at')?.quiet).toBe(true);
		const before = fetched('/data/at-obstacles.json');
		scope.planScope.extent = () => [INNSBRUCK];
		await retry.retryDataNow({ groups: ['obstacles'], wantedOnly: true });
		expect(fetched('/data/at-obstacles.json')).toBe(before + 1);
		expect(retry.dataRetry.pending.find((p) => p.key === 'obstacles:at')?.quiet).toBe(false);
	});
});

describe('SUP AIP', () => {
	const row = (id: string, title: string, region: string) => [
		id, title, region, '', '', '', '', '', '', false, false, false, [], [], [], null, 'none', 'none', [], '', [], null, '',
	];

	it('publishes the publishers that loaded, then the one that failed at 5 s', async () => {
		serve('/data/es-supaip.json', { fields: [], rows: [row('es-2026-149', '149/2026', 'es')] });
		failTimes('/data/es-supaip.json', 1, 503);
		const { data } = await mods();
		await data.ensureSupaip();
		expect(data.supaipByRef(149, 2026, 'es')).toBeNull();
		expect(pendingKeys()).toEqual(['supaip:es']);
		const rev = data.dataState.revision.supaip;
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(data.supaipByRef(149, 2026, 'es')?.id).toBe('es-2026-149');
		expect(data.dataState.revision.supaip).toBeGreaterThan(rev);
		expect(retry.dataRetry.pending).toEqual([]);
	});

	it('rejects when every publisher failed, and reads each once however often it is asked', async () => {
		for (const f of ['/data/fr-supaip.json', '/data/be-supaip.json', '/data/es-supaip.json']) {
			failTimes(f, 1, 503);
		}
		const { data } = await mods();
		await expect(data.ensureSupaip()).rejects.toThrow(/HTTP 503/);
		for (let i = 0; i < 50; i++) {
			await data.ensureSupaip().catch(() => {});
		}
		expect(fetched('/data/fr-supaip.json')).toBe(1);
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(fetched('/data/fr-supaip.json')).toBe(2);
		expect(data.dataState.supaipLoaded).toBe(true);
	});

	it('rejects with the failure that may pass when another publisher is a fact, and is read again at 5 s', async () => {
		// The French file does not parse, a fact read again at the longest
		// wait; the other two fail as a server can. Rejecting with the first
		// failure in source order held the whole dataset for five minutes and
		// announced it at once, the other two due at 5 s.
		fail('/data/fr-supaip.json', 'bad-json', 'bad-json', 'bad-json');
		failTimes('/data/be-supaip.json', 1, 503);
		failTimes('/data/es-supaip.json', 1, 503);
		const { data } = await mods();
		await expect(data.ensureSupaip()).rejects.toThrow(/HTTP 503/);
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(fetched('/data/be-supaip.json')).toBe(2);
		expect(data.dataState.supaipLoaded).toBe(true);
		expect(pendingKeys()).toEqual(['supaip:fr']);
	});
});
