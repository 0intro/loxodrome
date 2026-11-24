/* An aircraft conflict re-filed as a copy (sync/adapters.ts refileDoc,
 * docs/accounts-sync.md "Conflict rules"). The losing sheet is the one the
 * fleet holds under its own key, which the pass then overwrites with the
 * server's, so it files under "<registration> (2)" and both sheets stay. A
 * pass retried after the refile, before its apply, lands on that same copy
 * instead of minting another. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { memoryStorage } from './helpers/storage';
import type { WireDoc } from '$lib/sync/model';

// The adapters reach Leaflet through the flight import (fitRoute ->
// map/focus), which needs a window to evaluate; nothing here draws.
vi.mock('leaflet', () => ({ default: {} }));

const LOCAL = `version: 1
aircraft: { registration: F-GORQ, type: DR400/120 }
cruise: { speedKt: 98 }
`;
const SERVER = LOCAL.replace('speedKt: 98', 'speedKt: 105');

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('localStorage', memoryStorage());
	vi.stubGlobal('indexedDB', new IDBFactory());
	vi.stubGlobal(
		'fetch',
		vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function serverDoc(): WireDoc {
	return {
		col: 'aircraft',
		id: 'F-GORQ',
		rev: 3,
		seq: 9,
		deleted: false,
		updatedAt: 1,
		device: 'other',
		hash: 'h',
		meta: {},
	};
}

describe('an aircraft conflict copy', () => {
	it('keeps the local sheet beside the server one', async () => {
		const aircraft = await import('$lib/state/aircraft.svelte');
		const { applyWireDoc, refileDoc } = await import('$lib/sync/adapters');
		aircraft.applyRemoteAircraft(LOCAL);
		const mine = aircraft.userPlaneYamls()['F-GORQ'];
		expect(await refileDoc('aircraft', mine, {}, { id: 'F-GORQ', rev: 3 })).toBe('F-GORQ (2)');
		await applyWireDoc({ doc: serverDoc(), payloadText: SERVER });
		expect(aircraft.aircraftByKey('F-GORQ')?.cruise?.speedKt).toBe(105);
		expect(aircraft.aircraftByKey('F-GORQ (2)')?.cruise?.speedKt).toBe(98);
	});

	it('lands a retried refile on the copy already filed', async () => {
		const aircraft = await import('$lib/state/aircraft.svelte');
		const { refileDoc } = await import('$lib/sync/adapters');
		aircraft.applyRemoteAircraft(LOCAL);
		const mine = aircraft.userPlaneYamls()['F-GORQ'];
		expect(await refileDoc('aircraft', mine, {}, { id: 'F-GORQ', rev: 3 })).toBe('F-GORQ (2)');
		expect(await refileDoc('aircraft', mine, {}, { id: 'F-GORQ', rev: 3 })).toBe('F-GORQ (2)');
		expect(Object.keys(aircraft.userPlaneYamls()).sort()).toEqual(['F-GORQ', 'F-GORQ (2)']);
	});

	it('files past a copy holding another sheet', async () => {
		const aircraft = await import('$lib/state/aircraft.svelte');
		const { refileDoc } = await import('$lib/sync/adapters');
		aircraft.applyRemoteAircraft(LOCAL);
		aircraft.applyRemoteAircraft(SERVER.replace('F-GORQ,', 'F-GORQ (2),'));
		const mine = aircraft.userPlaneYamls()['F-GORQ'];
		expect(await refileDoc('aircraft', mine, {}, { id: 'F-GORQ', rev: 3 })).toBe('F-GORQ (3)');
		expect(aircraft.aircraftByKey('F-GORQ (2)')?.cruise?.speedKt).toBe(105);
		expect(aircraft.aircraftByKey('F-GORQ (3)')?.cruise?.speedKt).toBe(98);
	});
});
