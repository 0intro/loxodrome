import { describe, it, expect } from 'vitest';
import {
	OBSTACLE_LABELS,
	obstacleGroup,
	obstacleSourceFromId,
	type Obstacle,
	type ObstacleType,
} from '$lib/data/obstacles';
import { PUBLISHERS } from '$lib/state/layers.svelte';

// Internal round-trip tests for the obstacle loader's pure helpers. The
// fetch path itself is covered manually (the dev-server smoke step in the
// plan); these tests pin the label dictionary, the group mapping and the
// language-neutral type set used by cmd/obstacles -> SPA.

describe('OBSTACLE_LABELS', () => {
	it('covers every language-neutral type code', () => {
		const allTypes: ObstacleType[] = [
			'windturbine', 'pylon', 'mast', 'watertower', 'tower',
			'building', 'chimney', 'silo', 'antenna', 'cable',
			'lighthouse', 'flarestack', 'mine', 'bridge', 'powerplant',
			'crane', 'church', 'lattice', 'portal', 'derrick', 'other',
		];
		for (const t of allTypes) {
			expect(OBSTACLE_LABELS[t], `label missing for ${t}`).toBeTruthy();
		}
	});

	it('labels match what the user sees in the panel (a few anchors)', () => {
		expect(OBSTACLE_LABELS.windturbine).toBe('Wind turbine');
		expect(OBSTACLE_LABELS.pylon).toBe('Pylon');
		expect(OBSTACLE_LABELS.chimney).toBe('Chimney');
		expect(OBSTACLE_LABELS.lighthouse).toBe('Lighthouse');
		expect(OBSTACLE_LABELS.other).toBe('Other obstacle');
	});
});

describe('obstacleGroup', () => {
	it('routes wind turbines to their own group', () => {
		expect(obstacleGroup('windturbine')).toBe('windturbines');
	});

	it('routes everything else to "other"', () => {
		const types: ObstacleType[] = [
			'pylon', 'mast', 'watertower', 'tower', 'building', 'chimney',
			'silo', 'antenna', 'cable', 'lighthouse', 'flarestack', 'mine',
			'bridge', 'powerplant', 'crane', 'church', 'lattice', 'portal',
			'derrick', 'other',
		];
		for (const t of types) {
			expect(obstacleGroup(t), `${t} should be in other`).toBe('other');
		}
	});
});

// The publisher is read off the id prefix and the fallback is France, so
// a dataset whose code never reached PUBLISHERS is filed under France
// silently: its rows hide behind the wrong toggle and no warning is
// raised. These pin the two halves of that rule.
describe('obstacleSourceFromId', () => {
	it('reads the publisher off the prefix', () => {
		expect(obstacleSourceFromId('fi:EFINOB 10031')).toBe('fi');
		expect(obstacleSourceFromId('ch:CH123')).toBe('ch');
		expect(obstacleSourceFromId('de:0815')).toBe('de');
	});

	it('files an unknown prefix and a bare id under France', () => {
		// France's own ids carry a feature type where the others carry a
		// publisher code, which is what makes France the fallback.
		expect(obstacleSourceFromId('Eolienne:36671249')).toBe('fr');
		expect(obstacleSourceFromId('36671249')).toBe('fr');
		expect(obstacleSourceFromId(':leading')).toBe('fr');
	});

	it('resolves every publisher code to itself', () => {
		for (const p of PUBLISHERS) {
			expect(obstacleSourceFromId(`${p}:1`), `${p} misfiled`).toBe(p);
		}
	});
});

describe('Obstacle shape', () => {
	it('accepts the canonical row produced by cmd/obstacles', () => {
		// Exemplar of a wind turbine row (compact-JSON, 10 positional fields):
		// [id, type, name, lat, lon, elev, hgt, lit, group, rmk]
		const o: Obstacle = {
			id: '36671249',
			type: 'windturbine',
			name: 'E1007-12',
			lat: 48.16016,
			lon: 4.49883,
			elev: 1376,
			hgt: 493,
			lit: true,
			group: false,
			rmk: '',
			source: 'fr',
		};
		expect(o.type).toBe('windturbine');
		expect(o.lit).toBe(true);
	});
});
