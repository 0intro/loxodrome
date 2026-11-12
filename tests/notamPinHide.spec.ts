/* "Hide airport NOTAM markers" hides an on-field pin only where the field's own
 * symbol is DRAWN (pinHeldByAirport). The rule asked whether ANY airport group
 * was on, so a small field's pin went below zoom 8, where the airport layer
 * draws no small field, and a heliport's with the heliports unticked: the
 * NOTAM then stood nowhere on the map. The symbol's own tests are the airport
 * layer's (map/airportVisibility.ts); the state reads the Layers choices. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Airport } from '$lib/data/airports';

const fields = vi.hoisted(
	() =>
		new Map<string, { ident: string; type: string; source: string | null; lat: number; lon: number }>([
			// Reference points from fr-airports.json.
			['LFOB', { ident: 'LFOB', type: 'medium_airport', source: 'fr', lat: 49.45442, lon: 2.11281 }],
			['LFPZ', { ident: 'LFPZ', type: 'small_airport', source: 'fr', lat: 48.81028, lon: 2.07333 }],
		]),
);

vi.mock('$lib/state/data.svelte', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/state/data.svelte')>();
	return {
		...real,
		airportByIdent: (i: string): Airport | null =>
			(fields.get(i.toUpperCase()) as unknown as Airport | undefined) ?? null,
		airportLookup: (i: string) => {
			const a = fields.get(i.toUpperCase());
			return a ? { lat: a.lat, lon: a.lon } : null;
		},
		firIdentSet: () => new Set(['LFFF']),
	};
});

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, String(v)),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
	key: () => null,
	length: 0,
});

const { AIRPORT_KINDS, airportDrawnAt, airportZoomFloor } = await import(
	'$lib/map/airportVisibility'
);
const { parseNotams } = await import('$lib/notam/parser');
const { pinHeldByAirport } = await import('$lib/state/notam.svelte');
const { layers } = await import('$lib/state/layers.svelte');

function parseOne(text: string) {
	const out = parseNotams(text);
	expect(out.length).toBeGreaterThan(0);
	return out[0];
}

/** On Beauvais, a medium field drawn from zoom 6. */
const ON_LFOB = parseOne(`A4380/26 NOTAMN
Q) LFFF/QFFAH/IV/NBO/A/000/999/4927N00206E005
A) LFOB B) 2609010000 C) 2609302359
E) FIREFIGHTING AND RESCUE SERVICE HOURS NOW 0600-1800`);

/** On Saint-Cyr-l’École, a small field drawn from zoom 8. */
const ON_LFPZ = parseOne(`A4381/26 NOTAMN
Q) LFFF/QFAHX/IV/NBO/A/000/999/4849N00204E005
A) LFPZ B) 2609010000 C) 2609302359
E) AD HOURS OF SERVICE AMENDED`);

/** A5453/26's shape: filed under LFOB, pinned on the sector 42.6 NM east. */
const OFF_LFOB = parseOne(`A5453/26 NOTAMN
Q) LFFF/QSEAU/IV/BO/AE/000/085/4924N00312E029
A) LFOB B) 2609010000 C) 2609302359
E) 'BEAUVAIS' INFO FREQ 119.800MHZ NOT AVBL`);

beforeEach(() => {
	for (const g of Object.keys(layers.airportTypes) as (keyof typeof layers.airportTypes)[]) {
		layers.airportTypes[g] = true;
	}
	layers.publisher.fr = true;
});

describe('the airport symbol the layer draws', () => {
	it('is drawn from its kind floor on', () => {
		expect(airportDrawnAt({ type: 'small_airport' }, 7.9, true)).toBe(false);
		expect(airportDrawnAt({ type: 'small_airport' }, 8, true)).toBe(true);
		expect(airportDrawnAt({ type: 'large_airport' }, 5, true)).toBe(true);
		expect(airportDrawnAt({ type: 'large_airport' }, 12, false)).toBe(false);
		expect(airportDrawnAt({ type: 'unheard_of' }, 12, true)).toBe(false);
	});

	it('reads the zoom only through its floors', () => {
		expect([4.9, 5, 5.99, 6, 7.99, 8, 14].map(airportZoomFloor)).toEqual([0, 5, 5, 6, 6, 8, 8]);
		for (const z of [3, 5.5, 6.2, 7.9, 8, 11.4]) {
			for (const type of Object.keys(AIRPORT_KINDS)) {
				expect(airportDrawnAt({ type }, airportZoomFloor(z), true)).toBe(
					airportDrawnAt({ type }, z, true),
				);
			}
		}
	});
});

describe('an on-field pin', () => {
	it('is held by a drawn symbol only', () => {
		expect(pinHeldByAirport(ON_LFOB, airportZoomFloor(5.5))).toBe(false);
		expect(pinHeldByAirport(ON_LFOB, airportZoomFloor(6))).toBe(true);
		// A small field is not drawn at 7, so its pin is all the map has.
		expect(pinHeldByAirport(ON_LFPZ, airportZoomFloor(7))).toBe(false);
		expect(pinHeldByAirport(ON_LFPZ, airportZoomFloor(9))).toBe(true);
	});

	it('shows when its kind or its publisher is unticked', () => {
		layers.airportTypes.airports = false;
		expect(pinHeldByAirport(ON_LFOB, 8)).toBe(false);
		layers.airportTypes.airports = true;
		layers.publisher.fr = false;
		expect(pinHeldByAirport(ON_LFOB, 8)).toBe(false);
	});

	it('never collapses into a field it does not sit on', () => {
		expect(pinHeldByAirport(OFF_LFOB, 12)).toBe(false);
	});
});
