/* Pins the pilot-block extraction (docs/accounts-sync.md): the identity
 * fields live under their own `loxodrome:pilot` key (the sync layer's
 * `pilot` doc), the legacy in-blob copy migrates once at module init,
 * the stored key wins over a stale legacy copy, and the flight-prep blob
 * sheds the block at its next persist so the two stores can never
 * disagree. The module is re-imported per case (the flightsDb.spec
 * idiom), since the migration runs at evaluation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PILOT_KEY = 'loxodrome:pilot';
const PREP_KEY = 'loxodrome:flight-prep';

function workingStorage(): Storage {
	const store = new Map<string, string>();
	return {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	} as unknown as Storage;
}

async function importPrep() {
	return import('$lib/state/flightPrep.svelte');
}

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('localStorage', workingStorage());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function legacyBlob(pilot: { name: string; sepValidUntil: string | null; medicalValidUntil: string | null }) {
	return JSON.stringify({
		v: 1,
		fuel: { trips: [] },
		mb: { loads: {}, fuelMode: 'full', customLitres: null },
		perf: { byIcao: {}, manualIcaos: [] },
		dossier: {
			flightDate: null,
			departureTime: null,
			stopsMin: [],
			pilot,
			potentialMin: null,
			qnhHpa: null,
			checks: {},
		},
	});
}

describe('the pilot store', () => {
	it('migrates a legacy in-blob pilot to its own key, once', async () => {
		localStorage.setItem(
			PREP_KEY,
			legacyBlob({ name: 'A. Pilot', sepValidUntil: '2027-03-01', medicalValidUntil: null }),
		);
		const { flightPrep } = await importPrep();
		expect(flightPrep.dossier.pilot.name).toBe('A. Pilot');
		expect(JSON.parse(localStorage.getItem(PILOT_KEY)!)).toEqual({
			name: 'A. Pilot',
			sepValidUntil: '2027-03-01',
			medicalValidUntil: null,
		});
	});

	it('does not mint the key for an all-default pilot', async () => {
		await importPrep();
		expect(localStorage.getItem(PILOT_KEY)).toBeNull();
	});

	it('prefers the stored key over a stale legacy copy', async () => {
		localStorage.setItem(
			PREP_KEY,
			legacyBlob({ name: 'Old Name', sepValidUntil: null, medicalValidUntil: null }),
		);
		localStorage.setItem(
			PILOT_KEY,
			JSON.stringify({ name: 'New Name', sepValidUntil: null, medicalValidUntil: '2028-01-01' }),
		);
		const { flightPrep } = await importPrep();
		expect(flightPrep.dossier.pilot.name).toBe('New Name');
		expect(flightPrep.dossier.pilot.medicalValidUntil).toBe('2028-01-01');
	});

	it('writes pilot edits to the key and sheds the block from the blob', async () => {
		const { setDossierPilot, setTripFuel } = await importPrep();
		setDossierPilot({ name: 'B. Pilot' });
		const pilot = JSON.parse(localStorage.getItem(PILOT_KEY)!) as { name: string };
		expect(pilot.name).toBe('B. Pilot');
		// Any other prep write re-persists the blob WITHOUT a pilot block.
		setTripFuel(0, { taxiMin: 5 });
		const blob = JSON.parse(localStorage.getItem(PREP_KEY)!) as {
			dossier?: { pilot?: unknown };
		};
		expect(blob.dossier?.pilot).toBeUndefined();
	});

	it('edits the block as stored, not this tab\'s older copy of it', async () => {
		localStorage.setItem(PILOT_KEY, JSON.stringify({ name: 'CLUB PC', sepValidUntil: '2027-05-31', medicalValidUntil: null }));
		const { flightPrep, setDossierPilot } = await importPrep();
		expect(flightPrep.dossier.pilot.name).toBe('CLUB PC');
		// Another tab's shared sign-in sets that block aside meanwhile.
		localStorage.setItem(PILOT_KEY, JSON.stringify({ name: '', sepValidUntil: null, medicalValidUntil: null }));
		setDossierPilot({ name: 'BOB BAKER' });
		// The other pilot's SEP date does not come back with the edit.
		expect(JSON.parse(localStorage.getItem(PILOT_KEY)!)).toEqual({
			name: 'BOB BAKER',
			sepValidUntil: null,
			medicalValidUntil: null,
		});
		expect(flightPrep.dossier.pilot.sepValidUntil).toBeNull();
	});

	it('lets no file state the pilot block on a shared computer', async () => {
		const mine = JSON.stringify({ name: 'BOB BAKER', sepValidUntil: null, medicalValidUntil: '2027-01-31' });
		localStorage.setItem(PILOT_KEY, mine);
		localStorage.setItem('loxodrome:shared-session', '1');
		const { applyLoadedFlightPrep, flightPrep } = await importPrep();
		// A plan another pilot stored on the club PC, their details in it.
		applyLoadedFlightPrep(
			{ dossier: { pilotName: 'ALICE ANDERSON', sepValidUntil: '2026-12-31', medicalValidUntil: '2028-03-31' } },
			[],
		);
		expect(localStorage.getItem(PILOT_KEY)).toBe(mine);
		expect(flightPrep.dossier.pilot).toEqual(JSON.parse(mine));
		// Off a shared computer, a file still states what it carries.
		localStorage.removeItem('loxodrome:shared-session');
		applyLoadedFlightPrep({ dossier: { pilotName: 'ALICE ANDERSON' } }, []);
		expect(flightPrep.dossier.pilot.name).toBe('ALICE ANDERSON');
		expect((JSON.parse(localStorage.getItem(PILOT_KEY)!) as { name: string }).name).toBe('ALICE ANDERSON');
	});
});
