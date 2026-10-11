/* Which figure a pass of drained sound edges plays (nav/alertSounds.ts): ONE,
 * the most urgent of both evaluators' edges, never a medley. The tones
 * themselves are browser-only and exercised by ear. */

import { describe, expect, it } from 'vitest';
import { fireFigure } from '$lib/nav/alertSounds';
import type { AlertFire } from '$lib/nav/airspaceAlert';
import type { TerrainFire } from '$lib/nav/terrainAlert';

const avoid: AlertFire = { key: 'r', action: 'avoid', severity: 'imminent' };
const contact: AlertFire = { key: 'ctr', action: 'clearance', severity: 'imminent' };
const danger: AlertFire = { key: 'd', action: 'caution', severity: 'inside' };
const tWarn: TerrainFire = { kind: 'terrain', level: 'warning' };
const tCaution: TerrainFire = { kind: 'obstacle', level: 'caution' };

function fig(airspace: AlertFire[], terrain: TerrainFire[], caution = false): string | null {
	return fireFigure({ airspace, terrain }, { caution });
}

describe('the figure a pass plays', () => {
	it('puts a terrain warning above every airspace edge', () => {
		expect(fig([avoid, contact], [tWarn])).toBe('terrainWarning');
	});

	it('puts an airspace warning above a terrain caution', () => {
		expect(fig([contact], [tCaution])).toBe('warning');
	});

	it('chimes a terrain caution whatever the caution preference', () => {
		expect(fig([], [tCaution], false)).toBe('terrainCaution');
		expect(fig([danger], [tCaution], true)).toBe('terrainCaution');
	});

	it('chimes an airspace caution only behind its preference', () => {
		expect(fig([danger], [], false)).toBeNull();
		expect(fig([danger], [], true)).toBe('caution');
	});

	it('plays nothing for an empty pass', () => {
		expect(fig([], [], true)).toBeNull();
	});
});
