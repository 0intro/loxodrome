import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODEL_IDS, MODELS, CHAINS, pyramid } from '../src/models.ts';
import { mfKeys } from '../src/discover.ts';
import { FIXTURES } from './helpers.ts';

interface GoModel {
	id: string;
	name: string;
	producer: string;
	grid: { ni: number; nj: number; northE6: number; westE6: number; diE6: number; djE6: number; wraps: boolean };
	levels: number[];
	cycleHours: number;
	horizons: Record<string, number>;
	blocks: Record<string, { first: number; last: number; name: string }[]>;
	pyramid: unknown[];
	cloud: string;
	mf?: { dir: string; stem: string; cloudPkg: string; hourly: boolean; keys: Record<string, string[]> };
}

void test('the registry states the models exactly as internal/nwp does', () => {
	const goModels = JSON.parse(readFileSync(join(FIXTURES, 'models.json'), 'utf8')) as GoModel[];
	assert.deepEqual(goModels.map((m) => m.id).sort(), [...MODEL_IDS].sort());
	for (const g of goModels) {
		const spec = MODELS[g.id as keyof typeof MODELS];
		assert.deepEqual(spec.grid, g.grid, `${g.id} grid`);
		assert.deepEqual([...spec.levels], g.levels, `${g.id} levels`);
		assert.equal(spec.cycleHours, g.cycleHours, `${g.id} cycle`);
		assert.equal(spec.cloud, g.cloud, `${g.id} cloud`);
		assert.deepEqual(spec.pyramid, g.pyramid, `${g.id} pyramid`);
		for (const [hh, horizon] of Object.entries(g.horizons)) {
			assert.equal(spec.horizon(Number(hh)), horizon, `${g.id} ${hh}Z horizon`);
			assert.deepEqual(spec.blocks(Number(hh)), g.blocks[hh], `${g.id} ${hh}Z blocks`);
		}
		// The files discovery waits for are the files the ingest reads.
		assert.equal(spec.mf === undefined, g.mf === undefined, `${g.id} publisher`);
		if (spec.mf && g.mf) {
			const { dir, stem, cloudPkg, hourly } = spec.mf;
			assert.deepEqual({ dir, stem, cloudPkg, hourly }, { dir: g.mf.dir, stem: g.mf.stem, cloudPkg: g.mf.cloudPkg, hourly: g.mf.hourly }, `${g.id} store`);
			for (const [name, keys] of Object.entries(g.mf.keys)) {
				const b = spec.blocks(0).find((x) => x.name === name);
				assert.ok(b, `${g.id} ${name}`);
				assert.deepEqual(mfKeys(spec, Date.parse('2026-10-06T00:00:00Z'), b), keys, `${g.id} ${name} files`);
			}
		}
	}
});

void test('every chain names registered members, Météo-France before ECMWF', () => {
	for (const [id, chain] of Object.entries(CHAINS)) {
		assert.ok(chain.length > 0, id);
		for (const m of chain) {
			assert.ok(MODELS[m], `${id}: ${m}`);
		}
	}
	assert.deepEqual(CHAINS.auto_chain, ['arome0025', 'aromeomantil', 'aromeomguyane', 'aromeomindien', 'aromeomncaled', 'aromeompolyn', 'arpege01', 'ifs025']);
	assert.deepEqual(CHAINS.meteofrance_seamless, ['arome0025', 'arpege01']);
});

void test('the pyramid refuses what Go refuses, never looping on a grid off the lattice', () => {
	const grid = { ni: 100, nj: 100, northE6: 50_000_000, westE6: 1_062_500, diE6: 25_000, djE6: 25_000, wraps: false };
	// A west edge between two 0.025° points: no column lands on 1/8 degree.
	assert.throws(() => pyramid(grid, [5]), /no native point on the lattice/);
	assert.throws(() => pyramid({ ...grid, westE6: 1_050_000, djE6: 50_000 }, [5]), /not square/);
	assert.throws(() => pyramid({ ...grid, westE6: -180_000_000, wraps: true, ni: 1442 }, [4]), /does not divide/);
	// A small domain has no zoom left for a 2 degree level: Guyane's grid.
	const guyane = { ni: 419, nj: 317, northE6: 8_950_000, westE6: -56_750_000, diE6: 25_000, djE6: 25_000, wraps: false };
	assert.throws(() => pyramid(guyane, [5, 10, 20, 40, 80]), /needs a zoom the finer levels took/);
	assert.deepEqual(
		pyramid(guyane, [5, 10, 20, 40]).map((l) => [l.z, l.factor, l.i0, l.j0, l.ni, l.nj, l.tx, l.ty]),
		[[5, 1, 0, 0, 419, 317, 27, 20], [3, 5, 0, 3, 84, 63, 6, 4], [2, 10, 0, 8, 42, 31, 3, 2], [1, 20, 10, 18, 21, 15, 2, 1], [0, 40, 30, 38, 10, 7, 1, 1]],
	);
});
