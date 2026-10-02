/* drawnStateAt(): the range a DRAWN operational state is judged over.
 *
 * Kept apart from activeEvalWindow() because the two answer different
 * questions. The evaluation window is a briefing filter, and its look-ahead
 * asks "is this true at some point before the horizon" -- which is true of
 * every recurring closure ever published. Measured over the 2026-09-21 corpus,
 * judging aerodrome closures that way marks 16 fields shut at a 24 h horizon
 * and 36 at 30 days, against 13 actually shut: Zurich is closed 2100-0400 for
 * works and would read shut at noon.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Knobs {
	custom: { from: number; to: number } | null;
	mode: 'now' | 'flight' | 'custom';
	horizonH: number | null;
	flight: { from: number; to: number } | null;
	/** A departure time stated (the span is the flight's own), or the day. */
	timed: boolean;
}
const m = vi.hoisted<Knobs>(() => ({ custom: null, mode: 'now', horizonH: 24, flight: null, timed: true }));

vi.mock('$lib/state/filter.svelte', async () => {
	const real =
		await vi.importActual<typeof import('$lib/state/filter.svelte')>('$lib/state/filter.svelte');
	return {
		...real,
		customWindow: () => m.custom,
		filter: {
			...real.filter,
			get window() {
				return { ...real.filter.window, mode: m.mode, horizonH: m.horizonH };
			},
		},
	};
});

vi.mock('$lib/state/planScope.svelte', async () => {
	const real =
		await vi.importActual<typeof import('$lib/state/planScope.svelte')>('$lib/state/planScope.svelte');
	return {
		...real,
		planScope: {
			...real.planScope,
			get flight() {
				return m.flight ? { window: () => m.flight, etdStated: () => m.timed } : null;
			},
		},
	};
});

const { drawnStateAt, activeEvalWindow } = await import('$lib/state/notam.svelte');

beforeEach(() => {
	m.custom = null;
	m.mode = 'now';
	m.horizonH = 24;
	m.flight = null;
	m.timed = true;
	vi.useRealTimers();
});

describe('drawnStateAt', () => {
	it('is the current minute when nothing else says otherwise', () => {
		const at = drawnStateAt();
		expect(at.fromMs).toBe(at.toMs);
		expect(at.fromMs % 60_000).toBe(0);
		expect(Math.abs(at.fromMs - Date.now())).toBeLessThan(60_000);
	});

	it('never takes the look-ahead, however wide the briefing window is', () => {
		for (const h of [6, 24, 48, null]) {
			m.horizonH = h;
			const at = drawnStateAt();
			expect(at.toMs - at.fromMs).toBe(0);
		}
		// The briefing window does open that far; the two differ on purpose.
		m.horizonH = null;
		expect(activeEvalWindow().to).toBe(Infinity);
		expect(drawnStateAt().toMs).toBeLessThan(Infinity);
	});

	it('takes a typed custom period, which is the pilot naming the period', () => {
		m.mode = 'custom';
		m.custom = { from: 1_800_000_000_000, to: 1_800_003_600_000 };
		expect(drawnStateAt()).toEqual({ fromMs: 1_800_000_000_000, toMs: 1_800_003_600_000 });
	});

	it('takes the planned flight span in flight mode, and only then', () => {
		m.flight = { from: 1_800_000_000_000, to: 1_800_007_200_000 };
		// Still in `now` mode: the plan does not yet speak.
		expect(drawnStateAt().toMs - drawnStateAt().fromMs).toBe(0);
		m.mode = 'flight';
		expect(drawnStateAt()).toEqual({ fromMs: 1_800_000_000_000, toMs: 1_800_007_200_000 });
	});

	it('judges a flight dated but not timed over its whole day, whenever the pilot looks', () => {
		// What the period popover says and the performance page reads. Read at
		// the current time of day on the flight's day instead, tomorrow's
		// flight was drawn at whatever hour the pilot looked, and a closure
		// from 1400 to 1600 that day read open at 0900.
		vi.useFakeTimers();
		const day = Date.UTC(2026, 8, 22);
		m.mode = 'flight';
		m.timed = false;
		m.flight = { from: day, to: day + 86_400_000 - 1 };
		for (const now of [day - 2 * 86_400_000 + 9 * 3_600_000, day + 15 * 3_600_000, day + 3 * 86_400_000]) {
			vi.setSystemTime(now);
			expect(drawnStateAt()).toEqual({ fromMs: day, toMs: day + 86_400_000 - 1 });
		}
	});

	it('prefers a typed period over the plan', () => {
		m.mode = 'custom';
		m.custom = { from: 10, to: 20 };
		m.flight = { from: 1_800_000_000_000, to: 1_800_007_200_000 };
		expect(drawnStateAt()).toEqual({ fromMs: 10, toMs: 20 });
	});
});
