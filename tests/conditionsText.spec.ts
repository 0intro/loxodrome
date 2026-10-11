/* The viewing conditions in words (components/conditionsText.ts): the toolbar
 * chips say what the pilot SET, the printed bulletin what was APPLIED. The two
 * differ exactly where a mode does not resolve, and there paper must name the
 * Now and the every-level reading that actually cut it, never "Flight" or a
 * band the filter took no range from. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/storage';

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function load() {
	const f = await import('$lib/state/filter.svelte');
	const { planScope } = await import('$lib/state/planScope.svelte');
	const c = await import('$lib/components/conditionsText');
	return { ...f, planScope, ...c };
}

/** A planned flight whose window the case decides. */
function flight(window: { from: number; to: number } | null) {
	return {
		window: () => window,
		flyable: () => window !== null,
		etdStated: () => window !== null,
		timed: () => window !== null,
	};
}

const SET = {};
const APPLIED = { applied: true };

describe('the period', () => {
	it('reads Now, bounded or not, the same set and applied', async () => {
		const m = await load();
		for (const o of [SET, APPLIED]) {
			expect(m.periodLabel(o)).toBe('Now');
			expect(m.periodRestricts(o)).toBe(false);
		}
		m.setWindowHorizon(24);
		for (const o of [SET, APPLIED]) {
			expect(m.periodLabel(o)).toBe('Next 24 h');
			expect(m.periodRestricts(o)).toBe(true);
		}
	});

	it('states a valid custom range, a midnight start without its time', async () => {
		const m = await load();
		m.setWindowMode('custom');
		m.filter.window.fromDate = '2026-09-25';
		m.filter.window.fromTime = '00:00';
		m.filter.window.toDate = '2026-09-26';
		m.filter.window.toTime = '06:00';
		for (const o of [SET, APPLIED]) {
			expect(m.periodLabel(o)).toBe('2026-09-25 – 2026-09-26 06:00');
			expect(m.periodRestricts(o)).toBe(true);
		}
	});

	it('says a custom range is not set, and paper names the Now it fell back to', async () => {
		const m = await load();
		m.setWindowMode('custom');
		m.filter.window.fromDate = '2026-09-26';
		m.filter.window.toDate = '2026-09-25';
		expect(m.periodLabel()).toBe('Period not set');
		expect(m.periodRestricts()).toBe(true);
		expect(m.periodLabel(APPLIED)).toBe('Now');
		expect(m.periodRestricts(APPLIED)).toBe(false);
		m.setWindowHorizon(6);
		expect(m.periodLabel(APPLIED)).toBe('Next 6 h');
		expect(m.periodRestricts(APPLIED)).toBe(true);
	});

	it("states the flight's span, and Now on paper when the flight has none", async () => {
		const m = await load();
		const from = Date.parse('2026-09-25T10:00:00Z');
		const to = Date.parse('2026-09-25T13:30:00Z');
		m.planScope.flight = flight({ from, to });
		m.setWindowMode('flight');
		for (const o of [SET, APPLIED]) {
			expect(m.periodLabel(o)).toMatch(/10:00.*13:30/);
			expect(m.periodRestricts(o)).toBe(true);
		}
		m.planScope.flight = flight(null);
		expect(m.periodLabel()).toBe('Flight');
		expect(m.periodRestricts()).toBe(true);
		expect(m.periodLabel(APPLIED)).toBe('Now');
		expect(m.periodRestricts(APPLIED)).toBe(false);
	});
});

describe('the levels', () => {
	it('reads the band while it applies, All levels while off, the same set and applied', async () => {
		const m = await load();
		for (const o of [SET, APPLIED]) {
			expect(m.levelsLabel(o)).toBe('0–10 000 ft');
			expect(m.levelsRestrict(o)).toBe(true);
		}
		m.setAltitudeEnabled(false);
		for (const o of [SET, APPLIED]) {
			expect(m.levelsLabel(o)).toBe('All levels');
			expect(m.levelsRestrict(o)).toBe(false);
		}
	});

	it('shows a band typed upside down or below the surface, and paper every level', async () => {
		const m = await load();
		for (const [floor, ceiling] of [
			[5000, 1000],
			[-500, 3000],
		]) {
			m.setAltitudeBand(floor, ceiling);
			expect(m.levelsRestrict()).toBe(true);
			expect(m.levelsLabel()).toContain('ft');
			expect(m.levelsRestrict(APPLIED)).toBe(false);
			expect(m.levelsLabel(APPLIED)).toBe('All levels');
		}
	});
});
