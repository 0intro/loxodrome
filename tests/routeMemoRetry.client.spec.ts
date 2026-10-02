/* The route memos retry a failure ON THEIR OWN (state/routeMsa.svelte.ts,
 * state/routeTerrain.svelte.ts armRetry). A failed tile left the nav log's MSA
 * column, the band's "MSA leg" and the profile's ground blank, and the retry
 * armed for it fired only when a host called ensure again past the cooldown;
 * every host tracks its route and settings alone, so nothing ever did.
 * Here the hosts are real effects (tests/env/webnode.ts runs them), the
 * network is offline for the first pass and back for the retry. */

import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

const net = vi.hoisted(() => ({ up: false, asked: 0 }));
vi.mock('$lib/offline/passiveStore', () => ({
	passiveFetchBlob: (url: string): Promise<Blob | null> => {
		net.asked++;
		if (!net.up) {
			return Promise.reject(new Error('offline'));
		}
		const parts = url.split('/');
		const raw = gunzipSync(readFileSync('tests/fixtures/terrain-12-2125-1464.tile'));
		const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
		view.setUint8(8, Number(parts.at(-3)));
		view.setUint32(12, Number(parts.at(-2)), true);
		view.setUint32(16, Number(parts.at(-1)), true);
		return Promise.resolve(new Blob([gzipSync(raw)]));
	},
}));
// The obstacles the data module answers, and the revision a late country
// bumps (a reactive stand-in: the MSA reads it to know the set grew).
const obst = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('$lib/state/data.svelte', async () => {
	const { fakeDataState } = await import('./helpers/fakeDataState.svelte');
	return { ensureObstacles: () => Promise.resolve(obst.list), dataState: fakeDataState };
});

import { mountMsaHost, mountTerrainHost } from './helpers/routeMemoHosts.svelte';
import { fakeDataState } from './helpers/fakeDataState.svelte';

const WPS = [
	{ lat: 48.8, lon: 2.6 },
	{ lat: 48.5, lon: 2.7 },
];

/** Wait for `cond`, letting the fetches, the decodes (real I/O) and the
 *  settles run and flushing the effects, up to `ms` of REAL time: a count of
 *  ticks was too few for a decode on a loaded machine. performance.now is
 *  not among the faked clocks. */
async function until(cond: () => boolean, ms = 15_000): Promise<void> {
	const end = performance.now() + ms;
	for (;;) {
		flushSync();
		if (cond() || performance.now() > end) {
			return;
		}
		await new Promise((r) => setImmediate(r));
	}
}

afterEach(() => {
	vi.useRealTimers();
	net.up = false;
	obst.list = [];
});

describe('a route memo after a transient tile failure, nothing edited', () => {
	it('reads the MSA again once its retry comes due', { timeout: 40_000 }, async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		const host = mountMsaHost('r-msa', WPS, { halfWidthNM: 5, vfr: true });
		await until(() => host.value() != null);
		expect(host.value()).toEqual([null]); // offline: unknown
		const runs = host.runs();
		net.up = true;
		// The cache asks a failed tile again after its own delay; the memo's
		// retry comes due just past it, with no host input moving.
		await vi.advanceTimersByTimeAsync(62_000);
		await until(() => (host.value()?.[0] ?? 0) > 0);
		expect(host.runs()).toBeGreaterThan(runs);
		expect(host.value()?.[0]).toBeGreaterThan(0);
		host.stop();
	});

	it('reads the profile ground again once its retry comes due', { timeout: 40_000 }, async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		const host = mountTerrainHost('r-terrain', WPS);
		await until(() => host.value() != null);
		expect(host.value()?.some((s) => s.elevFt == null)).toBe(true);
		net.up = true;
		await vi.advanceTimersByTimeAsync(62_000);
		await until(() => host.value()?.every((s) => s.elevFt != null) === true);
		expect(host.value()?.every((s) => s.elevFt != null)).toBe(true);
		host.stop();
	});
});

describe('a route memo when obstacles land late', () => {
	it('computes the MSA again, over the obstacles that landed', { timeout: 40_000 }, async () => {
		net.up = true;
		const host = mountMsaHost('r-late', WPS, { halfWidthNM: 5, vfr: true });
		await until(() => (host.value()?.[0] ?? 0) > 0);
		// The fixture tile stands in for every tile, and it is alpine ground.
		const before = host.value()?.[0] ?? 0;
		expect(before).toBeLessThan(20_000);
		// An obstacle whose top is 20 000 ft, on the leg, in a country that
		// loads after the MSA was first computed (a widening, or a retry).
		obst.list = [
			{ id: 'it:OB1', type: 'mast', name: 'MAST', lat: 48.65, lon: 2.65, elev: 20_000, hgt: 300, lit: true, group: false, rmk: '', source: 'it' },
		];
		fakeDataState.revision.obstacles++;
		await until(() => (host.value()?.[0] ?? 0) > 20_000);
		expect(host.value()?.[0]).toBeGreaterThan(20_000);
		host.stop();
	});
});
