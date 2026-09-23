/* The nav log's schedule stage ($lib/state/scheduleRadios.svelte.ts): a FIS
 * sector outside its OWN PUBLISHED HOURS publishes no frequency to set, so its
 * schedule event carries none. The contact ladder then skips it and the
 * FIR-level blanket underneath answers, which is what the AIP's own "excluding
 * areas where the FIS is provided by an approach control unit" means outside
 * those hours (docs/siv-frequencies.md).
 *
 * The NOTAM side of the same module is freqOverride.spec.ts. Nothing here
 * parses a NOTAM: the briefing is empty on purpose, so what is measured is the
 * HOURS gate alone and the array identity the 1 Hz path depends on.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/state/notam.svelte', async () => {
	const real =
		await vi.importActual<typeof import('$lib/state/notam.svelte')>('$lib/state/notam.svelte');
	return { ...real, filteredNotams: () => [], activeEvalWindow: () => ({ from: -8.64e15, to: 8.64e15 }) };
});

import { resolveScheduleRadios } from '$lib/state/scheduleRadios.svelte';
import type { Airspace } from '$lib/data/airspaces';
import type { RouteAirspaceEvent } from '$lib/route/airspaces';
import { flightPrep } from '$lib/state/flightPrep.svelte';

// ------------------------------------------------------------------ //
// The sector's own OPERATING HOURS. A unit off watch publishes no      //
// frequency to set, so its schedule event carries none: the contact    //
// ladder then skips it and the FIR-level blanket underneath answers,   //
// which is what the AIP's own "excluding areas where the FIS is        //
// provided by an approach control unit" means outside those hours.     //
// docs/siv-frequencies.md.                                             //
// ------------------------------------------------------------------ //
describe('resolveScheduleRadios and the published hours', () => {
	function sector(over: Partial<Airspace>): Airspace {
		return {
			id: 'LFPBFS',
			key: 'LFPBFS',
			name: 'LE BOURGET',
			type: 'SIV',
			workHr: 'HX',
			rmkWorkHr: '',
			ring: [],
			radio: [{ freq: '123.835', unit: 'FIS LE BOURGET Information', call: 'LE BOURGET - INFORMATION' }],
			...over,
		} as Airspace;
	}
	function event(a: Airspace): RouteAirspaceEvent {
		return {
			kind: 'enter',
			atNM: 0,
			eteMin: null,
			key: a.key,
			name: a.name,
			type: a.type,
			airClass: '',
			category: 'siv',
			vLower: null,
			vUpper: null,
			radio: a.radio,
			workHr: a.workHr,
			rmkWorkHr: a.rmkWorkHr,
		};
	}
	const flying = (iso: string) => ({ fromMs: Date.parse(iso), toMs: Date.parse(iso) });
	function freqsOn(a: Airspace, iso: string): string[] {
		const out = resolveScheduleRadios([event(a)], [a], undefined, flying(iso));
		return out[0].radio.map((r) => r.freq);
	}

	// SIV LE BOURGET is HX SAT-SUN 0700-1900 (SUM -1 HR): over Pontoise on a
	// Monday the FIS really is PARIS Information, and the weekday answer the
	// app gave before it had 123.835 at all was the right one.
	const weekendOnly = sector({ rmkWorkHr: 'SAT-SUN : 0700-1900#(SUM -1 HR)' });

	it('withdraws the frequency of a sector off watch', () => {
		expect(freqsOn(weekendOnly, '2026-09-07T10:00:00Z')).toEqual([]); // Monday
	});

	it('keeps it inside the published hours', () => {
		expect(freqsOn(weekendOnly, '2026-09-12T10:00:00Z')).toEqual(['123.835']); // Saturday
		// Saturday, but before it opens (0600Z in summer).
		expect(freqsOn(weekendOnly, '2026-09-12T05:00:00Z')).toEqual([]);
	});

	it('withdraws nothing when the sector publishes no schedule', () => {
		// 46 of the 110 rows are a bare HX. Unknown is not "closed".
		expect(freqsOn(sector({}), '2026-09-07T10:00:00Z')).toEqual(['123.835']);
	});

	it('withdraws nothing from a permanently open sector', () => {
		expect(freqsOn(sector({ workHr: 'H24', rmkWorkHr: 'H24' }), '2026-09-07T10:00:00Z')).toEqual([
			'123.835',
		]);
	});

	// navLive's span memo keys on the array identity to keep buildContactSpans
	// off the 1 Hz path. Returning a fresh copy when nothing moved rebuilds the
	// spans, the closed spans and the event index on every fix, for every route
	// through a sector that merely PUBLISHES hours (Seine, Chevreuse, and Le
	// Bourget, i.e. the whole Paris region).
	it('hands back the same array when nothing moved, and a fresh one when something did', () => {
		const open = sector({});
		const sched = [event(open)];
		expect(resolveScheduleRadios(sched, [open], undefined, flying('2026-09-07T10:00:00Z'))).toBe(
			sched,
		);
		// A sector that publishes hours but is on watch: still nothing moved.
		const onWatch = sector({ rmkWorkHr: 'SAT-SUN : 0700-1900#(SUM -1 HR)' });
		const openSched = [event(onWatch)];
		expect(
			resolveScheduleRadios(openSched, [onWatch], undefined, flying('2026-09-12T10:00:00Z')),
		).toBe(openSched);
		// Off watch: a fresh array, which is what makes the memo notice.
		const shutSched = [event(onWatch)];
		expect(
			resolveScheduleRadios(shutSched, [onWatch], undefined, flying('2026-09-07T10:00:00Z')),
		).not.toBe(shutSched);
	});

	// The default clock, exercised rather than passed in: with no plan whose
	// span resolves, the hours are judged over the DOSSIER FLIGHT DATE's own
	// day, never the wall clock. A plan can reach that state by stating a
	// departure time with no cruise speed to fly it at, and reading a Saturday
	// plan against today's Monday would withdraw a frequency the flight needs.
	it('falls back to the flight date, not to today', () => {
		const weekendOnly = sector({ rmkWorkHr: 'SAT-SUN : 0700-1900#(SUM -1 HR)' });
		const freqs = () =>
			resolveScheduleRadios([event(weekendOnly)], [weekendOnly])[0].radio.map((r) => r.freq);
		const before = flightPrep.dossier.flightDate;
		try {
			flightPrep.dossier.flightDate = '2026-09-12'; // Saturday
			expect(freqs()).toEqual(['123.835']);
			flightPrep.dossier.flightDate = '2026-09-07'; // Monday
			expect(freqs()).toEqual([]);
		} finally {
			flightPrep.dossier.flightDate = before;
		}
	});

	it('leaves a non-FIS airspace alone whatever its hours say', () => {
		// The gate is scoped to the FIS tier: a CTR outside its tower's hours
		// is a different question and this does not answer it.
		const ctr = sector({ type: 'CTR', rmkWorkHr: 'SAT-SUN : 0700-1900#(SUM -1 HR)' });
		const ev = { ...event(ctr), category: 'controlled' as const };
		const out = resolveScheduleRadios([ev], [ctr], undefined, flying('2026-09-07T10:00:00Z'));
		expect(out[0].radio.map((r) => r.freq)).toEqual(['123.835']);
	});
});
