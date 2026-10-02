/* The base layer's mount (map/baseLayerSync.ts): which layer is on the map
 * while an offline base map's composite is being built, and what happens
 * when the selection or the pack moves on meanwhile. Fake layers and a
 * loader the test resolves by hand: the rules are about order, not Leaflet. */

import { describe, expect, it } from 'vitest';
import type L from 'leaflet';
import { createBaseLayerSync, type PackBaseFactory } from '$lib/map/baseLayerSync';
import type { BaseLayerId } from '$lib/state/layers.svelte';

interface FakeLayer {
	name: string;
	addTo(m: FakeMap): FakeLayer;
	remove(): FakeLayer;
}
interface FakeMap {
	on: FakeLayer[];
}

function world() {
	const m: FakeMap = { on: [] };
	const made: string[] = [];
	const layer = (name: string): FakeLayer => {
		made.push(name);
		const l: FakeLayer = {
			name,
			addTo(map) {
				map.on.push(l);
				return l;
			},
			remove() {
				m.on = m.on.filter((x) => x !== l);
				return l;
			},
		};
		return l;
	};
	const packs: Partial<Record<BaseLayerId, File | null>> = {};
	let ready = true;
	let loads = 0;
	let release: (f: PackBaseFactory) => void = () => undefined;
	let fail: (e: Error) => void = () => undefined;
	let loading: Promise<PackBaseFactory> | null = null;
	const factory: PackBaseFactory = (live, archive) =>
		Promise.resolve(layer(`composite:${(live as unknown as FakeLayer).name}:${archive.name}`) as unknown as L.Layer);
	const sync = createBaseLayerSync({
		live: (id) => layer(`live:${id}`) as unknown as L.TileLayer,
		pack: (id) => packs[id] ?? null,
		ready: () => ready,
		loadPackBase: () => {
			loads++;
			loading ??= new Promise<PackBaseFactory>((res, rej) => {
				release = res;
				fail = rej;
			});
			return loading;
		},
	});
	return {
		m,
		made,
		packs,
		sync: (id: BaseLayerId) => sync.sync(m as unknown as L.Map, id),
		clear: () => sync.clear(),
		mounted: () => m.on.map((l) => l.name),
		load: async () => {
			release(factory);
			await new Promise((r) => setTimeout(r, 0));
		},
		failLoad: async () => {
			fail(new Error('chunk failed'));
			loading = null;
			await new Promise((r) => setTimeout(r, 0));
		},
		setReady: (r: boolean) => (ready = r),
		get loads() {
			return loads;
		},
	};
}

const A = new File(['a'], 'A');
const B = new File(['b'], 'B');

describe('the base layer mount', () => {
	it('mounts a live layer and rebuilds nothing for an unchanged choice', () => {
		const w = world();
		w.sync('osm');
		w.sync('osm');
		expect(w.mounted()).toEqual(['live:osm']);
		expect(w.made).toEqual(['live:osm']);
	});

	it('waits at boot for a held pack\'s composite instead of firing the live layer', async () => {
		const w = world();
		w.packs.planign = A;
		w.sync('planign');
		expect(w.mounted()).toEqual([]);
		await w.load();
		expect(w.mounted()).toEqual(['composite:live:planign:A']);
	});

	it('keeps the previous base on screen while the composite is built, then swaps once', async () => {
		const w = world();
		w.sync('osm');
		w.packs.planign = A;
		w.sync('planign');
		w.sync('planign'); // an effect re-run while loading: no second build
		expect(w.mounted()).toEqual(['live:osm']);
		await w.load();
		expect(w.mounted()).toEqual(['composite:live:planign:A']);
		expect(w.made.filter((n) => n.startsWith('composite'))).toHaveLength(1);
	});

	it('drops a composite whose selection moved on while it was built', async () => {
		const w = world();
		w.packs.planign = A;
		w.sync('planign');
		w.sync('topo');
		expect(w.mounted()).toEqual(['live:topo']);
		await w.load();
		expect(w.mounted()).toEqual(['live:topo']);
	});

	it('mounts exactly one composite after away-and-back during the build', async () => {
		const w = world();
		w.sync('osm');
		w.packs.planign = A;
		w.sync('planign');
		w.sync('osm');
		w.sync('planign');
		await w.load();
		expect(w.mounted()).toEqual(['composite:live:planign:A']);
	});

	it('serves the live layer when the pack is deleted during the build', async () => {
		const w = world();
		w.sync('osm');
		w.packs.planign = A;
		w.sync('planign');
		w.packs.planign = null;
		w.sync('planign');
		expect(w.mounted()).toEqual(['live:planign']);
		await w.load();
		expect(w.mounted()).toEqual(['live:planign']);
	});

	it('rebuilds on a new File (an update landed) and lets the old composite go', async () => {
		const w = world();
		w.packs.planign = A;
		w.sync('planign');
		await w.load();
		w.packs.planign = B;
		w.sync('planign');
		expect(w.mounted()).toEqual(['composite:live:planign:A']);
		await w.load();
		expect(w.mounted()).toEqual(['composite:live:planign:B']);
	});

	it('falls back to the live layer when the composite cannot be built, and retries on the next File', async () => {
		const w = world();
		w.packs.planign = A;
		w.sync('planign');
		await w.failLoad();
		expect(w.mounted()).toEqual(['live:planign']);
		w.sync('planign'); // same File: no retry loop
		expect(w.loads).toBe(1);
		w.packs.planign = B;
		w.sync('planign');
		expect(w.loads).toBe(2);
		await w.load();
		expect(w.mounted()).toEqual(['composite:live:planign:B']);
	});

	it('lands nothing after clear(), the map\'s teardown', async () => {
		const w = world();
		w.packs.planign = A;
		w.sync('planign');
		w.clear();
		await w.load();
		expect(w.mounted()).toEqual([]);
	});

	it('changes nothing until the pack store has reconciled', async () => {
		const w = world();
		w.setReady(false);
		w.sync('planign');
		expect(w.mounted()).toEqual([]);
		expect(w.made).toEqual([]);
		w.setReady(true);
		w.packs.planign = A;
		w.sync('planign');
		await w.load();
		expect(w.mounted()).toEqual(['composite:live:planign:A']);
	});
});
