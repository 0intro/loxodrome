/* Pins the one rule behind every frequency the app OFFERS for an aerodrome
 * (contactRadios in $lib/data/airports): a closed field publishes channels
 * and answers on none of them, so the nav log's radio column and its saved
 * snapshot, the live contact chain and the overflown-aerodrome scan all stay
 * empty for it, while the detail panel keeps printing the published rows and
 * the waypoint itself remains perfectly usable. */

import { describe, it, expect } from 'vitest';
import { contactRadios, type Airport, type AirportRadio } from '$lib/data/airports';
import { overflightCandidates } from '$lib/nav/overflight';

const TWR: AirportRadio[] = [{ freq: '119.100', unit: 'TWR', call: 'EE TWR' }];

function ap(ident: string, over: Partial<Airport> = {}): Airport {
	return {
		ident,
		type: 'small_airport',
		name: ident,
		lat: 48,
		lon: 2,
		elevFt: null,
		transitionAltFt: null,
		country: 'FR',
		city: '',
		iata: '',
		runways: [],
		access: null,
		military: false,
		joint: false,
		vfr: true,
		ifr: false,
		radios: TWR,
		source: null,
		charts: [],
		...over,
	};
}

describe('contactRadios', () => {
	it('offers an open field its published rows', () => {
		expect(contactRadios(ap('LFAA'))).toEqual(TWR);
	});

	it('offers nothing for a closed field, however much it publishes', () => {
		// EDCK: the DFS files Köthen abandoned and still carries Langen
		// Information and Koethen Radio on the row.
		expect(contactRadios(ap('EDCK', { type: 'closed' }))).toEqual([]);
	});

	it('offers nothing for an ident the dataset does not know', () => {
		expect(contactRadios(null)).toEqual([]);
		expect(contactRadios(undefined)).toEqual([]);
	});

	it('is the rule the overflight scan applies', () => {
		const open = ap('LFAA');
		const closed = ap('EDCK', { type: 'closed' });
		expect(overflightCandidates([open, closed])).toEqual([open]);
	});
});
