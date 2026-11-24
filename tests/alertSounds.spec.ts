/* Which figure a pass of drained sound edges plays (nav/alertSounds.ts): ONE,
 * the most urgent of both evaluators' edges, never a medley, and how a
 * persisted-on channel re-arms after a reload. The tones themselves are
 * browser-only and exercised by ear. */

import { afterEach, describe, expect, it, vi } from 'vitest';
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

/* The audio context a reload leaves behind starts suspended, and a browser
 * resumes it only inside a user activation, which a touch grants at its
 * release (pointerup), never at its press. A context the gesture failed to
 * resume is hooked again, so one refused gesture does not silence the rest
 * of the flight. A fake window and AudioContext stand in for the browser;
 * fresh module state per case. */
describe('the re-arm on a gesture', () => {
	let listeners: Map<string, Set<() => void>>;
	let resumes: 'running' | 'suspended';

	class FakeAudioContext {
		state = 'suspended';
		resume(): Promise<void> {
			this.state = resumes;
			return Promise.resolve();
		}
		suspend(): Promise<void> {
			this.state = 'suspended';
			return Promise.resolve();
		}
	}

	async function load(): Promise<typeof import('$lib/nav/alertSounds')> {
		listeners = new Map();
		vi.stubGlobal('AudioContext', FakeAudioContext);
		vi.stubGlobal('window', {
			AudioContext: FakeAudioContext,
			addEventListener: (type: string, fn: () => void) => {
				if (!listeners.has(type)) listeners.set(type, new Set());
				listeners.get(type)!.add(fn);
			},
			removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
		});
		vi.resetModules();
		return import('$lib/nav/alertSounds');
	}

	const hooked = (type: string): number => listeners.get(type)?.size ?? 0;
	const fire = (type: string): void => {
		for (const fn of [...(listeners.get(type) ?? [])]) fn();
	};

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('hooks the release of a touch and a key, never the press', async () => {
		resumes = 'running';
		const m = await load();
		m.armAlertAudioOnGesture();
		expect(hooked('pointerup')).toBe(1);
		expect(hooked('keydown')).toBe(1);
		expect(hooked('pointerdown')).toBe(0);
	});

	it('hooks again while the context stays suspended', async () => {
		resumes = 'suspended';
		const m = await load();
		m.armAlertAudioOnGesture();
		fire('pointerup');
		await Promise.resolve();
		m.armAlertAudioOnGesture();
		expect(hooked('pointerup')).toBe(1);
		expect(hooked('keydown')).toBe(1);
	});

	it('lets go once the context runs', async () => {
		resumes = 'running';
		const m = await load();
		m.armAlertAudioOnGesture();
		fire('pointerup');
		await Promise.resolve();
		m.armAlertAudioOnGesture();
		expect(hooked('pointerup')).toBe(0);
		expect(hooked('keydown')).toBe(0);
	});
});
