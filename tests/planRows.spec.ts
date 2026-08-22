/* Pins the Plans view's pure helpers (src/lib/state/planRows.ts): the
 * per-plan derivation as the matcher reads the file, and the per-yaml
 * outing use counts. The IndexedDB layer stays thin and untested (no
 * fake-indexeddb harness); everything around it is pinned here.
 * Contract: docs/flights-library.md. */

import { describe, expect, it } from 'vitest';
import { derivePlanRow, nextPlanName, planPreviewLines } from '$lib/state/planRows';
import type { WaypointAnchor } from '$lib/state/route.svelte';

const resolve = (tok: string): WaypointAnchor | null => {
	const db: Record<string, WaypointAnchor> = {
		LFPL: { lat: 48.6, lon: 2.62, kind: 'airport', refId: 'LFPL', ident: 'LFPL', label: 'Lognes' },
		LFPK: { lat: 48.84, lon: 3.01, kind: 'airport', refId: 'LFPK', ident: 'LFPK' },
	};
	return db[tok.toUpperCase()] ?? null;
};

describe('derivePlanRow', () => {
	it('chains a valid file, alternates included, in file order', () => {
		const yaml = [
			'version: 1',
			'routes:',
			'  - name: Sortie',
			'    waypoints:',
			'      - ident: LFPL',
			'      - ident: LFPK',
			'  - role: alternate',
			'    waypoints:',
			'      - ident: LFPK',
			'      - ident: LFPL',
			'',
		].join('\n');
		const s = derivePlanRow(yaml, resolve, 2026.0);
		expect(s).toEqual({
			name: null,
			// The generated file base: the trips' aerodrome chain (the
			// alternate is excluded by routesFileBaseName).
			baseName: 'LFPL-LFPK',
			state: {
				kind: 'ok',
				// The chain carries the ROLE, not just the label: the Plans view
				// leans an alternate the way the route strip does, and a flat
				// string list left a six-route file reading as one run of equal
				// legs.
				chain: [
					{ label: 'Sortie', alternate: false },
					{ label: 'LFPK → LFPL', alternate: true },
				],
				dropped: [],
			},
		});
	});

	it('a named plan captions its chain and names its own file', () => {
		const yaml = [
			'version: 1',
			'name: Nav examen Compiègne',
			'routes:',
			'  - waypoints:',
			'      - ident: LFPL',
			'      - ident: LFPK',
			'',
		].join('\n');
		const s = derivePlanRow(yaml, resolve, 2026.0);
		expect(s.name).toBe('Nav examen Compiègne');
		// The caption never displaces the fact, and the file it hands back is
		// named after the plan, ASCII-folded into ONE field (docs/file-names.md:
		// `_` separates fields, `-` joins inside one).
		expect(s.state.kind === 'ok' && s.state.chain).toEqual([
			{ label: 'LFPL → LFPK', alternate: false },
		]);
		expect(s.baseName).toBe('Nav-examen-Compiegne');
	});

	it('a named plan with no usable route still names its file', () => {
		const yaml = ['version: 1', 'name: Sortie plage', 'routes: []', ''].join('\n');
		const s = derivePlanRow(yaml, resolve, 2026.0);
		expect(s.state.kind).toBe('empty');
		expect(s.baseName).toBe('Sortie-plage');
	});

	it('lists the idents current data no longer resolves, still usable', () => {
		const yaml = [
			'version: 1',
			'routes:',
			'  - waypoints:',
			'      - ident: LFPL',
			'      - ident: NOPE',
			'      - ident: LFPK',
			'',
		].join('\n');
		const s = derivePlanRow(yaml, resolve, 2026.0).state;
		expect(s.kind).toBe('ok');
		if (s.kind === 'ok') {
			expect(s.chain).toEqual([{ label: 'LFPL → LFPK', alternate: false }]);
			expect(s.dropped).toEqual(['NOPE']);
		}
	});

	it('a route falling under two waypoints goes empty, dropped explains why', () => {
		const yaml = [
			'version: 1',
			'routes:',
			'  - waypoints:',
			'      - ident: LFPL',
			'      - ident: NOPE',
			'',
		].join('\n');
		expect(derivePlanRow(yaml, resolve, 2026.0)).toEqual({
			name: null,
			// No name and no chain: the subject field falls away and the
			// download is a bare "plan.yaml".
			baseName: '',
			state: { kind: 'empty', dropped: ['NOPE'] },
		});
	});

	it('an unparseable text reports the parser line', () => {
		const s = derivePlanRow('version: 9\nroutes: []\n', resolve, 2026.0).state;
		expect(s.kind).toBe('error');
		if (s.kind === 'error') {
			expect(s.detail).toContain('Invalid route file');
		}
	});
});

describe('nextPlanName', () => {
	it('appends .yaml to a free base and suffixes a taken one before the extension', () => {
		expect(nextPlanName('LFPL-LFOX', [])).toBe('LFPL-LFOX.yaml');
		expect(nextPlanName('LFPL-LFOX', ['LFPL-LFOX.yaml'])).toBe('LFPL-LFOX-2.yaml');
		expect(
			nextPlanName('LFPL-LFOX', ['LFPL-LFOX.yaml', 'LFPL-LFOX-2.yaml']),
		).toBe('LFPL-LFOX-3.yaml');
	});

	it('compares case-insensitively across extension variants', () => {
		// The importer keys by the picked file's FULL name; .yml and case
		// variants must still collide (the put-by-name replace hazard).
		expect(nextPlanName('LFPL-LFOX', ['lfpl-lfox.YML'])).toBe('LFPL-LFOX-2.yaml');
		expect(nextPlanName('lfpl-lfox.yaml', ['LFPL-LFOX.yaml'])).toBe('lfpl-lfox-2.yaml');
	});

	it('ignores unrelated names', () => {
		expect(nextPlanName('LFPL-LFOX', ['LFPL-LFPU.yaml', 'brienne.yaml'])).toBe(
			'LFPL-LFOX.yaml',
		);
	});
});

describe('planPreviewLines', () => {
	it('yields one lat/lon line per usable route, alternates included', () => {
		const yaml = [
			'version: 1',
			'routes:',
			'  - waypoints:',
			'      - ident: LFPL',
			'      - ident: LFPK',
			'  - role: alternate',
			'    waypoints:',
			'      - ident: LFPK',
			'      - ident: LFPL',
			'',
		].join('\n');
		expect(planPreviewLines(yaml, resolve, 2026.0)).toEqual([
			[
				[48.6, 2.62],
				[48.84, 3.01],
			],
			[
				[48.84, 3.01],
				[48.6, 2.62],
			],
		]);
	});

	it('drops sub-two-waypoint routes and previews nothing for broken yaml', () => {
		const yaml = [
			'version: 1',
			'routes:',
			'  - waypoints:',
			'      - ident: LFPL',
			'      - ident: ZZZZ9',
			'',
		].join('\n');
		// The unresolved ident drops; one waypoint left = no usable route.
		expect(planPreviewLines(yaml, resolve, 2026.0)).toEqual([]);
		expect(planPreviewLines('version: 9\nroutes: []\n', resolve, 2026.0)).toEqual([]);
	});
});
