/* The account's "Download a copy of my data" holds everything the service
 * holds, and comes back in.
 *
 * The service keeps five collections (sync/model.ts). The flights bundle
 * carried three of them, the plans, the flights and the user's aircraft
 * sheets, and the download reused it as it stood, so the pilot details (a
 * name and the SEP and medical validity dates) and the grade tanked in each
 * aircraft were in the service and not in the copy the privacy text promises.
 * The account's download now adds them as the service's own payloads
 * (files/accountDocs.ts), the Flights surface's export still does not, and
 * the importer restores them where the device holds nothing of its own. */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// The importer asks the Open-with dispatcher for a trace's altitude
// reference, and that module draws on the map; no trace rides here.
vi.mock('$lib/state/openFile.svelte', () => ({
	askTraceDatum: (): Promise<null> => Promise.resolve(null),
}));

import { parseAircraftYaml } from '$lib/aircraft/schema';
import {
	PILOT_MEMBER,
	TANKED_FUEL_MEMBER,
	readPilotDoc,
	readTankedFuelDoc,
} from '$lib/files/accountDocs';
import { detectFileKind } from '$lib/files/detect';
import { buildZipDeflated } from '$lib/files/zip';
import {
	addUserAircraftMany,
	aircraftByKey,
	aircraftState,
	removeUserAircraft,
	setTankedFuel,
} from '$lib/state/aircraft.svelte';
import { buildFlightBundle } from '$lib/state/flightExport';
import { expandPick, flightImport, runImportTexts } from '$lib/state/flightImport.svelte';
import { applyRemotePilot, flightPrep, setDossierPilot } from '$lib/state/flightPrep.svelte';
import { acstatePayload, pilotPayload } from '$lib/sync/model';

const PILOT = { name: 'Jeanne Pilote', sepValidUntil: '2027-03-31', medicalValidUntil: '2027-06-30' };
const EMPTY_PILOT = { name: '', sepValidUntil: null, medicalValidUntil: null };

// A committed sheet taking three grades, re-registered so it is the user's own.
const KEY = 'F-ZZZZ';
const sheet = parseAircraftYaml(
	readFileSync(new URL('../public/data/aircraft/f-gikp.yaml', import.meta.url), 'utf-8').replace(
		'registration: F-GIKP',
		`registration: ${KEY}`,
	),
);

function names(entries: { name: string }[]): string[] {
	return entries.map((e) => e.name);
}

function codes(): string[] {
	return flightImport.notices.map((n) => n.code);
}

describe('the account data download', () => {
	it("reads the service's own payloads back, and nothing else", () => {
		expect(readPilotDoc(pilotPayload(PILOT))).toEqual(PILOT);
		expect(readTankedFuelDoc(acstatePayload({ [KEY]: 'UL91' }))).toEqual({ [KEY]: 'UL91' });
		// Recognised by content, like every file: the name is only a hint.
		for (const name of [PILOT_MEMBER, '', 'document']) {
			expect(detectFileKind(name, pilotPayload(PILOT))).toBe('pilot');
			expect(detectFileKind(name, acstatePayload({ [KEY]: 'UL91' }))).toBe('tankedFuel');
		}
		// Read strictly: anything else is not one of these.
		expect(readPilotDoc('{"name":1,"sepValidUntil":null,"medicalValidUntil":null}')).toBeNull();
		expect(
			readPilotDoc('{"name":"J","sepValidUntil":"31/03/2027","medicalValidUntil":null}'),
		).toBeNull();
		expect(readPilotDoc('{"name":"J","sepValidUntil":null}')).toBeNull();
		expect(readTankedFuelDoc('{"types":{"F-ZZZZ":"UL91"},"v":2}')).toBeNull();
		expect(readTankedFuelDoc('{"types":{"F-ZZZZ":91},"v":1}')).toBeNull();
		expect(readTankedFuelDoc('{"types":["UL91"],"v":1}')).toBeNull();
		expect(detectFileKind('data.json', '{"foo":1}')).toBeNull();
		expect(detectFileKind('data.json', '{"name":"J"')).toBeNull();
	});

	it('carries the pilot details and the tanked grades, which the flights export leaves out', async () => {
		setDossierPilot(PILOT);
		addUserAircraftMany([sheet]);
		setTankedFuel(KEY, 'UL91');

		const account = await buildFlightBundle({ account: true });
		expect(names(account)).toContain(PILOT_MEMBER);
		expect(names(account)).toContain(TANKED_FUEL_MEMBER);
		expect(names(account).some((n) => n.startsWith('aircraft/'))).toBe(true);
		// Byte for byte what the service stores.
		expect(account.find((e) => e.name === PILOT_MEMBER)?.data).toBe(pilotPayload(PILOT));
		expect(account.find((e) => e.name === TANKED_FUEL_MEMBER)?.data).toBe(
			acstatePayload({ [KEY]: 'UL91' }),
		);

		// The Flights surface's export is a library a pilot may hand on.
		const library = await buildFlightBundle();
		expect(names(library)).not.toContain(PILOT_MEMBER);
		expect(names(library)).not.toContain(TANKED_FUEL_MEMBER);
	});

	it('restores them on a device holding none, and never over its own', async () => {
		const zip = await buildZipDeflated(await buildFlightBundle({ account: true }));

		// A fresh device: no pilot details, no such aircraft, no pick.
		applyRemotePilot(EMPTY_PILOT);
		removeUserAircraft(KEY);
		expect(aircraftByKey(KEY)).toBeNull();
		expect(aircraftState.tankedFuel[KEY]).toBeUndefined();

		await runImportTexts(await expandPick('loxodrome_flights.zip', zip));
		expect(flightPrep.dossier.pilot).toEqual(PILOT);
		// The grade names a plane only the same download carries: the sheet
		// has to land first for the grade to have somewhere to go.
		expect(aircraftByKey(KEY)).not.toBeNull();
		expect(aircraftState.tankedFuel[KEY]).toBe('UL91');
		expect(codes()).toContain('pilotRestored');
		expect(flightImport.notices.find((n) => n.code === 'tankedFuelRestored')?.params).toEqual([
			'1',
			'0',
		]);

		// The same download again, over choices this device has since made.
		setDossierPilot({ name: 'Jean Autre' });
		setTankedFuel(KEY, 'SUPER AERO+');
		await runImportTexts(await expandPick('loxodrome_flights.zip', zip));
		expect(flightPrep.dossier.pilot.name).toBe('Jean Autre');
		expect(aircraftState.tankedFuel[KEY]).toBe('SUPER AERO+');
		expect(codes()).toContain('pilotKept');
		expect(flightImport.notices.find((n) => n.code === 'tankedFuelKept')?.params).toEqual(['1']);
		expect(codes()).not.toContain('unsupported');
	});
});
