import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	agoDays,
	announceNextCycle,
	fmtAiracDate,
	fmtUTC,
	freshnessClass,
	relativeActive,
} from '$lib/format/about';
import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';

describe('fmtUTC', () => {
	it('formats an ISO timestamp to UTC minutes', () => {
		expect(fmtUTC('2026-05-22T10:46:26.605Z')).toBe('2026-05-22 10:46 UTC');
	});
	it('returns a dash for empty input', () => {
		expect(fmtUTC(undefined)).toBe('–');
	});
	it('echoes an unparseable string unchanged', () => {
		expect(fmtUTC('not-a-date')).toBe('not-a-date');
	});
});

/* Prose integer counts moved to fmtInt() (state/i18n.svelte.ts); grouping is
 * covered by the catalog spec. */

describe('fmtAiracDate', () => {
	it('prefixes the AIRAC cycle and trims to the date', () => {
		expect(fmtAiracDate('2026-05-14T00:00:00.000Z')).toMatch(/^AIRAC \d{4} · 2026-05-14$/);
	});
	it('returns a dash for empty input', () => {
		expect(fmtAiracDate(null)).toBe('–');
	});
});

describe('clock-relative formatters', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-28T00:00:00.000Z'));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('relativeActive returns the structured parts', () => {
		expect(relativeActive('2026-06-11T00:00:00.000Z')).toEqual({ kind: 'days', days: 14 });
		expect(relativeActive('2026-05-28T06:00:00.000Z')).toEqual({ kind: 'soon' });
		expect(relativeActive('2026-05-01T00:00:00.000Z')).toEqual({ kind: 'now' });
		expect(relativeActive(undefined)).toEqual({ kind: 'none' });
		expect(relativeActive('not-a-date')).toEqual({ kind: 'none' });
	});
	it('the catalogs render the relative parts in both languages', () => {
		expect(en.about.activeInDays(14)).toBe('active in 14 days');
		expect(en.about.activeInDays(1)).toBe('active in 1 day');
		// States the fact, not an instruction: the AiracBanner is what asks
		// for a reload, and it has a button to do it with.
		expect(en.about.activeNow).toBe('active now');
		expect(fr.about.activeNow).toBe('en vigueur');
		expect(fr.about.activeInDays(14)).toBe('en vigueur dans 14 jours');
		expect(fr.about.activeInDays(1)).toBe('en vigueur dans 1 jour');
	});
	it('agoDays reports whole days (0 = today, null = unknown)', () => {
		expect(agoDays('2026-05-28T00:00:00.000Z')).toBe(0);
		expect(agoDays('2026-05-27T00:00:00.000Z')).toBe(1);
		expect(agoDays('2026-05-20T00:00:00.000Z')).toBe(8);
		expect(agoDays(undefined)).toBeNull();
	});
	it('the catalogs render the ago parts in both languages', () => {
		expect(en.about.daysAgo(1)).toBe('1 day ago');
		expect(en.about.daysAgo(8)).toBe('8 days ago');
		expect(en.about.generatedToday).toBe('today');
		expect(fr.about.daysAgo(1)).toBe('il y a 1 jour');
		expect(fr.about.daysAgo(8)).toBe('il y a 8 jours');
	});
	it('freshnessClass buckets by AIRAC cycle, not raw days', () => {
		// The frozen clock 2026-05-28 sits in the cycle effective 2026-05-14.
		expect(freshnessClass('2026-05-28T00:00:00.000Z')).toBe('fresh'); // same cycle
		expect(freshnessClass('2026-05-14T00:00:00.000Z')).toBe('fresh'); // cycle start
		expect(freshnessClass('2026-05-13T00:00:00.000Z')).toBe('stale'); // one cycle back
		expect(freshnessClass('2026-04-16T00:00:00.000Z')).toBe('stale'); // prev cycle start
		expect(freshnessClass('2026-04-15T00:00:00.000Z')).toBe('expired'); // two cycles back
	});
	it('freshnessClass keeps current-cycle data fresh at ~3 weeks', () => {
		// Reported regression: viewed 2026-07-05, data generated 2026-06-12
		// is 23 days old but still in the cycle effective 2026-06-11, so it
		// must read fresh rather than red.
		vi.setSystemTime(new Date('2026-07-05T00:00:00.000Z'));
		expect(freshnessClass('2026-06-12T21:29:33.851Z')).toBe('fresh');
	});
});

/* The About card names the cycle in USE, which is not always the
 * current-slot sidecar. On 15 August 2026 the app served France and
 * Belgium from AIRAC 2608 (their .next files) while their cards read 2607
 * and offered to reload for a cycle already loaded. */
describe('announceNextCycle', () => {
	const now = new Date('2026-08-15T10:00:00.000Z');
	const ahead = '2026-09-03T00:00:00.000Z';
	const arrived = '2026-08-06T00:00:00.000Z';

	it('announces a pre-release that is still ahead', () => {
		expect(
			announceNextCycle({ nextEffective: ahead, slot: 'current' }, undefined, now),
		).toBe(ahead);
	});

	it('says nothing once the pre-release is the loaded slot', () => {
		// The cycle is in use; calling it "next" names the wrong one as
		// current, which is what this whole helper exists to stop.
		expect(
			announceNextCycle({ nextEffective: ahead, slot: 'next' }, undefined, now),
		).toBeUndefined();
	});

	it('leaves an arrived-but-unloaded cycle to the AiracBanner', () => {
		// Real, but the banner says it with a Reload button.
		expect(
			announceNextCycle({ nextEffective: arrived, slot: 'current' }, undefined, now),
		).toBeUndefined();
	});

	it('says nothing when no pre-release is published', () => {
		expect(
			announceNextCycle({ nextEffective: null, slot: 'current' }, undefined, now),
		).toBeUndefined();
	});

	it('falls back to the sidecar for a publisher outside the matrix', () => {
		expect(announceNextCycle(null, ahead, now)).toBe(ahead);
		expect(announceNextCycle(undefined, undefined, now)).toBeUndefined();
	});

	it('ignores an unparseable date rather than printing it', () => {
		expect(
			announceNextCycle({ nextEffective: 'soon', slot: 'current' }, undefined, now),
		).toBeUndefined();
	});
});
