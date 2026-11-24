/* The pilot doc's MEP date through the sync adapters (sync/adapters.ts,
 * docs/accounts-sync.md "pilot, the MEP date"): listed only when set, so a
 * pilot without one pushes the payload an app from before it pushed;
 * applied from a remote doc carrying it; and the accepted residual, a doc an
 * older app rebuilt without it, clearing it. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { memoryStorage } from './helpers/storage';
import type { WireDoc } from '$lib/sync/model';

// The adapters reach Leaflet through the flight import (fitRoute ->
// map/focus), which needs a window to evaluate; nothing here draws.
vi.mock('leaflet', () => ({ default: {} }));

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('localStorage', memoryStorage());
	vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function listedPilot(): Promise<string | null> {
	const { listLocalDocs } = await import('$lib/sync/adapters');
	const docs = await listLocalDocs(() => undefined);
	return docs.find((d) => d.col === 'pilot')?.payloadText ?? null;
}

function remotePilot(payloadText: string): { doc: WireDoc; payloadText: string } {
	return {
		doc: {
			col: 'pilot',
			id: 'pilot',
			rev: 2,
			seq: 7,
			deleted: false,
			updatedAt: 1,
			device: 'other',
			hash: 'h',
			meta: {},
		},
		payloadText,
	};
}

describe("the pilot doc's MEP date", () => {
	it('is listed only when set', async () => {
		const prep = await import('$lib/state/flightPrep.svelte');
		prep.setDossierPilot({ name: 'A', medicalValidUntil: '2027-01-01' });
		expect(await listedPilot()).toBe('{"medicalValidUntil":"2027-01-01","name":"A","sepValidUntil":null}');
		prep.setDossierPilot({ mepValidUntil: '2027-04-30' });
		expect(await listedPilot()).toBe(
			'{"medicalValidUntil":"2027-01-01","mepValidUntil":"2027-04-30","name":"A","sepValidUntil":null}',
		);
	});

	it('is applied from a remote doc, and cleared by one an older app rebuilt without it', async () => {
		const { applyWireDoc } = await import('$lib/sync/adapters');
		const { flightPrep } = await import('$lib/state/flightPrep.svelte');
		await applyWireDoc(
			remotePilot('{"medicalValidUntil":null,"mepValidUntil":"2027-04-30","name":"A","sepValidUntil":null}'),
		);
		expect(flightPrep.dossier.pilot).toEqual({
			name: 'A',
			sepValidUntil: null,
			medicalValidUntil: null,
			mepValidUntil: '2027-04-30',
		});
		// A pilot holding nothing but the MEP date is still a document.
		expect(await listedPilot()).not.toBeNull();
		await applyWireDoc(remotePilot('{"medicalValidUntil":null,"name":"A","sepValidUntil":null}'));
		expect(flightPrep.dossier.pilot.mepValidUntil).toBeNull();
	});
});
