import { describe, it, expect } from 'vitest';
import {
	AUTO_STOP_GRACE_MS,
	foldAutoStop,
	newAutoStopFold,
	type AutoStopInput,
} from '$lib/nav/autoStop';
import { extendMotion, newMotionFold } from '$lib/nav/navlogLive';
import { traceMotion } from '$lib/state/navMotion';
import type { TrackPoint } from '$lib/nav/trace';

const T0 = Date.parse('2026-07-20T10:00:00Z');
const MIN = 60_000;

/** One fix per second at the given [secondsOffset, speedKt] samples. */
function pts(entries: [number, number][]): TrackPoint[] {
	return entries.map(([s, kt]) => ({
		lat: 48.6 + s * 1e-5,
		lon: 2.6,
		altFt: null,
		timeMs: T0 + s * 1000,
		speedKt: kt,
		trackDeg: 0,
		accuracyM: 5,
	}));
}

/** Seconds [from, to) at one speed. */
function span(from: number, to: number, kt: number): [number, number][] {
	const out: [number, number][] = [];
	for (let s = from; s < to; s++) {
		out.push([s, kt]);
	}
	return out;
}

function input(over: Partial<AutoStopInput>): AutoStopInput {
	return {
		recording: true,
		enabled: true,
		landingMs: null,
		lastMoveMs: null,
		nowMs: T0,
		...over,
	};
}

describe('foldAutoStop', () => {
	it('stays inert without a committed landing', () => {
		const fold = newAutoStopFold();
		const st = foldAutoStop(fold, input({ lastMoveMs: T0, nowMs: T0 + 60 * MIN }));
		expect(st.pending).toBeNull();
		expect(st.fire).toBe(false);
	});

	it('stays inert while not recording (a replay), whatever the landing', () => {
		const fold = newAutoStopFold();
		const st = foldAutoStop(
			fold,
			input({ recording: false, landingMs: T0, lastMoveMs: T0, nowMs: T0 + 60 * MIN }),
		);
		expect(st.pending).toBeNull();
		expect(st.fire).toBe(false);
	});

	it('stays inert with the preference off', () => {
		const fold = newAutoStopFold();
		const st = foldAutoStop(
			fold,
			input({ enabled: false, landingMs: T0, lastMoveMs: T0, nowMs: T0 + 60 * MIN }),
		);
		expect(st.pending).toBeNull();
		expect(st.fire).toBe(false);
	});

	it('anchors the deadline on the last movement, so taxi-in pushes it out', () => {
		const fold = newAutoStopFold();
		// Arm the fold airborne first: the recording rising edge with no
		// landing yet leaves nothing suppressed.
		foldAutoStop(fold, input({}));
		const landing = T0 + 10 * MIN;
		let st = foldAutoStop(
			fold,
			input({ landingMs: landing, lastMoveMs: landing + 2 * MIN, nowMs: landing + 2 * MIN }),
		);
		expect(st.pending).toEqual({
			stopAtMs: landing + 2 * MIN + AUTO_STOP_GRACE_MS,
			landingMs: landing,
		});
		// Still taxiing three minutes later: the deadline follows.
		st = foldAutoStop(
			fold,
			input({ landingMs: landing, lastMoveMs: landing + 5 * MIN, nowMs: landing + 5 * MIN }),
		);
		expect(st.pending?.stopAtMs).toBe(landing + 5 * MIN + AUTO_STOP_GRACE_MS);
	});

	it('gives an aircraft stopping dead the full grace from its landing', () => {
		const fold = newAutoStopFold();
		foldAutoStop(fold, input({}));
		const landing = T0 + 10 * MIN;
		// The last at/above-MOVE_KT fix precedes the sub-20 kt streak start.
		const st = foldAutoStop(
			fold,
			input({ landingMs: landing, lastMoveMs: landing - 30_000, nowMs: landing }),
		);
		expect(st.pending?.stopAtMs).toBe(landing + AUTO_STOP_GRACE_MS);
	});

	it('fires exactly at the deadline, not before', () => {
		const fold = newAutoStopFold();
		foldAutoStop(fold, input({}));
		const landing = T0 + 10 * MIN;
		const stopAt = landing + AUTO_STOP_GRACE_MS;
		let st = foldAutoStop(
			fold,
			input({ landingMs: landing, lastMoveMs: landing, nowMs: stopAt - 1 }),
		);
		expect(st.pending?.stopAtMs).toBe(stopAt);
		expect(st.fire).toBe(false);
		st = foldAutoStop(fold, input({ landingMs: landing, lastMoveMs: landing, nowMs: stopAt }));
		expect(st.fire).toBe(true);
	});

	it('keep recording suppresses THAT landing; a later one re-arms', () => {
		const fold = newAutoStopFold();
		foldAutoStop(fold, input({}));
		const first = T0 + 10 * MIN;
		const st = foldAutoStop(fold, input({ landingMs: first, lastMoveMs: first, nowMs: first }));
		expect(st.pending?.landingMs).toBe(first);
		// The keep button: the caller stamps the pending landing.
		fold.suppressedLandingMs = st.pending!.landingMs;
		const quiet = foldAutoStop(
			fold,
			input({ landingMs: first, lastMoveMs: first, nowMs: first + 60 * MIN }),
		);
		expect(quiet.pending).toBeNull();
		expect(quiet.fire).toBe(false);
		// A stop-and-go later: a NEW landing differs and arms again.
		const second = T0 + 40 * MIN;
		const rearmed = foldAutoStop(
			fold,
			input({ landingMs: second, lastMoveMs: second, nowMs: second }),
		);
		expect(rearmed.pending?.landingMs).toBe(second);
	});

	it('never fires on the spot when the recording continues onto a landed trace', () => {
		const fold = newAutoStopFold();
		const old = T0 - 24 * 60 * MIN;
		// Continue pressed: the recording rising edge sees yesterday's landing.
		const st = foldAutoStop(fold, input({ landingMs: old, lastMoveMs: old, nowMs: T0 }));
		expect(st.pending).toBeNull();
		expect(st.fire).toBe(false);
		// The new flight's own landing arms normally.
		const today = T0 + 30 * MIN;
		const armed = foldAutoStop(fold, input({ landingMs: today, lastMoveMs: today, nowMs: today }));
		expect(armed.pending?.landingMs).toBe(today);
	});

	it('never fires on the spot when the preference is ticked on after a stale landing', () => {
		const fold = newAutoStopFold();
		const landing = T0 + 10 * MIN;
		// Recording with the preference off, landed and parked long since.
		foldAutoStop(fold, input({ enabled: false }));
		foldAutoStop(
			fold,
			input({ enabled: false, landingMs: landing, lastMoveMs: landing, nowMs: landing + 60 * MIN }),
		);
		// The checkbox: the enable rising edge suppresses the stale landing.
		const st = foldAutoStop(
			fold,
			input({ landingMs: landing, lastMoveMs: landing, nowMs: landing + 60 * MIN }),
		);
		expect(st.pending).toBeNull();
		expect(st.fire).toBe(false);
	});

	it('cancels the countdown when a new takeoff clears the landing', () => {
		const fold = newAutoStopFold();
		foldAutoStop(fold, input({}));
		const landing = T0 + 10 * MIN;
		expect(
			foldAutoStop(fold, input({ landingMs: landing, lastMoveMs: landing, nowMs: landing }))
				.pending,
		).not.toBeNull();
		// The stop-and-go: the motion fold re-arms and the landing is gone.
		const st = foldAutoStop(
			fold,
			input({ landingMs: null, lastMoveMs: landing + MIN, nowMs: landing + MIN }),
		);
		expect(st.pending).toBeNull();
	});

	it('is total for a landing with no movement fix at all', () => {
		const fold = newAutoStopFold();
		foldAutoStop(fold, input({}));
		const landing = T0 + 10 * MIN;
		const st = foldAutoStop(fold, input({ landingMs: landing, lastMoveMs: null, nowMs: landing }));
		expect(st.pending?.stopAtMs).toBe(landing + AUTO_STOP_GRACE_MS);
	});

	it('reads inert again once the caller has stopped the recording', () => {
		const fold = newAutoStopFold();
		foldAutoStop(fold, input({}));
		const landing = T0 + 10 * MIN;
		const fired = foldAutoStop(
			fold,
			input({ landingMs: landing, lastMoveMs: landing, nowMs: landing + AUTO_STOP_GRACE_MS }),
		);
		expect(fired.fire).toBe(true);
		const after = foldAutoStop(
			fold,
			input({ recording: false, landingMs: landing, lastMoveMs: landing, nowMs: landing + AUTO_STOP_GRACE_MS }),
		);
		expect(after.pending).toBeNull();
		expect(after.fire).toBe(false);
	});

	it('follows a whole outing through the motion fold', () => {
		// Taxi out, takeoff, cruise, landing, taxi in, standstill: the fold
		// pair end to end, the wiring's own recipe.
		const trace = pts([
			...span(0, 60, 5), // taxi out
			...span(60, 120, 80), // takeoff + climb (commits at 60 s)
			...span(120, 600, 100), // cruise
			...span(600, 660, 10), // rollout (landing commits at 600 s)
			...span(660, 720, 8), // taxi in
			...span(720, 1500, 0), // parked
		]);
		const motion = extendMotion(newMotionFold(), trace);
		expect(motion.landingMs).toBe(T0 + 600_000);
		expect(motion.lastMoveMs).toBe(T0 + 719_000);

		const fold = newAutoStopFold();
		// Recording started before the taxi: nothing suppressed, nothing
		// armed while airborne.
		expect(
			foldAutoStop(
				fold,
				input({ landingMs: null, lastMoveMs: T0 + 300_000, nowMs: T0 + 300_000 }),
			).pending,
		).toBeNull();
		// Parked: armed on the last movement, fires after the grace.
		const stopAt = motion.lastMoveMs! + AUTO_STOP_GRACE_MS;
		const armed = foldAutoStop(
			fold,
			input({ landingMs: motion.landingMs, lastMoveMs: motion.lastMoveMs, nowMs: T0 + 720_000 }),
		);
		expect(armed.pending).toEqual({ stopAtMs: stopAt, landingMs: motion.landingMs });
		expect(armed.fire).toBe(false);
		expect(
			foldAutoStop(
				fold,
				input({ landingMs: motion.landingMs, lastMoveMs: motion.lastMoveMs, nowMs: stopAt }),
			).fire,
		).toBe(true);
	});
});

describe('traceMotion', () => {
	it('extends the same trace in place and resets on a new reference', () => {
		// The rollout stays under LANDING_SUSTAIN_MS here, so the landing
		// commits only in the appended extension below.
		const trace = pts([...span(0, 60, 80), ...span(60, 700, 100), ...span(700, 730, 10)]);
		const first = traceMotion(trace);
		expect(first.takeoffMs).toBe(T0);
		expect(first.landingMs).toBeNull();
		// The same reference appended to: the same fold, advanced.
		trace.push(...pts([...span(730, 1000, 0)]));
		const again = traceMotion(trace);
		expect(again).toBe(first);
		expect(again.landingMs).toBe(T0 + 700_000);
		// A replaced trace (import / restore / clear) starts a fresh fold.
		const other = pts([...span(0, 30, 0)]);
		const fresh = traceMotion(other);
		expect(fresh).not.toBe(first);
		expect(fresh.takeoffMs).toBeNull();
	});
});
