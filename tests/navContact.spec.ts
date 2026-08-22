/* Unit tests for the pure enroute-contact core: the contact predicate
 * (enrouteRelevant), the contactable-span reconstruction (buildContactSpans),
 * the tiered current/next resolution (contactStateAt) and the chain that
 * brackets it with the two aerodromes (contactChainAt), behind the
 * navigation-mode contact display. */

import { describe, it, expect } from 'vitest';
import {
	enrouteRelevant,
	buildContactSpans,
	closedContactSpans,
	contactEnterRowIdx,
	contactLeaveRowIdx,
	contactStateAt,
	type RouteAirspaceEvent,
} from '$lib/route/airspaces';
import {
	contactChainAt,
	DEPARTURE_HANDOVER_NM,
	handoverDue,
	HANDOVER_LEAD_MIN,
	HANDOVER_LEAD_NM,
	type NavContactUnit,
} from '$lib/nav/contactChain';
import type { AirspaceRadio } from '$lib/data/airspaces';

const TWR: AirspaceRadio[] = [{ freq: '120.500', unit: 'TWR', call: 'TEST Tower' }];
const FIS: AirspaceRadio[] = [{ freq: '135.225', unit: 'FIS', call: 'SEINE Info' }];

function ev(
	kind: 'enter' | 'leave',
	atNM: number,
	key: string,
	over: Partial<RouteAirspaceEvent> = {},
): RouteAirspaceEvent {
	return {
		kind,
		atNM,
		eteMin: null,
		key,
		name: key,
		type: 'CTR',
		airClass: 'D',
		category: 'controlled',
		vLower: null,
		vUpper: null,
		radio: TWR,
		...over,
	};
}

const SIV: Partial<RouteAirspaceEvent> = {
	type: 'SIV',
	airClass: '',
	category: 'siv',
	radio: FIS,
};
const RMZ: Partial<RouteAirspaceEvent> = { type: 'RMZ', airClass: 'G' };
/** The FIR-level FIS blanket: same category as a SIV, ranked under it. */
const FIC: Partial<RouteAirspaceEvent> = {
	type: 'FIC',
	airClass: '',
	category: 'siv',
	radio: [{ freq: '126.100', unit: 'FIS', call: 'PARIS Info' }],
};

describe('enrouteRelevant', () => {
	it('keeps SIV, RMZ / TMZ-RMZ and class B/C/D under any flight rules', () => {
		expect(enrouteRelevant(ev('enter', 0, 'S', SIV), false)).toBe(true);
		expect(enrouteRelevant(ev('enter', 0, 'R', RMZ), false)).toBe(true);
		expect(enrouteRelevant(ev('enter', 0, 'R', { type: 'TMZ-RMZ', airClass: 'G' }), false)).toBe(
			true,
		);
		for (const c of ['B', 'C', 'D']) {
			expect(enrouteRelevant(ev('enter', 0, c, { airClass: c }), false)).toBe(true);
		}
	});

	it('keeps class A and E only under IFR', () => {
		for (const c of ['A', 'E']) {
			expect(enrouteRelevant(ev('enter', 0, c, { airClass: c }), false)).toBe(false);
			expect(enrouteRelevant(ev('enter', 0, c, { airClass: c }), true)).toBe(true);
		}
	});

	// A controlled volume that publishes a frequency but no class: the
	// class is the gap, not the contact, and the nav log used to drop
	// the channel while the detail panel went on showing it.
	it('keeps a classless controlled volume that publishes a frequency', () => {
		expect(
			enrouteRelevant(ev('enter', 0, 'X', { type: 'CTA', airClass: '', category: 'controlled' }), false),
		).toBe(true);
		// ... but not one with nothing to call.
		expect(
			enrouteRelevant(
				ev('enter', 0, 'X', { type: 'CTA', airClass: '', category: 'controlled', radio: [] }),
				false,
			),
		).toBe(false);
		// ... and not a restricted area, whose frequency is a permission
		// to ask for, not an enroute contact.
		expect(
			enrouteRelevant(ev('enter', 0, 'R1', { type: 'R', airClass: '', category: 'restricted' }), false),
		).toBe(false);
	});

	it('excludes class G, R zones and plain TMZ', () => {
		expect(enrouteRelevant(ev('enter', 0, 'G', { type: 'TMA', airClass: 'G' }), false)).toBe(false);
		expect(
			enrouteRelevant(
				ev('enter', 0, 'LFR1', { type: 'R', airClass: '', category: 'restricted' }),
				false,
			),
		).toBe(false);
		expect(enrouteRelevant(ev('enter', 0, 'T', { type: 'TMZ', airClass: 'G' }), false)).toBe(false);
	});
});

describe('buildContactSpans', () => {
	it('drops events without a usable frequency, ignoring their leaves', () => {
		const spans = buildContactSpans(
			[
				ev('enter', 0, 'A', { radio: [] }),
				ev('enter', 5, 'B', { radio: [{ freq: '', unit: 'TWR', call: '' }] }),
				ev('enter', 10, 'C', { radio: [{ freq: '   ', unit: 'TWR', call: '' }] }),
				ev('enter', 15, 'D'),
				ev('leave', 20, 'A'),
				ev('leave', 25, 'D'),
			],
			false,
		);
		expect(spans).toHaveLength(1);
		expect(spans[0].ev.key).toBe('D');
		expect(spans[0].enterNM).toBe(15);
		expect(spans[0].leaveNM).toBe(25);
	});

	it('drops non-contact airspaces even with a frequency (R zone under VFR)', () => {
		const spans = buildContactSpans(
			[ev('enter', 0, 'LFR45', { type: 'R', airClass: '', category: 'restricted' })],
			false,
		);
		expect(spans).toHaveLength(0);
	});

	it('rides the flight rules for class E', () => {
		const sched = [ev('enter', 0, 'E', { type: 'TMA', airClass: 'E' })];
		expect(buildContactSpans(sched, false)).toHaveLength(0);
		expect(buildContactSpans(sched, true)).toHaveLength(1);
	});

	it('leaves a never-left span open to Infinity', () => {
		const spans = buildContactSpans([ev('enter', 5, 'K')], false);
		expect(spans).toHaveLength(1);
		expect(spans[0].enterNM).toBe(5);
		expect(spans[0].leaveNM).toBe(Infinity);
		expect(spans[0].ev.key).toBe('K');
	});

	it('yields one span per re-entry', () => {
		const spans = buildContactSpans(
			[ev('enter', 0, 'K'), ev('leave', 10, 'K'), ev('enter', 20, 'K')],
			false,
		);
		expect(spans.map((s) => [s.enterNM, s.leaveNM])).toEqual([
			[0, 10],
			[20, Infinity],
		]);
	});
});

describe('service closures in the contact resolution', () => {
	// The real shape: SIV BEAUVAIS 2's only frequency withdrawn by NOTAM, the
	// FIC PARIS NORD blanket underneath (docs/notam-relationships.md).
	const CLOSED_SIV = {
		type: 'SIV',
		airClass: '',
		category: 'siv' as const,
		radio: [{ freq: '119.8', unit: 'LFOB BEAUVAIS', call: 'BEAUVAIS - INFORMATION', closed: true }],
	};
	const FIC = {
		type: 'FIC',
		airClass: '',
		category: 'siv' as const,
		radio: [{ freq: '125.700', unit: 'FIS', call: 'PARIS - INFORMATION' }],
	};

	it('a sector whose every frequency is withdrawn has no contact span', () => {
		const sched = [ev('enter', 10, 'SIV2', CLOSED_SIV), ev('leave', 30, 'SIV2')];
		expect(buildContactSpans(sched, false)).toHaveLength(0);
	});

	it('a mixed unit keeps its span on the open row', () => {
		const mixed = {
			...CLOSED_SIV,
			radio: [...CLOSED_SIV.radio, { freq: '123.985', unit: 'APP', call: 'BEAUVAIS - APPROCHE' }],
		};
		expect(buildContactSpans([ev('enter', 10, 'SIV', mixed)], false)).toHaveLength(1);
	});

	it('the FIC underneath answers across the closed stretch', () => {
		const spans = buildContactSpans(
			[
				ev('enter', 0, 'FIC', FIC),
				ev('enter', 10, 'SIV2', CLOSED_SIV),
				ev('leave', 30, 'SIV2'),
				ev('leave', 50, 'FIC'),
			],
			false,
		);
		// Inside the closed sector the resolution reads the FIC, and the next
		// change is the FIC's own leave: there IS no frequency change at the
		// closed sector's boundary.
		const st = contactStateAt(spans, 15);
		expect(st.current?.ev.key).toBe('FIC');
		expect(st.boundaryNM).toBe(50);
	});

	it('closedContactSpans returns exactly the closure-dropped spans', () => {
		const sched = [
			ev('enter', 0, 'FIC', FIC),
			ev('enter', 10, 'SIV2', CLOSED_SIV),
			ev('leave', 30, 'SIV2'),
			// A radio-less airspace was never a contact: not "closure-dropped".
			ev('enter', 12, 'MUTE', { ...CLOSED_SIV, radio: [] }),
			ev('leave', 50, 'FIC'),
		];
		const dropped = closedContactSpans(sched, false);
		expect(dropped.map((s) => [s.ev.key, s.enterNM, s.leaveNM])).toEqual([['SIV2', 10, 30]]);
	});
});

describe('contactStateAt', () => {
	// SIV S covers the whole route, CTR C nested at 40-60 NM.
	const nested = buildContactSpans(
		[
			ev('enter', 0, 'S', SIV),
			ev('enter', 40, 'C'),
			ev('leave', 60, 'C'),
			ev('leave', 100, 'S'),
		],
		false,
	);

	it('resolves the enclosing SIV before the CTR, the CTR inside it', () => {
		expect(contactStateAt(nested, 20)).toMatchObject({
			current: { ev: { key: 'S' } },
			next: { ev: { key: 'C' } },
			boundaryNM: 40,
		});
		// Enter edge inclusive, leave edge exclusive.
		expect(contactStateAt(nested, 40).current?.ev.key).toBe('C');
		expect(contactStateAt(nested, 60).current?.ev.key).toBe('S');
	});

	it('falls back to the still-open SIV after the CTR (stack semantics)', () => {
		expect(contactStateAt(nested, 50)).toMatchObject({
			current: { ev: { key: 'C' } },
			next: { ev: { key: 'S' } },
			boundaryNM: 60,
		});
	});

	it('reports the end of the last contact with a null next', () => {
		expect(contactStateAt(nested, 70)).toMatchObject({
			current: { ev: { key: 'S' } },
			next: null,
			boundaryNM: 100,
		});
		expect(contactStateAt(nested, 100)).toEqual({ current: null, next: null, boundaryNM: null, handover: null });
	});

	it('hands the contact back at the leave, never at an enter far behind', () => {
		// Inside the CTR the handover is its own enter; back on the SIV it is the
		// CTR's LEAVE, not the SIV's enter 60 NM up the route, so the schedule's
		// highlight walks down the table with the flight.
		expect(contactStateAt(nested, 20).handover).toMatchObject({
			kind: 'enter',
			span: { ev: { key: 'S' } },
		});
		expect(contactStateAt(nested, 50).handover).toMatchObject({
			kind: 'enter',
			span: { ev: { key: 'C' } },
		});
		expect(contactStateAt(nested, 70).handover).toMatchObject({
			kind: 'leave',
			span: { ev: { key: 'C' } },
		});
		// Never backwards along the route.
		let prev = -Infinity;
		for (let d = 0; d < 100; d++) {
			const h = contactStateAt(nested, d).handover;
			const at = h ? (h.kind === 'leave' ? h.span.leaveNM : h.span.enterNM) : -Infinity;
			expect(at).toBeGreaterThanOrEqual(prev);
			prev = at;
		}
	});

	it('hides a SIV sector handover underneath a CTR', () => {
		const spans = buildContactSpans(
			[
				ev('enter', 0, 'S1', SIV),
				ev('enter', 40, 'C'),
				ev('leave', 50, 'S1'),
				ev('enter', 50, 'S2', SIV),
				ev('leave', 60, 'C'),
				ev('leave', 100, 'S2'),
			],
			false,
		);
		// Inside the CTR the sector boundary at 50 does not change the contact;
		// the next change is the CTR exit, handing off to the NEW sector.
		expect(contactStateAt(spans, 45)).toMatchObject({
			current: { ev: { key: 'C' } },
			next: { ev: { key: 'S2' } },
			boundaryNM: 60,
		});
		// Outside the CTR the same boundary IS the handover.
		const open = buildContactSpans(
			[
				ev('enter', 0, 'S1', SIV),
				ev('leave', 50, 'S1'),
				ev('enter', 50, 'S2', SIV),
				ev('leave', 100, 'S2'),
			],
			false,
		);
		expect(contactStateAt(open, 30)).toMatchObject({
			next: { ev: { key: 'S2' } },
			boundaryNM: 50,
		});
	});

	it('ranks an APP SIV above the FIR-level FIS blanket', () => {
		// PARIS Information (FIC, the FIR-wide blanket) and SIV SEINE 4 both from
		// 0 NM, the FIC sector boundary first: without the FIS rank the nesting
		// tiebreak would hand the flight the FIC while the nav log lists the SIV.
		const spans = buildContactSpans(
			[
				ev('enter', 0, 'FIC', FIC),
				ev('enter', 0, 'S', SIV),
				ev('leave', 15, 'FIC'),
				ev('enter', 15, 'FIC2', FIC),
				ev('leave', 40, 'S'),
				ev('leave', 100, 'FIC2'),
			],
			false,
		);
		expect(contactStateAt(spans, 5).current?.ev.key).toBe('S');
		expect(contactStateAt(spans, 20).current?.ev.key).toBe('S');
		// The blanket takes over once the SIV ends, and THAT leave is the
		// handover: "leaving SEINE 4, back to PARIS Information".
		expect(contactStateAt(spans, 50)).toMatchObject({
			current: { ev: { key: 'FIC2' } },
			handover: { kind: 'leave', span: { ev: { key: 'S' } } },
		});
	});

	it('ranks an RMZ above the FIS watch', () => {
		const spans = buildContactSpans(
			[
				ev('enter', 0, 'S', SIV),
				ev('enter', 20, 'R', RMZ),
				ev('leave', 40, 'R'),
				ev('leave', 100, 'S'),
			],
			false,
		);
		expect(contactStateAt(spans, 10)).toMatchObject({
			current: { ev: { key: 'S' } },
			next: { ev: { key: 'R' } },
			boundaryNM: 20,
		});
		expect(contactStateAt(spans, 30)).toMatchObject({
			current: { ev: { key: 'R' } },
			next: { ev: { key: 'S' } },
			boundaryNM: 40,
		});
	});

	it('picks the innermost of same-start nested spans', () => {
		const spans = buildContactSpans(
			[
				ev('enter', 10, 'TMA', { type: 'TMA' }),
				ev('enter', 10, 'CTR'),
				ev('leave', 30, 'CTR'),
				ev('leave', 90, 'TMA'),
			],
			false,
		);
		expect(contactStateAt(spans, 20).current?.ev.key).toBe('CTR');
		expect(contactStateAt(spans, 40).current?.ev.key).toBe('TMA');
	});

	it('handles a gap and a position before the first span', () => {
		const spans = buildContactSpans(
			[
				ev('enter', 10, 'S1', SIV),
				ev('leave', 30, 'S1'),
				ev('enter', 50, 'S2', SIV),
				ev('leave', 80, 'S2'),
			],
			false,
		);
		expect(contactStateAt(spans, 5)).toMatchObject({
			current: null,
			next: { ev: { key: 'S1' } },
			boundaryNM: 10,
		});
		expect(contactStateAt(spans, 40)).toMatchObject({
			current: null,
			next: { ev: { key: 'S2' } },
			boundaryNM: 50,
		});
	});

	it('contains the route end when the flight ends inside a span', () => {
		const spans = buildContactSpans([ev('enter', 40, 'C')], false);
		expect(contactStateAt(spans, 100).current?.ev.key).toBe('C');
	});

	it('is all-null with no spans', () => {
		expect(contactStateAt([], 5)).toEqual({ current: null, next: null, boundaryNM: null, handover: null });
	});
});

describe('contact schedule row lookup', () => {
	it('finds the enter row by identity and the leave row by value', () => {
		const schedule = [
			ev('enter', 0, 'SIV', SIV),
			ev('enter', 10, 'CTR'),
			ev('leave', 20, 'CTR'),
			ev('leave', 30, 'SIV', SIV),
		];
		const spans = buildContactSpans(schedule, false);
		expect(contactEnterRowIdx(schedule, spans[0])).toBe(0);
		expect(contactEnterRowIdx(schedule, spans[1])).toBe(1);
		expect(contactLeaveRowIdx(schedule, spans[1])).toBe(2);
		expect(contactLeaveRowIdx(schedule, spans[0])).toBe(3);
	});

	it('disambiguates a re-entry by the span leave distance', () => {
		const schedule = [
			ev('enter', 0, 'CTR'),
			ev('leave', 5, 'CTR'),
			ev('enter', 10, 'CTR'),
			ev('leave', 15, 'CTR'),
		];
		const spans = buildContactSpans(schedule, false);
		expect(spans).toHaveLength(2);
		expect(contactEnterRowIdx(schedule, spans[1])).toBe(2);
		expect(contactLeaveRowIdx(schedule, spans[0])).toBe(1);
		expect(contactLeaveRowIdx(schedule, spans[1])).toBe(3);
	});

	it('yields null for an open span and a foreign schedule', () => {
		const schedule = [ev('enter', 0, 'CTR')];
		const spans = buildContactSpans(schedule, false);
		expect(contactLeaveRowIdx(schedule, spans[0])).toBeNull();
		expect(contactEnterRowIdx([], spans[0])).toBeNull();
	});
});

describe('contactChainAt', () => {
	const unit = (kind: 'airspace' | 'aerodrome', label: string): NavContactUnit => ({
		kind,
		key: kind === 'airspace' ? label : null,
		label,
		radio: kind === 'airspace' ? FIS : TWR,
		ident: kind === 'aerodrome' ? label : null,
		freqFlagged: false,
	});
	const LFPL = unit('aerodrome', 'LFPL LOGNES');
	const LFPN = unit('aerodrome', 'LFPN TOUSSUS');
	const FIC = unit('airspace', 'FIC PARIS SUD');
	const SIV = unit('airspace', 'SIV SEINE 1');
	const CTR = unit('airspace', 'CTR MELUN');
	const base = {
		airCurrent: FIC,
		airNext: SIV,
		currentTier: 0,
		departure: LFPL,
		destination: LFPN,
		distNM: 0,
		boundaryNM: 32,
		remainingNM: 100,
		arrived: false,
	};

	it('gives the departure field the contact on the ground, the FIS watch next', () => {
		const c = contactChainAt(base);
		expect(c.current).toBe(LFPL);
		expect(c.next).toBe(FIC);
		// Leaving the field is the pilot's call, not a boundary.
		expect(c.toBoundaryNM).toBeNull();
	});

	it('keeps the field to DEPARTURE_HANDOVER_NM, then hands over', () => {
		const rolling = contactChainAt({ ...base, distNM: 2 });
		expect(rolling.current).toBe(LFPL);
		const clear = contactChainAt({ ...base, distNM: DEPARTURE_HANDOVER_NM });
		expect(clear.current).toBe(FIC);
		expect(clear.next).toBe(SIV);
		expect(clear.toBoundaryNM).toBe(32);
	});

	it('lets a unit above the FIS watch pre-empt the field', () => {
		// A field inside a CTR: the tower IS the first airspace contact.
		const c = contactChainAt({ ...base, airCurrent: CTR, currentTier: 2, distNM: 0.5 });
		expect(c.current).toBe(CTR);
	});

	it('makes the destination field the last unit to call', () => {
		const c = contactChainAt({
			...base,
			distNM: 90,
			airNext: null,
			boundaryNM: null,
			remainingNM: 8.8,
		});
		expect(c.current).toBe(FIC);
		expect(c.next).toBe(LFPN);
		expect(c.toBoundaryNM).toBe(8.8);
	});

	it('holds the destination field once arrived, with nothing after it', () => {
		const c = contactChainAt({ ...base, arrived: true, distNM: 100 });
		expect(c.current).toBe(LFPN);
		expect(c.next).toBeNull();
		expect(c.toBoundaryNM).toBeNull();
	});

	it('briefs the two fields without a position', () => {
		const c = contactChainAt({
			...base,
			airCurrent: null,
			airNext: null,
			currentTier: -1,
			distNM: null,
			boundaryNM: null,
			remainingNM: null,
		});
		expect(c.current).toBe(LFPL);
		expect(c.next).toBe(LFPN);
	});

	it('hands over by position even when no takeoff was ever detected', () => {
		// A trace that starts in the air never commits a takeoff; keying the
		// hold on that stamp would leave the field as the contact all flight.
		const c = contactChainAt({ ...base, distNM: 50 });
		expect(c.current).toBe(FIC);
	});

	it('falls back to the airspace units alone when the fields are unknown', () => {
		const c = contactChainAt({
			...base,
			departure: null,
			destination: null,
			distNM: 50,
		});
		expect(c.current).toBe(FIC);
		expect(c.next).toBe(SIV);
	});
});

describe('handoverDue', () => {
	// The phone band raises its transient next-contact line off this rule, so
	// what it answers is what a pilot is told about the call to make.
	it('opens the window on the ETE, inclusive of the lead itself', () => {
		expect(handoverDue(12, HANDOVER_LEAD_MIN)).toBe(true);
		expect(handoverDue(12, HANDOVER_LEAD_MIN - 0.5)).toBe(true);
		expect(handoverDue(12, HANDOVER_LEAD_MIN + 0.5)).toBe(false);
	});

	it('opens on the ETE alone when the distance is still long', () => {
		// 40 NM out but two minutes away (a fast leg): the call is due, and
		// the distance clause on its own would have stayed silent.
		expect(handoverDue(40, 2)).toBe(true);
	});

	it('opens on the distance alone however slow the aircraft is', () => {
		// The measured regression: slowing for the approach pushes the ETE
		// back up through the lead while the distance keeps closing, and a
		// time-only rule shut the window mid-arrival and reopened it. Close
		// is close.
		expect(handoverDue(1, HANDOVER_LEAD_MIN + 10)).toBe(true);
		expect(handoverDue(HANDOVER_LEAD_NM, null)).toBe(true);
		expect(handoverDue(HANDOVER_LEAD_NM + 0.1, null)).toBe(false);
	});

	it('cannot re-shut on a ground-speed wobble once inside the lead', () => {
		// Distance decreases monotonically along the route, so a window opened
		// by the distance clause stays open whatever the ETE does: no latch,
		// no history, and a scrubbed replay still renders from the instant.
		for (const ete of [4, 6, 4.5, 9, 5.5]) {
			expect(handoverDue(HANDOVER_LEAD_NM - 1, ete)).toBe(true);
		}
	});

	it('stays shut with no lead figure at all', () => {
		// Leaving the departure field has no boundary distance: the handover
		// happens when the pilot is clear of the circuit, not at a line, so
		// there is no countdown and the line would stand for the whole
		// departure phase instead of marking an event.
		expect(handoverDue(null, null)).toBe(false);
	});

	it('holds through the crossing itself', () => {
		// The chain swaps current/next at the boundary; until it does, zero
		// distance must not read as "no handover coming".
		expect(handoverDue(0, 0)).toBe(true);
	});
});
