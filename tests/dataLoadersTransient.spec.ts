/* The per-country loaders and the sidecars through the one read
 * (src/lib/data/fetchData.ts): what each answers for what the deployment
 * does not hold, and that a failure worth asking again always REJECTS.
 *
 * The fail-soft loaders folded every refusal into an empty list, a 503
 * included, and the store kept that list as the country's rows for the
 * session; a document that did not parse, meanwhile, threw and sank every
 * other country of the pass. The throwing ones could not tell a 404 from a
 * network outage. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failAlways, fetched, serve, serveCoverageSite, type Fault } from './helpers/coverageSite';
import { DataReadError } from '$lib/data/fetchData';

const URL_ = '/data/it-x.json';

beforeEach(() => {
	serveCoverageSite();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function loaders() {
	const airports = await import('$lib/data/airports');
	const airspaces = await import('$lib/data/airspaces');
	const obstacles = await import('$lib/data/obstacles');
	const navaids = await import('$lib/data/navaids');
	const nature = await import('$lib/data/nature');
	return {
		soft: {
			airports: (u: string) => airports.loadFrAirports(u, 'it'),
			airspaces: (u: string) => airspaces.loadAirspaceOverlay(u, 'it'),
			obstacles: (u: string) => obstacles.loadObstacles(u),
			navaids: (u: string) => navaids.loadNavaids(u),
			nature: (u: string) => nature.loadNature(u),
		},
		hard: {
			baseline: (u: string) => airports.loadAirports(u),
			franceAirspaces: (u: string) => airspaces.loadAirspaces(u),
		},
	};
}

// What the deployment does not hold: a 404, a 410, and under vitest (a dev
// build) the HTML page the dev server falls back to.
const ABSENT: Fault[] = [404, 410, 'html'];
const TRANSIENT: Fault[] = [500, 502, 503, 504, 408, 429, 403, 401, 407, 'network', 'truncate'];

describe('a fail-soft loader', () => {
	for (const how of ABSENT) {
		it(`answers no rows for ${how}, warning`, async () => {
			const { soft } = await loaders();
			failAlways(URL_, how);
			for (const load of Object.values(soft)) {
				await expect(load(URL_)).resolves.toEqual([]);
			}
			expect(console.warn).toHaveBeenCalled();
		});
	}

	for (const how of TRANSIENT) {
		it(`rejects ${how}, which is worth asking again`, async () => {
			const { soft } = await loaders();
			failAlways(URL_, how);
			for (const load of Object.values(soft)) {
				const e = await load(URL_).catch((x: unknown) => x);
				expect(e).toBeInstanceOf(DataReadError);
				expect(e).toMatchObject({ url: URL_, transient: true });
			}
		});
	}

	it('rejects a document that does not parse, as a fact, never an empty list', async () => {
		const { soft } = await loaders();
		failAlways(URL_, 'bad-json');
		for (const load of Object.values(soft)) {
			const e = await load(URL_).catch((x: unknown) => x);
			expect(e).toBeInstanceOf(DataReadError);
			expect(e).toMatchObject({ url: URL_, transient: false, absent: false });
		}
		expect(console.warn).not.toHaveBeenCalled();
	});

	it('rejects a document that parses but is not the dataset, as a fact', async () => {
		const { soft } = await loaders();
		serve(URL_, {});
		const e = await soft.obstacles(URL_).catch((x: unknown) => x);
		expect(e).toBeInstanceOf(Error);
		expect(e).not.toBeInstanceOf(DataReadError);
	});
});

describe('a throwing loader', () => {
	it.each([404, 'html'] as const)('rejects an absent file (%s), as a fact', async (how) => {
		const { hard } = await loaders();
		failAlways(URL_, how);
		for (const load of Object.values(hard)) {
			const e = await load(URL_).catch((x: unknown) => x);
			expect(e).toMatchObject({ absent: true, transient: false });
			expect(String(e)).toMatch(how === 404 ? /it-x\.json: HTTP 404$/ : /not JSON/);
		}
	});

	it.each(TRANSIENT)('rejects %s as worth asking again', async (how) => {
		const { hard } = await loaders();
		failAlways(URL_, how);
		for (const load of Object.values(hard)) {
			await expect(load(URL_)).rejects.toMatchObject({ transient: true });
		}
	});
});

describe('a sidecar', () => {
	it('answers null for an optional one the deployment does not hold', async () => {
		vi.resetModules();
		const { datasetMeta } = await import('$lib/data/meta');
		failAlways('/data/it-airports.next.meta.json', 404);
		await expect(datasetMeta('it', 'airports', true)()).resolves.toBeNull();
		failAlways('/data/it-navaids.next.meta.json', 'html');
		await expect(datasetMeta('it', 'navaids', true)()).resolves.toBeNull();
	});

	it('rejects a 503 and is asked again by the next call', async () => {
		vi.resetModules();
		const { datasetMeta } = await import('$lib/data/meta');
		const recover = failAlways('/data/it-airports.meta.json', 503);
		const load = datasetMeta('it', 'airports');
		await expect(load()).rejects.toMatchObject({ transient: true });
		recover();
		await expect(load()).resolves.toMatchObject({ effective: '2026-01-01T00:00:00Z' });
		expect(fetched('/data/it-airports.meta.json')).toBe(2);
	});
});
