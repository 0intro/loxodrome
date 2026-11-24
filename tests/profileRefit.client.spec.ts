/* The route profile's altitude window follows an edit to the levels the way
 * closing and reopening it would (docs/route-profile.md "Window: zoom, pan,
 * persistence"). Where it goes is pinned in routeProfile.spec.ts
 * (reopenAltWindow); here is WHEN, components/profileRefit.svelte.ts: a
 * refit that typing does not pump, a hold no pause mid-drag can break, a
 * release that refits at once, and a hold whose end survives the chart
 * unmounting under it. The effects really run (tests/env/webnode.ts); only
 * the two timer functions are faked, Svelte itself flushing on microtasks. */

import { flushSync } from 'svelte';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFIT_SETTLE_MS } from '$lib/components/profileRefit.svelte';
import { mountHoldChain, mountRefitHost } from './helpers/profileRefitHost.svelte';

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
	vi.useRealTimers();
});

/** A state write, then the effects it wakes. */
function act(write: () => void): void {
	write();
	flushSync();
}

/** Mount, and let the refit a mount schedules (a no-op in the modal, whose
 *  restore has just framed the view) run out, so each case counts from 0. */
function settledHost(init: Parameters<typeof mountRefitHost>[0] = {}): ReturnType<typeof mountRefitHost> & {
	since: () => number;
} {
	const h = mountRefitHost(init);
	flushSync();
	vi.advanceTimersByTime(REFIT_SETTLE_MS);
	const base = h.refits();
	return { ...h, since: () => h.refits() - base };
}

describe('useSettledRefit', () => {
	it('refits once, a settle after the last of a burst of edits', () => {
		const h = settledHost();
		// 6, 65, 650, 6500: the Route tab commits every keystroke.
		for (let k = 1; k <= 4; k++) {
			act(() => {
				h.s.changes = k;
			});
			vi.advanceTimersByTime(120);
		}
		expect(h.since()).toBe(0);
		vi.advanceTimersByTime(REFIT_SETTLE_MS - 120 - 1);
		expect(h.since()).toBe(0);
		vi.advanceTimersByTime(1);
		expect(h.since()).toBe(1);
		vi.advanceTimersByTime(REFIT_SETTLE_MS * 5);
		expect(h.since()).toBe(1);
		h.stop();
	});

	it('never refits while a leg is held, however long the pause, and refits at once on the release', () => {
		const h = settledHost();
		act(() => {
			h.s.held = true;
		});
		for (let k = 1; k <= 3; k++) {
			act(() => {
				h.s.changes = k;
			});
		}
		vi.advanceTimersByTime(REFIT_SETTLE_MS * 10);
		expect(h.since()).toBe(0);
		act(() => {
			h.s.held = false;
		});
		vi.advanceTimersByTime(0);
		expect(h.since()).toBe(1);
		vi.advanceTimersByTime(REFIT_SETTLE_MS * 3);
		expect(h.since()).toBe(1);
		h.stop();
	});

	it('cancels a refit already on its way when a hold starts, and brings it back once at the release', () => {
		const h = settledHost();
		act(() => {
			h.s.changes = 1;
		});
		vi.advanceTimersByTime(REFIT_SETTLE_MS / 2);
		act(() => {
			h.s.held = true;
		});
		vi.advanceTimersByTime(REFIT_SETTLE_MS * 2);
		expect(h.since()).toBe(0);
		act(() => {
			h.s.held = false;
		});
		vi.advanceTimersByTime(0);
		expect(h.since()).toBe(1);
		vi.advanceTimersByTime(REFIT_SETTLE_MS * 3);
		expect(h.since()).toBe(1);
		h.stop();
	});

	it('does nothing while not ready, and refits a settle after it becomes ready', () => {
		const h = mountRefitHost({ ready: false });
		flushSync();
		act(() => {
			h.s.changes = 1;
		});
		vi.advanceTimersByTime(REFIT_SETTLE_MS * 3);
		expect(h.refits()).toBe(0);
		act(() => {
			h.s.ready = true;
		});
		vi.advanceTimersByTime(REFIT_SETTLE_MS - 1);
		expect(h.refits()).toBe(0);
		vi.advanceTimersByTime(1);
		expect(h.refits()).toBe(1);
		h.stop();
	});

	it('treats a release made while not ready as a plain edit once ready', () => {
		const h = settledHost();
		act(() => {
			h.s.held = true;
		});
		act(() => {
			h.s.ready = false;
		});
		act(() => {
			h.s.held = false;
		});
		vi.advanceTimersByTime(REFIT_SETTLE_MS * 2);
		expect(h.since()).toBe(0);
		act(() => {
			h.s.ready = true;
		});
		vi.advanceTimersByTime(0);
		expect(h.since()).toBe(0);
		vi.advanceTimersByTime(REFIT_SETTLE_MS);
		expect(h.since()).toBe(1);
		h.stop();
	});

	it('does not track what the refit itself reads', () => {
		const h = settledHost();
		act(() => {
			h.s.readByRefit = 1;
		});
		vi.advanceTimersByTime(REFIT_SETTLE_MS * 3);
		expect(h.since()).toBe(0);
		h.stop();
	});

	it('refits nothing once its host is gone', () => {
		const h = settledHost();
		act(() => {
			h.s.changes = 1;
		});
		h.stop();
		vi.advanceTimersByTime(REFIT_SETTLE_MS * 3);
		expect(h.since()).toBe(0);
	});
});

describe('useHoldReport: the chart holds the modal', () => {
	function chain(opts: Parameters<typeof mountHoldChain>[0] = {}): ReturnType<typeof mountHoldChain> & {
		since: () => number;
	} {
		const c = mountHoldChain(opts);
		flushSync();
		vi.advanceTimersByTime(REFIT_SETTLE_MS);
		const base = c.refits();
		return { ...c, since: () => c.refits() - base };
	}

	it('reports a drag from its start to its release', () => {
		const c = chain();
		act(() => {
			c.chart.dragging = true;
		});
		expect(c.modal.held).toBe(true);
		act(() => {
			c.modal.changes = 1;
		});
		vi.advanceTimersByTime(REFIT_SETTLE_MS * 3);
		expect(c.since()).toBe(0);
		act(() => {
			c.chart.dragging = false;
		});
		expect(c.modal.held).toBe(false);
		vi.advanceTimersByTime(0);
		expect(c.since()).toBe(1);
		c.stop();
	});

	it('ends the hold when the chart unmounts under a held leg', () => {
		// Back or Escape closes the surface mid-drag: no pointerup ever comes,
		// and the modal outlives the chart (LazySurface keeps it mounted).
		const c = chain();
		act(() => {
			c.chart.dragging = true;
		});
		expect(c.modal.held).toBe(true);
		c.stopChart();
		flushSync();
		expect(c.modal.held).toBe(false);
		vi.advanceTimersByTime(0);
		expect(c.since()).toBe(1);
		c.stop();
	});

	it('reports untracked, so a sink that reads its own flag cannot loop on its writes', () => {
		// Tracked, the start would subscribe the chart's effect to the flag it
		// writes: every write would re-run it (teardown false, body true)
		// until Svelte gave up on the update depth.
		const c = chain({ readingSink: true });
		act(() => {
			c.chart.dragging = true;
		});
		expect(c.modal.held).toBe(true);
		act(() => {
			c.chart.dragging = false;
		});
		expect(c.modal.held).toBe(false);
		vi.advanceTimersByTime(0);
		expect(c.since()).toBe(1);
		c.stop();
	});

	it('ends it without a refit when the surface has already closed', () => {
		const c = chain();
		act(() => {
			c.chart.dragging = true;
		});
		act(() => {
			c.modal.ready = false;
		});
		c.stopChart();
		flushSync();
		expect(c.modal.held).toBe(false);
		vi.advanceTimersByTime(REFIT_SETTLE_MS * 3);
		expect(c.since()).toBe(0);
		c.stop();
	});
});

describe('the wiring the timing relies on', () => {
	const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');
	const modal = read('src/lib/components/RouteProfileModal.svelte');
	const chart = read('src/lib/components/RouteProfile.svelte');

	it('the modal hands the chart its hold sink and gates the refit like the restore', () => {
		expect(modal).toMatch(/<RouteProfile\b[\s\S]*?\{onLegHold\}/);
		expect(modal).toMatch(/ready: \(\) => routeProfileModal\.open && enough && msaSettled && !printing/);
	});

	it('the restore holds its own altitude writes while a leg is held', () => {
		expect(modal).toMatch(/const held = legHeld;/);
		expect(modal).toMatch(/pendingAltView && msaReady && !held/);
		expect(modal).toMatch(/if \(!win\.altTouched && \(restoring \|\| !held\)\)/);
	});

	it('Fit drops a saved window still waiting for the MSA', () => {
		expect(modal).toMatch(/onFitForget: \(\) => \{\s*savedViews\.delete\(routes\.activeId\);\s*pendingAltView = null;/);
	});

	it('the chart reports every hold, captured before it is marked and ended on every exit', () => {
		expect(chart).toMatch(/useHoldReport\(\s*\(\) => dragLeg !== null,\s*\(\) => onLegHold,?\s*\)/);
		expect(chart).toMatch(/setPointerCapture\(e\.pointerId\);\s*dragLeg = seg\.i;/);
		for (const ev of ['onpointerup', 'onpointercancel', 'onlostpointercapture']) {
			expect(chart).toMatch(new RegExp(`${ev}=\\{legUp\\}`));
		}
	});
});
