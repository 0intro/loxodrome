import { describe, it, expect } from 'vitest';
import { parseNotams } from '$lib/notam';
import type { Notam } from '$lib/notam';
import type { Airspace } from '$lib/data/airspaces';
import {
	activatedAirspaceIds,
	notamMentionsAirspace,
} from '$lib/state/notamLinks.svelte';

function mkAirspace(id: string, type: string): Airspace {
	return { id, type } as unknown as Airspace;
}

function parseOne(text: string): Notam {
	const notams = parseNotams(text);
	expect(notams.length).toBeGreaterThanOrEqual(1);
	return notams[0];
}

// A French "limits amended" NOTAM (condition CD: deactivated/amended family),
// NOT an activation, citing its zone by designator.
const FR_AMENDMENT = `LFFA-R1234/26
DU: 01 06 2026 00:00 AU: 30 06 2026 23:59
A) LFFF
Q) LFFF / QRRCD / IV / BO / W / 000/050 / 4800N00200E010
E) ZONE REGLEMENTEE LF-R45 LIMITES MODIFIEES.
`;

describe('notamMentionsAirspace', () => {
	it('links a non-activation amendment to the zone it cites', () => {
		const n = parseOne(FR_AMENDMENT);
		expect(activatedAirspaceIds(n)).toEqual([]); // activation tier is silent
		expect(notamMentionsAirspace(n, mkAirspace('LFR45', 'R'))).toBe(true);
		expect(notamMentionsAirspace(n, mkAirspace('LFR46', 'R'))).toBe(false);
	});

	it('also passes activation NOTAMs (panels fold those into Activated by)', () => {
		const n = parseOne(`LFFA-R2112/25
DU: 13 09 2025 00:00 AU: 15 04 2026 23:59
A) LFFE
Q) LFFF / QRRCA / IV / BO / AW / 000/015 / 4904N00220E003
E) ZONE REGLEMENTEE LF-R262 'ENGHIEN' MODIFIEE : HORAIRES H24
`);
		expect(activatedAirspaceIds(n)).toEqual(['LFR262']);
		expect(notamMentionsAirspace(n, mkAirspace('LFR262', 'R'))).toBe(true);
	});

	it('skips citations sitting in a reference / exclusion clause', () => {
		const n = parseOne(`LFFA-R0566/26
DU: 01 06 2026 00:00 AU: 30 06 2026 23:59
A) LFFF
Q) LFFF / QRTCA / IV / BO / W / 000/050 / 4800N00200E010
E) ZRT 'CESA NORD' ACTIVATED. REPLACES THE OVERLAPPING AIRSPACE PARTS,
EXCEPT RESTRICTED AREA LF-R400E.
`);
		expect(notamMentionsAirspace(n, mkAirspace('LFR400E', 'R'))).toBe(false);
	});

	it('gates on the Q-code subject family', () => {
		// A parachute-jumping warning citing a zone is not ABOUT the zone.
		const w = parseOne(`LFFA-W4321/26
DU: 01 06 2026 00:00 AU: 30 06 2026 23:59
A) LFFF
Q) LFFF / QWPLW / IV / BO / W / 000/050 / 4800N00200E010
E) PJE WI LF-R45 LATERAL LIMITS.
`);
		expect(notamMentionsAirspace(w, mkAirspace('LFR45', 'R'))).toBe(false);
	});

	it('matches UK designators across padding and spacing', () => {
		const n = parseOne(`B1234/26 NOTAMN
Q) EGTT / QRDCA / IV / BO / W / 000/050 / 5200N00100W020
A) EGTT
B) 2606010000 C) 2606302359
E) DANGER AREA EG D6A ACTIVE H24.
`);
		expect(notamMentionsAirspace(n, mkAirspace('EGD006A', 'D'))).toBe(true);
		expect(notamMentionsAirspace(n, mkAirspace('EGD006B', 'D'))).toBe(false);
	});

	it('matches Spanish designators only under an ES FIR', () => {
		const es = parseOne(`C1234/26 NOTAMN
Q) LECB / QRRCD / IV / BO / W / 000/050 / 4100N00100E020
A) LECB
B) 2606010000 C) 2606302359
E) AREA LED36 LIMITS AMENDED.
`);
		expect(notamMentionsAirspace(es, mkAirspace('LED36', 'D'))).toBe(true);
		// The same letters under a German FIR are plain English (LED lights).
		const de = parseOne(`D1234/26 NOTAMN
Q) EDGG / QRRCD / IV / BO / W / 000/050 / 5000N00800E020
A) EDGG
B) 2606010000 C) 2606302359
E) LED 36 OBST LIGHTS U/S.
`);
		expect(notamMentionsAirspace(de, mkAirspace('LED36', 'D'))).toBe(false);
	});

	it('never matches rows outside the designator grammar', () => {
		const n = parseOne(FR_AMENDMENT);
		expect(notamMentionsAirspace(n, mkAirspace('LFFF', 'FIR'))).toBe(false);
		expect(notamMentionsAirspace(n, mkAirspace('OCA4521', 'OCA'))).toBe(false);
	});
});
