/* ownerPinOnField: whether the pin a NOTAM would draw sits ON the aerodrome
 * that owns it, which is the question "Hide airport NOTAM markers" means.
 *
 * The pair that makes the rule concrete is real and sits in one fixture, both
 * filed under LFOB: A3345/26 closes the SIV BEAUVAIS 2 sector and pins tens of
 * NM east of the field, A3346/26 is about the field and pins on it. Before the
 * position test, the preference hid both.
 */

import { describe, it, expect } from 'vitest';
import { parseNotams } from '$lib/notam/parser';
import { classifyOwner, ownerPinOnField, ON_FIELD_NM } from '$lib/notam/ownership';
import type { Notam } from '$lib/notam/types';

// LFOB Beauvais-Tille's reference point (fr-airports.json).
const LFOB = { lat: 49.45442, lon: 2.11281 };

const resolvers = {
	isAirport: (i: string) => i === 'LFOB' || i === 'LFPG',
	isFir: (i: string) => i === 'LFFF',
};

function parseOne(text: string): Notam {
	const out = parseNotams(text);
	expect(out.length).toBeGreaterThan(0);
	return out[0];
}

/** A5453/26's own shape: the sector centre, 42.6 NM east of the field. */
const OFF_FIELD = `A5453/26 NOTAMN
Q) LFFF/QSEAU/IV/BO/AE/000/085/4924N00312E029
A) LFOB B) 2609010000 C) 2609302359
E) 'BEAUVAIS' INFO FREQ 119.800MHZ NOT AVBL :
- 'BEAUVAIS' FIS AREA 2 CLOSED`;

/** The ordinary case: the Q-line centre IS the reference point. */
const ON_FIELD = `A4380/26 NOTAMN
Q) LFFF/QFFAH/IV/NBO/A/000/999/4927N00206E005
A) LFOB B) 2609010000 C) 2609302359
E) FIREFIGHTING AND RESCUE SERVICE HOURS NOW 0600-1800`;

/** A parsed position: the NOTAM says where it is, so the pin is never
 *  redundant with the symbol, whatever the distance. */
const WITH_PSN = `P1011/26 NOTAMN
Q) LFEE/QOBCE/IV/M/AE/000/011/4735N00734E001
A) LFOB B) 2603201800 C) 2703191800
E) CRANE OPR PSN : 492722N 0020629E
F) SFC G) 300FT AGL`;

describe('ownerPinOnField', () => {
	it('is false when the Q-line pin is not on the aerodrome', () => {
		const n = parseOne(OFF_FIELD);
		expect(ownerPinOnField(n, classifyOwner(n, resolvers), LFOB)).toBe(false);
	});

	it('is true when the Q-line pin is the aerodrome', () => {
		const n = parseOne(ON_FIELD);
		const owner = classifyOwner(n, resolvers);
		expect(owner).toEqual({ kind: 'aerodrome', ident: 'LFOB' });
		expect(ownerPinOnField(n, owner, LFOB)).toBe(true);
	});

	it('is false for an entry drawn at a parsed position rather than the Q-line', () => {
		const n = parseOne(WITH_PSN);
		// The parser preferred the PSN, so there is no qualifierLine coordinate
		// to judge and nothing the airport symbol could stand in for.
		expect(n.coordinates.some((c) => c.type === 'qualifierLine')).toBe(false);
		expect(ownerPinOnField(n, classifyOwner(n, resolvers), LFOB)).toBe(false);
	});

	it('is false when the owner is a FIR, and when its position is unknown', () => {
		const n = parseOne(ON_FIELD);
		expect(ownerPinOnField(n, { kind: 'fir', firs: ['LFFF'] }, LFOB)).toBe(false);
		expect(ownerPinOnField(n, classifyOwner(n, resolvers), null)).toBe(false);
	});

	it('takes the radius as a distance: a tenth of a mile inside is on the field, outside is not', () => {
		const n = parseOne(ON_FIELD);
		const owner = classifyOwner(n, resolvers);
		const q = n.coordinates.find((c) => c.type === 'qualifierLine');
		expect(q).toBeDefined();
		// One minute of latitude is one NM: just inside and just outside.
		const inside = { lat: q!.lat + (ON_FIELD_NM - 0.1) / 60, lon: q!.lon };
		const outside = { lat: q!.lat + (ON_FIELD_NM + 0.1) / 60, lon: q!.lon };
		expect(ownerPinOnField(n, owner, inside)).toBe(true);
		expect(ownerPinOnField(n, owner, outside)).toBe(false);
	});

	it('reads the same in both languages, the Q-line being language-invariant', () => {
		const fr = parseOne(`A5453/26 NOTAMN
Q) LFFF/QSEAU/IV/BO/AE/000/085/4924N00312E029
A) LFOB B) 2609010000 C) 2609302359
E) FREQUENCE BEAUVAIS INFO 119,8MHZ INDISPONIBLE :
- SIV 2 BEAUVAIS FERME,`);
		const en = parseOne(OFF_FIELD);
		expect(ownerPinOnField(fr, classifyOwner(fr, resolvers), LFOB)).toBe(
			ownerPinOnField(en, classifyOwner(en, resolvers), LFOB),
		);
	});
});
