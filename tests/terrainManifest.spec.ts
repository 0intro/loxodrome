/* The terrain manifest (public/data/terrain.json): the elevation models'
 * licence credits, which both About pages print while the app serves ground
 * derived from them, and the level range the mosaic publishes.
 *
 * One offline first read used to leave the credits unprintable for the whole
 * session, the read being memoised as a promise; a TRANSIENT failure now asks
 * again, throttled, since getTile awaits the read on every tile. A 404 is a
 * fact about the deployment and is never asked again. The module is
 * re-imported per case, its memo being module state. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const MANIFEST = readFileSync('public/data/terrain.json', 'utf8');

type FetchStub = (url: string) => Promise<Response>;

function stubFetch(answers: (() => Promise<Response>)[]): { calls: string[] } {
	const calls: string[] = [];
	const fn: FetchStub = (url) => {
		calls.push(url);
		const next = answers.shift();
		if (!next) {
			throw new Error('unexpected fetch ' + url);
		}
		return next();
	};
	vi.stubGlobal('fetch', vi.fn(fn));
	return { calls };
}

const offline = (): Promise<Response> => Promise.reject(new TypeError('Failed to fetch'));
const answer = (status: number, body = ''): (() => Promise<Response>) => () =>
	Promise.resolve(new Response(body, { status }));

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('the terrain manifest read', () => {
	it('ships, with a credit for every model the mosaic is built from', () => {
		const doc = JSON.parse(MANIFEST) as { regions: { id: string; label: string; attribution: string }[] };
		expect(doc.regions.length).toBeGreaterThan(0);
		for (const r of doc.regions) {
			expect(r.id).toMatch(/\S/);
			expect(r.label).toMatch(/\S/);
			expect(r.attribution).toMatch(/\S/);
		}
	});

	it('asks again after a network failure, but not before the throttle', async () => {
		const { calls } = stubFetch([offline, answer(200, MANIFEST)]);
		const terrain = await import('$lib/map/terrain');
		await terrain.ensureTerrainRegions();
		expect(terrain.terrainRegions()).toEqual([]);
		// Inside the minute: the tile path's own awaits must not re-ask.
		await terrain.ensureTerrainRegions();
		expect(calls).toHaveLength(1);
		vi.setSystemTime(new Date('2026-09-22T12:01:01Z'));
		await terrain.ensureTerrainRegions();
		expect(calls).toHaveLength(2);
		expect(terrain.terrainRegions().map((r) => r.id)).toEqual(
			(JSON.parse(MANIFEST) as { regions: { id: string }[] }).regions.map((r) => r.id),
		);
	});

	it('asks again after a server error, and never after a 404', async () => {
		const first = stubFetch([answer(503)]);
		let terrain = await import('$lib/map/terrain');
		await terrain.ensureTerrainRegions();
		vi.setSystemTime(new Date('2026-09-22T12:05:00Z'));
		stubFetch([answer(200, MANIFEST)]);
		await terrain.ensureTerrainRegions();
		expect(first.calls).toHaveLength(1);
		expect(terrain.terrainRegions().length).toBeGreaterThan(0);

		vi.resetModules();
		const missing = stubFetch([answer(404)]);
		terrain = await import('$lib/map/terrain');
		await terrain.ensureTerrainRegions();
		vi.setSystemTime(new Date('2026-09-22T13:00:00Z'));
		await terrain.ensureTerrainRegions();
		expect(missing.calls).toHaveLength(1);
		expect(terrain.terrainRegions()).toEqual([]);
	});
});
