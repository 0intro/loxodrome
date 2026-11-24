/* The briefing's words on paper and on the sheets (components/briefingText.ts).
 * Paper outlives the minute it printed, so every time is absolute and the
 * age is the fetch's own instant. A sheet that reads NOTAMs states the first
 * reason and what its figures then rest on. A warning slot takes a short
 * tag, the reason on its title. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BriefingVerdict } from '$lib/notam/briefingVerdict';

// The French SUP AIP list's build time, null while unread.
const list = vi.hoisted(() => ({ loaded: false, at: null as number | null }));
vi.mock('$lib/state/data.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/state/data.svelte')>()),
	ensureAirports: () => Promise.resolve([]),
	frSupaipList: () => (list.loaded ? { at: list.at } : null),
}));

const {
	briefingLineReasons,
	briefingPaperParts,
	briefingPaperReasons,
	briefingPaperReasonsText,
	briefingPaperStamp,
	briefingPrintText,
	briefingReasonText,
	briefingReasonsLine,
	briefingSheetNote,
	briefingShortTag,
	briefingStamp,
	briefingSupaipList,
} = await import('$lib/components/briefingText');
const { clearNotams, commitBriefing } = await import('$lib/state/notam.svelte');
const { i18n } = await import('$lib/state/i18n.svelte');

const H = 3_600_000;
const AT = Date.UTC(2026, 10, 24, 9, 0);
const DAY = Date.UTC(2026, 10, 25);

const verdict = (over: Partial<BriefingVerdict> = {}): BriefingVerdict => ({
	plan: true,
	source: 'fetch',
	at: AT,
	reasons: [],
	...over,
});

beforeEach(() => {
	i18n.locale = 'en';
	clearNotams();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(AT);
	commitBriefing('', { source: 'sofia', kind: 'route', briefed: { from: DAY, to: DAY + 24 * H - 60_000 } });
	vi.useRealTimers();
});

describe('paper', () => {
	it('stamps the source, the fetch time and the period covered, in one line of box C', () => {
		expect(briefingPaperStamp(verdict())).toBe('NOTAMs: SOFIA 2026-11-24 09:00Z, for 2026-11-25 00:00Z – 2026-11-25 23:59Z');
		i18n.locale = 'fr';
		expect(briefingPaperStamp(verdict())).toBe('NOTAM : SOFIA 2026-11-24 09:00Z, pour 2026-11-25 00:00Z – 2026-11-25 23:59Z');
	});

	it('sets box C in one paragraph, the stamp inked short with the reasons', () => {
		const stamp = 'NOTAMs: SOFIA 2026-11-24 09:00Z, for 2026-11-25 00:00Z – 2026-11-25 23:59Z.';
		expect(briefingPaperParts(verdict())).toEqual([{ text: stamp, short: false }]);
		// The stamp prints the fetch's time: an age is its ink alone.
		expect(briefingPaperParts(verdict({ reasons: [{ code: 'age', at: AT, ageMs: 4 * H }] }))).toEqual([
			{ text: stamp, short: true },
		]);
		expect(briefingPaperParts(verdict({ source: 'hand', at: AT }))[0].text).toBe(
			'Bulletin pasted or opened at 2026-11-24 09:00Z. Check that it covers this flight.',
		);
	});

	it('states the first reason in full on box C and counts the rest, the Overview one sheet', () => {
		const stamp = 'NOTAMs: SOFIA 2026-11-24 09:00Z, for 2026-11-25 00:00Z – 2026-11-25 23:59Z.';
		const v = verdict({
			reasons: [
				{ code: 'route', labels: ['LFPN-LFOZ'], at: AT, cause: 'track' },
				{ code: 'aerodromes', idents: ['LFOQ'] },
				{ code: 'age', at: AT, ageMs: 4 * H },
			] as BriefingVerdict['reasons'],
		});
		const parts = briefingPaperParts(v);
		expect(parts).toHaveLength(3);
		expect(parts[0]).toEqual({ text: stamp, short: true });
		expect(parts[1].text).toMatch(/LFPN-LFOZ/);
		expect(parts[2]).toEqual({ text: 'The NOTAMs tab states 1 more.', short: true });
		i18n.locale = 'fr';
		expect(briefingPaperParts(v)[2].text).toBe('L’onglet NOTAM en indique 1 autre.');
	});

	it('states a flight already flown once on box C, in the verdict’s place', () => {
		const past = 'The planned flight (2026-11-23 09:00Z) is in the past: check the flight date and the ETD.';
		const v = verdict({
			reasons: [
				{ code: 'route', labels: ['LFPN-LFOZ'], at: AT, cause: 'track' },
				{ code: 'age', at: AT, ageMs: 4 * H },
			] as BriefingVerdict['reasons'],
		});
		expect(briefingPaperParts(v, past)).toEqual([
			{ text: 'NOTAMs: SOFIA 2026-11-24 09:00Z, for 2026-11-25 00:00Z – 2026-11-25 23:59Z.', short: false },
			{ text: past, short: true },
		]);
		// A bulletin by hand: its time alone.
		expect(briefingPaperParts(verdict({ source: 'hand', at: AT }), past)[0].text).toBe(
			'Bulletin pasted or opened at 2026-11-24 09:00Z.',
		);
	});

	it('prints a bulletin by hand with no plan bare, as the screen does', () => {
		expect(briefingPaperStamp(verdict({ plan: false, source: 'hand', at: AT }))).toBe(
			'Bulletin pasted or opened at 2026-11-24 09:00Z.',
		);
	});

	it('states the age at the fetch and a changed route at its absolute time', () => {
		const v = verdict({
			reasons: [
				{ code: 'route', labels: ['LFPN-LFOZ'], at: AT, cause: 'track' },
				{ code: 'age', at: AT, ageMs: 4 * H },
			],
		});
		expect(briefingPaperReasons(v)).toEqual([
			'The route changed since the 2026-11-24 09:00Z briefing (LFPN-LFOZ)',
			'NOTAMs fetched at 2026-11-24 09:00Z',
		]);
		// The bulletin's head runs them as sentences.
		expect(briefingPaperReasonsText(v)).toBe(
			'The route changed since the 2026-11-24 09:00Z briefing (LFPN-LFOZ). NOTAMs fetched at 2026-11-24 09:00Z.',
		);
		// On screen, the age is relative.
		expect(briefingReasonText({ code: 'age', at: AT, ageMs: 4 * H }, AT + 4 * H)).toBe('NOTAMs fetched 4 h 00 ago');
	});

	it('says why the route falls outside the briefing', () => {
		const route = (cause: 'track' | 'width' | 'area') => ({ code: 'route' as const, labels: ['LFPN-LFOZ'], at: AT, cause });
		expect(briefingReasonText(route('width'), AT, 'fetch', true)).toBe(
			'The corridor is wider than the 2026-11-24 09:00Z briefing’s (LFPN-LFOZ)',
		);
		expect(briefingReasonText(route('area'), AT, 'fetch', true)).toBe(
			'The route leaves the area of the 2026-11-24 09:00Z briefing (LFPN-LFOZ)',
		);
		i18n.locale = 'fr';
		expect(briefingReasonText(route('width'), AT, 'fetch', true)).toBe(
			'Le couloir est plus large que celui du briefing de 2026-11-24 09:00Z (LFPN-LFOZ)',
		);
		expect(briefingReasonText(route('area'), AT, 'fetch', true)).toBe(
			'La route sort de la zone du briefing de 2026-11-24 09:00Z (LFPN-LFOZ)',
		);
	});

	it('leaves the stamp to say there is none', () => {
		expect(briefingPaperReasons(verdict({ source: 'none', at: null, reasons: [{ code: 'none' }] }))).toEqual([]);
	});
});

describe('the line', () => {
	it('asks to check a bulletin by hand against the flight only when one is planned', () => {
		const hand = verdict({ source: 'hand', at: AT });
		expect(briefingStamp(hand, null, AT)).toBe('Bulletin pasted or opened at 09:00Z. Check that it covers this flight.');
		expect(briefingStamp({ ...hand, plan: false }, null, AT)).toBe('Bulletin pasted or opened at 09:00Z.');
		i18n.locale = 'fr';
		expect(briefingStamp({ ...hand, plan: false }, null, AT)).toBe('Bulletin collé ou ouvert à 09:00Z.');
	});

	it('lists the age of a bulletin by hand, which its stamp leaves out', () => {
		const age = { code: 'age' as const, at: AT, ageMs: 4 * H };
		expect(briefingLineReasons(verdict({ reasons: [{ code: 'none' }, age] }))).toEqual([]);
		expect(briefingLineReasons(verdict({ source: 'hand', reasons: [age] }))).toEqual([age]);
	});
});

describe('the sheets', () => {
	it('state the first reason and what their figures rest on', () => {
		expect(briefingSheetNote(verdict({ source: 'none', at: null, reasons: [{ code: 'none' }] }), 'perf', 0, true)).toBe(
			'No NOTAM briefing for this flight. Runways and declared distances as the AIP publishes them.',
		);
		expect(
			briefingSheetNote(verdict({ reasons: [{ code: 'route', labels: ['LFPN-LFOZ'], at: AT, cause: 'track' }] }), 'fuel', 0, true),
		).toBe('The route changed since the 2026-11-24 09:00Z briefing (LFPN-LFOZ). Fuel as that briefing states it.');
		expect(briefingSheetNote(verdict(), 'navlog', 0, true)).toBeNull();
	});

	it('take a short tag in a warning slot, the reason on its title', () => {
		expect(briefingShortTag(verdict({ source: 'none', at: null, reasons: [{ code: 'none' }] }), AT)).toEqual({
			text: 'No NOTAM briefing',
			title: 'No NOTAM briefing for this flight',
		});
		expect(briefingShortTag(verdict({ reasons: [{ code: 'route', labels: ['A-B'], at: AT, cause: 'track' }] }), AT)?.text).toBe(
			'NOTAM briefing short',
		);
		expect(briefingShortTag(verdict(), AT)).toBeNull();
	});
});

describe('the print', () => {
	const none = verdict({ source: 'none', at: null, reasons: [{ code: 'none' }] });

	it('states every reason on the review’s one line', () => {
		const reasons = [
			{ code: 'route' as const, labels: ['LFPN-LFOZ'], at: AT, cause: 'track' as const },
			{ code: 'age' as const, at: AT, ageMs: 4 * H },
		];
		expect(briefingReasonsLine(reasons, 'fetch', AT + 4 * H)).toBe(
			'The route changed since the 09:00Z briefing (LFPN-LFOZ). NOTAMs fetched 4 h 00 ago.',
		);
	});

	it('says in the menu whether the print fetches the briefing first', () => {
		expect(briefingPrintText(none, null, true, AT)).toBe(
			'No NOTAM briefing for this flight. The print fetches the briefing first.',
		);
		expect(briefingPrintText(none, null, false, AT)).toBe('No NOTAM briefing for this flight.');
		expect(briefingPrintText(verdict(), 'sofia', true, AT + 12 * 60_000)).toBe('NOTAMs: SOFIA 09:00Z, 12 min ago');
		i18n.locale = 'fr';
		expect(briefingPrintText(none, null, true, AT)).toBe(
			'Aucun briefing NOTAM pour ce vol. L’impression commence par récupérer le briefing.',
		);
	});
});

describe('the SUP AIP list', () => {
	const sup = (n: number) => ({
		code: 'supaip' as const,
		listAt: Date.UTC(2026, 9, 29, 10),
		sups: Array.from({ length: n }, (_, i) => ({ ref: `AIP SUP ${247 + i}/26`, notam: `R${1234 + i}/26` })),
	});

	it('states the list in use by its day', () => {
		list.loaded = false;
		list.at = null;
		expect(briefingSupaipList()).toBeNull();
		list.loaded = true;
		expect(briefingSupaipList()).toBeNull();
		list.at = Date.UTC(2026, 10, 19, 10, 50);
		expect(briefingSupaipList()).toBe('SUP AIP list of 2026-11-19');
		i18n.locale = 'fr';
		expect(briefingSupaipList()).toBe('Liste des SUP AIP du 2026-11-19');
	});

	it('names a missing supplement with its trigger, three before counting the rest', () => {
		expect(briefingReasonText(sup(1), AT)).toBe(
			'AIP SUP 247/26 (trigger NOTAM R1234/26) is in force and missing from the SUP AIP list of 2026-10-29',
		);
		expect(briefingReasonText(sup(5), AT)).toBe(
			'AIP SUP 247/26 (trigger NOTAM R1234/26), AIP SUP 248/26 (trigger NOTAM R1235/26), ' +
				'AIP SUP 249/26 (trigger NOTAM R1236/26) and 2 more are in force and missing from the SUP AIP list of 2026-10-29',
		);
		expect(briefingPaperReasons(verdict({ reasons: [sup(1)] }))).toEqual([briefingReasonText(sup(1), AT)]);
		// Paper names one, box C keeping the Overview one sheet.
		expect(briefingPaperReasons(verdict({ reasons: [sup(3)] }))).toEqual([
			'AIP SUP 247/26 (trigger NOTAM R1234/26) and 2 more are in force and missing from the SUP AIP list of 2026-10-29',
		]);
		// The list's date unread: the reason stands, dated by nothing.
		expect(briefingReasonText({ ...sup(1), listAt: null }, AT)).toBe(
			'AIP SUP 247/26 (trigger NOTAM R1234/26) is in force and missing from the SUP AIP list',
		);
		i18n.locale = 'fr';
		expect(briefingReasonText(sup(1), AT)).toBe(
			'AIP SUP 247/26 (NOTAM trigger R1234/26) est en vigueur et absent de la liste des SUP AIP du 2026-10-29',
		);
		expect(briefingReasonText({ ...sup(1), listAt: null }, AT)).toBe(
			'AIP SUP 247/26 (NOTAM trigger R1234/26) est en vigueur et absent de la liste des SUP AIP',
		);
	});

	it('leaves the runway, fuel, frequency and profile sheets to the briefing’s own reasons', () => {
		expect(briefingSheetNote(verdict({ reasons: [sup(1)] }), 'perf', AT, true)).toBeNull();
		expect(briefingShortTag(verdict({ reasons: [sup(1)] }), AT)).toBeNull();
		expect(
			briefingSheetNote(verdict({ reasons: [{ code: 'age', at: AT, ageMs: 4 * H }, sup(1)] }), 'fuel', AT + 4 * H, true),
		).toBe('NOTAMs fetched at 2026-11-24 09:00Z. Fuel as that briefing states it.');
	});
});
