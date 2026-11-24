/* A zone's state as a panel says it (components/zoneStateText.ts): the
 * state over the viewed time, the reason, the next change, in both
 * languages, times in UTC with the date on another day. */

import { afterEach, describe, expect, it } from 'vitest';
import type { ActivityAnswer } from '$lib/data/activity';
import {
	crossingNoteLines,
	noteLine,
	noteNamedLine,
	notedWord,
	noticeText,
	zoneStateLines,
	type ZoneState,
} from '$lib/components/zoneStateText';
import type { KnownUnit } from '$lib/data/knownFrom';
import { fmtDayMonth, i18n } from '$lib/state/i18n.svelte';
import type { ZoneNote } from '$lib/state/zoneNotes.svelte';
import { fromNotamLimit } from '$lib/vertical/limits';

const T = Date.UTC(2026, 10, 23, 10, 0); // Monday 23 November 2026, 10:00Z
const H = 3_600_000;
const NOW = { fromMs: T, toMs: T };

function z(answer: ActivityAnswer, over: Partial<ZoneState> = {}): ZoneState {
	return { answer, next: null, noticeMin: null, briefedAtMs: undefined, note: null, ...over };
}

describe('zoneStateLines', () => {
	afterEach(() => {
		i18n.locale = 'en';
	});

	it('says the state now, until the end of its period', () => {
		const a: ActivityAnswer = { state: 'activable', reason: 'activable', period: { startMs: T - H, endMs: Date.UTC(2026, 10, 23, 15, 16) } };
		expect(zoneStateLines(z(a), 'now', NOW)).toEqual({
			state: 'May be active now, until 15:16Z.',
			reason: 'Published as activable: the units it names know the real activity.',
			next: null,
		});
		const p: ActivityAnswer = { state: 'active', reason: 'permanent', period: null };
		expect(zoneStateLines(z(p), 'now', NOW)).toEqual({ state: 'Active, permanent.', reason: null, next: null });
	});

	it('says the period over a flight', () => {
		const a: ActivityAnswer = { state: 'active', reason: 'published', period: { startMs: T + H, endMs: T + 3 * H } };
		expect(zoneStateLines(z(a), 'flight', { fromMs: T, toMs: T + 5 * H }).state).toBe('Active from 11:00Z to 13:00Z.');
		const i: ActivityAnswer = { state: 'inactive', reason: 'outside', period: null };
		expect(zoneStateLines(z(i), 'flight', { fromMs: T, toMs: T + 5 * H })).toEqual({
			state: 'Inactive during the flight.',
			reason: 'Outside its published hours.',
			next: null,
		});
	});

	it('names the days of a period on others: one day once, two days at each end', () => {
		const at = { fromMs: Date.UTC(2026, 10, 24), toMs: Date.UTC(2026, 10, 25) };
		// ZRT VILLACOUBLAY (192/2025), activable 22:00 to 05:00, over a plan
		// dated 24 Nov without a time.
		const night: ActivityAnswer = { state: 'activable', reason: 'activable', period: { startMs: Date.UTC(2026, 10, 23, 22), endMs: Date.UTC(2026, 10, 24, 5) } };
		const later: ActivityAnswer = { state: 'active', reason: 'published', period: { startMs: Date.UTC(2026, 10, 25, 9), endMs: Date.UTC(2026, 10, 25, 11) } };
		const d23 = fmtDayMonth('2026-11-23');
		const d24 = fmtDayMonth('2026-11-24');
		const d25 = fmtDayMonth('2026-11-25');
		expect(zoneStateLines(z(night), 'flight', at).state).toBe(`May be active from ${d23} 22:00Z to ${d24} 05:00Z.`);
		expect(zoneStateLines(z(later), 'flight', at).state).toBe(`Active on ${d25} from 09:00Z to 11:00Z.`);
		const until: ActivityAnswer = { state: 'activable', reason: 'activable', period: { startMs: T - H, endMs: T + 22 * H } };
		expect(zoneStateLines(z(until), 'now', NOW).state).toBe(`May be active now, until ${d24} 08:00Z.`);
		i18n.locale = 'fr';
		const f23 = fmtDayMonth('2026-11-23');
		const f24 = fmtDayMonth('2026-11-24');
		const f25 = fmtDayMonth('2026-11-25');
		expect(zoneStateLines(z(night), 'flight', at).state).toBe(`Activable du ${f23} 22:00Z au ${f24} 05:00Z.`);
		expect(zoneStateLines(z(later), 'flight', at).state).toBe(`Active le ${f25} de 09:00Z à 11:00Z.`);
		expect(zoneStateLines(z(until), 'now', NOW).state).toBe(`Activable en ce moment, jusqu’au ${f24} 08:00Z.`);
	});

	it('names the briefing and the notice a silence rests on', () => {
		const none: ActivityAnswer = { state: 'inactive', reason: 'notam-none', period: null };
		const briefed = { briefedAtMs: Date.UTC(2026, 10, 23, 9, 50), noticeMin: 2880 };
		expect(zoneStateLines(z(none, briefed), 'now', NOW).reason).toBe(
			'Inactive on the briefing of 09:50Z. Activation is by NOTAM, at 48 h notice.',
		);
		const late: ActivityAnswer = { state: 'activable', reason: 'notam-notice', period: null };
		expect(zoneStateLines(z(late, { ...briefed, noticeMin: 30 }), 'now', NOW).reason).toBe(
			'Activation by NOTAM at 30 min notice. The briefing dates from 09:50Z.',
		);
	});

	it("adds the levels an activation NOTAM's F) and G) state", () => {
		const period = { startMs: T - H, endMs: T + H };
		const both: ActivityAnswer = { state: 'active', reason: 'notam', period, levels: { lower: fromNotamLimit('SFC'), upper: fromNotamLimit('FL235') } };
		expect(zoneStateLines(z(both), 'now', NOW).reason).toBe('Activated by NOTAM. The NOTAM activates it from SFC to FL 235.');
		const top: ActivityAnswer = { ...both, levels: { lower: null, upper: fromNotamLimit('1700FT AMSL') } };
		expect(zoneStateLines(z(top), 'now', NOW).reason).toBe('Activated by NOTAM. The NOTAM activates it up to 1700 ft AMSL.');
		i18n.locale = 'fr';
		expect(zoneStateLines(z(both), 'now', NOW).reason).toBe('Activée par NOTAM. Le NOTAM l’active de SFC à FL 235.');
	});

	it('says the next change, its date on another day', () => {
		const i: ActivityAnswer = { state: 'inactive', reason: 'outside', period: null };
		const next = (atMs: number, state: ActivityAnswer['state']) => ({ atMs, answer: { state, reason: 'activable' as const, period: null } });
		expect(zoneStateLines(z(i, { next: next(T + 2 * H, 'activable') }), 'now', NOW).next).toBe('Next: may be active from 12:00Z.');
		expect(zoneStateLines(z(i, { next: next(T + 22 * H, 'active') }), 'now', NOW).next).toBe('Next: active from 24 Nov 08:00Z.');
	});

	it('reads the same in French', () => {
		i18n.locale = 'fr';
		const a: ActivityAnswer = { state: 'activable', reason: 'activable', period: { startMs: T - H, endMs: Date.UTC(2026, 10, 23, 15, 16) } };
		const next = { atMs: T + 22 * H, answer: { state: 'inactive' as const, reason: 'outside' as const, period: null } };
		expect(zoneStateLines(z(a, { next }), 'now', NOW)).toEqual({
			state: 'Activable en ce moment, jusqu’à 15:16Z.',
			reason: 'Publiée comme activable : les organismes qu’elle cite connaissent l’activité réelle.',
			next: 'Ensuite : inactive à partir du 24 nov. 08:00Z.',
		});
		const soon = { atMs: T + 2 * H, answer: { state: 'active' as const, reason: 'published' as const, period: null } };
		expect(zoneStateLines(z(a, { next: soon }), 'now', NOW).next).toBe('Ensuite : active à partir de 12:00Z.');
	});
});

describe('crossingNoteLines', () => {
	afterEach(() => {
		i18n.locale = 'en';
	});

	const BLOIS: KnownUnit[] = [
		{ unit: 'BLOIS INFO', freq: '118.455', phone: null },
		{ unit: 'TOURS APP', freq: '120.375', phone: null },
	];
	// A crossing judged from 10:00Z to 11:20Z, its planned exit at 10:20Z.
	const AT = { fromMs: T, toMs: T + 80 * 60_000 };
	const EXIT = T + 20 * 60_000;

	it('says the period and who knows of a zone that may be active', () => {
		const a: ActivityAnswer = { state: 'activable', reason: 'activable', period: { startMs: T - H, endMs: Date.UTC(2026, 10, 23, 15, 11) } };
		expect(crossingNoteLines(a, BLOIS, null, EXIT, AT)).toEqual([
			'May be active from 09:00Z to 15:11Z.',
			'Activity known on BLOIS INFO 118.455.',
		]);
	});

	it('says how long after the crossing a zone may become active', () => {
		const i: ActivityAnswer = { state: 'inactive', reason: 'outside', period: null };
		const next = { atMs: T + 95 * 60_000, answer: { state: 'activable', reason: 'activable', period: null } as ActivityAnswer };
		expect(crossingNoteLines(i, BLOIS, next, EXIT, AT)).toEqual([
			'Activity known on BLOIS INFO 118.455.',
			'May be active from 11:35Z, 75 min after the crossing.',
		]);
		// Past midnight, the change carries its date.
		const late = { atMs: T + 14.5 * H, answer: { state: 'active', reason: 'notam', period: null } as ActivityAnswer };
		expect(crossingNoteLines(i, [], late, T + 13 * H + 50 * 60_000, AT)).toEqual([
			'Active from 24\u202fNov 00:30Z, 40 min after the crossing.',
		]);
	});

	it('says nothing of a zone inactive and staying so, or in force at all times', () => {
		expect(crossingNoteLines({ state: 'inactive', reason: 'outside', period: null }, BLOIS, null, EXIT, AT)).toEqual([]);
		expect(crossingNoteLines({ state: 'active', reason: 'permanent', period: null }, BLOIS, null, EXIT, AT)).toEqual([]);
	});

	it('names the telephone where the zone names nobody on the radio', () => {
		const a: ActivityAnswer = { state: 'activable', reason: 'activable', period: { startMs: T, endMs: T + H } };
		expect(crossingNoteLines(a, [{ unit: 'MANAGER', freq: null, phone: '+33 2 33 00 00 00' }], null, EXIT, AT)).toEqual([
			'May be active from 10:00Z to 11:00Z.',
			'Activity known by telephone.',
		]);
	});

	it('reads the same in French', () => {
		i18n.locale = 'fr';
		const i: ActivityAnswer = { state: 'inactive', reason: 'outside', period: null };
		const next = { atMs: T + 95 * 60_000, answer: { state: 'activable', reason: 'activable', period: null } as ActivityAnswer };
		expect(crossingNoteLines(i, BLOIS, next, EXIT, AT)).toEqual([
			'Activité réelle connue de BLOIS INFO 118.455.',
			'Activable à partir de 11:35Z, 75 min après la traversée.',
		]);
	});
});

describe("the pilot's note", () => {
	afterEach(() => {
		i18n.locale = 'en';
	});

	const NOTE: ZoneNote = {
		state: 'inactive',
		notedAtMs: Date.UTC(2026, 10, 23, 8, 40),
		untilMs: Date.UTC(2026, 10, 23, 16),
		unit: 'SEINE INFO',
		name: 'ZRT BLOIS',
	};
	const SETTLED: ActivityAnswer = { state: 'inactive', reason: 'noted', period: { startMs: NOTE.notedAtMs, endMs: NOTE.untilMs } };
	const LATE: ZoneNote = { ...NOTE, state: 'active', untilMs: Date.UTC(2026, 10, 24, 6), unit: '' };

	it("says a zone the note settles at its panel's head", () => {
		expect(zoneStateLines(z(SETTLED, { note: NOTE }), 'now', NOW)).toEqual({
			state: 'Inactive now, until 16:00Z.',
			reason: 'Noted from SEINE INFO at 08:40Z.',
			next: null,
		});
		i18n.locale = 'fr';
		expect(zoneStateLines(z(SETTLED, { note: NOTE }), 'now', NOW)).toEqual({
			state: 'Inactive en ce moment, jusqu’à 16:00Z.',
			reason: 'D’après SEINE INFO, noté à 08:40Z.',
			next: null,
		});
	});

	it('says the note in the lists, its end dated on another day', () => {
		expect(noteLine(NOTE)).toBe('Inactive until 16:00Z, SEINE INFO, noted 08:40Z.');
		expect(noteNamedLine(NOTE)).toBe('ZRT BLOIS inactive until 16:00Z, SEINE INFO, noted 08:40Z.');
		expect(noteLine(LATE)).toBe(`Active until ${fmtDayMonth('2026-11-24')} 06:00Z, noted 08:40Z.`);
		expect(notedWord({ startMs: NOTE.notedAtMs, endMs: NOTE.untilMs })).toBe('noted until 16:00Z');
		i18n.locale = 'fr';
		expect(noteLine(NOTE)).toBe('Inactive jusqu’à 16:00Z, SEINE INFO, noté à 08:40Z.');
		expect(noteNamedLine(NOTE)).toBe('ZRT BLOIS inactive jusqu’à 16:00Z, SEINE INFO, noté à 08:40Z.');
		expect(noteLine(LATE)).toBe(`Active jusqu’au ${fmtDayMonth('2026-11-24')} 06:00Z, noté à 08:40Z.`);
		expect(notedWord({ startMs: NOTE.notedAtMs, endMs: NOTE.untilMs })).toBe('notée jusqu’à 16:00Z');
	});

	it('says the note on a crossing, in place of its state or after it', () => {
		const known: KnownUnit[] = [{ unit: 'BLOIS INFO', freq: '118.455', phone: null }];
		const at = { fromMs: T, toMs: T + 80 * 60_000 };
		expect(crossingNoteLines(SETTLED, known, null, T + 20 * 60_000, at, NOTE)).toEqual([
			'Inactive until 16:00Z, SEINE INFO, noted 08:40Z.',
		]);
		// A note ending before the crossing does leaves it open, and says so.
		const open: ActivityAnswer = { state: 'activable', reason: 'activable', period: { startMs: T - H, endMs: T + 8 * H } };
		expect(crossingNoteLines(open, known, null, T + 20 * 60_000, at, { ...NOTE, untilMs: T + 30 * 60_000 })).toEqual([
			'May be active from 09:00Z to 18:00Z.',
			'Activity known on BLOIS INFO 118.455.',
			'Inactive until 10:30Z, SEINE INFO, noted 08:40Z.',
		]);
	});
});

describe('noticeText', () => {
	it('says a notice in its own unit', () => {
		expect([15, 30, 1440, 2880, 4320, 10080].map(noticeText)).toEqual(['15 min', '30 min', '24 h', '48 h', '72 h', '7 days']);
	});
});
