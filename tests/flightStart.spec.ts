/* What the flight button does with the loaded trace (nav/flightStart.ts):
 * decided by how the trace ENDED and where it came from, never by its age
 * alone, and always knowing what a new flight would drop. */

import { describe, expect, it } from 'vitest';
import { extendMotion, newMotionFold } from '$lib/nav/navlogLive';
import {
	CLOCK_SKEW_MS,
	RESUME_SILENT_MS,
	flightDecision,
	flightOpen,
	traceEnd,
	type EndDeps,
	type FlightStartInput,
} from '$lib/nav/flightStart';
import { OUTING_MS } from '$lib/nav/outing';
import type { TrackPoint } from '$lib/nav/trace';

const T0 = Date.UTC(2026, 6, 21, 10, 0);
const FIELD_FT = 400;
const MIN = 60_000;

/** A trace in phases of [seconds, knots, altitude], one fix a second. */
function phased(phases: [number, number, number | null][], base = T0): TrackPoint[] {
	const pts: TrackPoint[] = [];
	let lon = 0;
	let t = 0;
	for (const [dur, kt, altFt] of phases) {
		for (let s = 0; s < dur; s++) {
			pts.push({ lat: 0, lon, timeMs: base + t * 1000, altFt, speedKt: kt, trackDeg: 90, accuracyM: null });
			lon += kt / (3600 * 3600);
			t++;
		}
	}
	return pts;
}

const TAKEOFF: [number, number, number | null][] = [
	[20, 5, FIELD_FT],
	[8, 50, FIELD_FT],
	[150, 80, 1600],
];
const flying = (): TrackPoint[] => phased(TAKEOFF);
/** Landed: a minute and a half under the landing speed commits it. */
const landed = (): TrackPoint[] => phased([...TAKEOFF, [90, 10, FIELD_FT]]);
/** Stopped twenty seconds into the rollout, on the field. */
const rollout = (): TrackPoint[] => phased([...TAKEOFF, [20, 10, FIELD_FT]]);
/** A taxi that never took off. */
const taxi = (): TrackPoint[] => phased([[60, 8, FIELD_FT]]);

const onField: EndDeps = { altMslFt: (p) => p.altFt, fieldElevFt: () => FIELD_FT };
const nowhere: EndDeps = { altMslFt: (p) => p.altFt, fieldElevFt: () => null };

function decide(
	points: TrackPoint[],
	over: Partial<Omit<FlightStartInput, 'points' | 'motion'>> & { gapMs?: number } = {},
) {
	const last = points.length > 0 ? points[points.length - 1].timeMs : T0;
	return flightDecision({
		points,
		motion: extendMotion(newMotionFold(), points),
		deps: over.deps ?? onField,
		origin: over.origin === undefined ? 'recording' : over.origin,
		filed: over.filed ?? true,
		nowMs: over.nowMs ?? last + (over.gapMs ?? 5 * MIN),
		...(over.foreign !== undefined ? { foreign: over.foreign } : {}),
	});
}

describe('how a trace ended', () => {
	const end = (pts: TrackPoint[], deps = onField) =>
		traceEnd(pts, extendMotion(newMotionFold(), pts), deps);

	it('reads a trace that never took off as ground', () => {
		expect(end(taxi())).toBe('ground');
	});

	it('reads a committed landing as landed', () => {
		expect(end(landed())).toBe('landed');
	});

	it('reads a rollout cut short on a known field as landed, the logbook rule', () => {
		expect(end(rollout())).toBe('landed');
	});

	it('reads a slow end no known field confirms as slow', () => {
		expect(end(rollout(), nowhere)).toBe('slow');
	});

	it('reads an end at flying speed as airborne', () => {
		expect(end(flying())).toBe('airborne');
	});

	it('says a flight is open between its takeoff and its landing', () => {
		const fold = (pts: TrackPoint[]) => extendMotion(newMotionFold(), pts);
		expect(flightOpen(fold(flying()))).toBe(true);
		expect(flightOpen(fold(rollout()))).toBe(true);
		expect(flightOpen(fold(landed()))).toBe(false);
		expect(flightOpen(fold(taxi()))).toBe(false);
	});
});

describe('what the flight button does', () => {
	it('starts a new flight with nothing loaded', () => {
		expect(decide([])).toEqual({
			kind: 'new',
			end: null,
			lastFixMs: null,
			landedMs: null,
			discard: null,
			appendable: false,
		});
	});

	it('resumes a recording stopped in the air, inside the silent window', () => {
		expect(decide(flying(), { gapMs: 5 * MIN }).kind).toBe('resume');
		expect(decide(flying(), { gapMs: RESUME_SILENT_MS - 1 }).kind).toBe('resume');
		expect(decide(flying(), { gapMs: -CLOCK_SKEW_MS }).kind).toBe('resume');
	});

	it('asks past the silent window, or across a skewed clock', () => {
		expect(decide(flying(), { gapMs: RESUME_SILENT_MS }).kind).toBe('ask');
		expect(decide(flying(), { gapMs: -CLOCK_SKEW_MS - 1 }).kind).toBe('ask');
	});

	it('asks for a trace that never took off, and says a new flight drops it', () => {
		const d = decide(taxi(), { gapMs: 2 * MIN, filed: false });
		expect(d.kind).toBe('ask');
		expect(d.end).toBe('ground');
		expect(d.discard).toBe('noTakeoff');
	});

	it('asks for a slow end no known field confirms', () => {
		const d = decide(rollout(), { deps: nowhere, gapMs: 2 * MIN });
		expect(d.kind).toBe('ask');
		expect(d.end).toBe('slow');
	});

	it('starts a new flight after a landing, offering to add to the trace', () => {
		const d = decide(landed(), { gapMs: 90 * MIN });
		expect(d).toMatchObject({ kind: 'new', end: 'landed', discard: null, appendable: true });
	});

	it('says when a landed trace landed, the rollout it was cut in included', () => {
		// The slow streak opens at the end of the TAKEOFF phases.
		const touchdown = T0 + (20 + 8 + 150) * 1000;
		expect(decide(landed()).landedMs).toBe(touchdown);
		expect(decide(rollout()).landedMs).toBe(touchdown);
		expect(decide(flying()).landedMs).toBeNull();
		expect(decide(rollout(), { deps: nowhere }).landedMs).toBeNull();
	});

	it('says what a new flight drops when the library does not hold the flight', () => {
		expect(decide(landed(), { filed: false }).discard).toBe('unsaved');
	});

	it('leaves the outing window to a plain new flight', () => {
		const old = decide(landed(), { gapMs: OUTING_MS });
		expect(old).toMatchObject({ kind: 'new', appendable: false });
		const lost = decide(flying(), { gapMs: OUTING_MS + MIN });
		expect(lost.kind).toBe('new');
	});

	it('never resumes or extends what is not this device recording', () => {
		for (const origin of ['import', 'library', 'unknown'] as const) {
			expect(decide(flying(), { origin, gapMs: MIN })).toMatchObject({ kind: 'new', appendable: false });
			expect(decide(landed(), { origin, gapMs: MIN })).toMatchObject({ kind: 'new', appendable: false });
		}
	});

	it('never resumes or extends a trace a shared sign-in found, whatever recorded it', () => {
		// The device's own recording, inside every window, and still not the
		// signed-in pilot's to add a flight to (sync/found.ts).
		expect(decide(flying(), { gapMs: MIN, foreign: true })).toMatchObject({ kind: 'new', appendable: false });
		expect(decide(landed(), { gapMs: MIN, foreign: true })).toMatchObject({ kind: 'new', appendable: false });
		// What it is stays said: how it ended, and when.
		expect(decide(landed(), { foreign: true })).toMatchObject({ end: 'landed', discard: null });
		expect(decide(landed(), { foreign: false })).toMatchObject({ kind: 'new', appendable: true });
	});

	it('treats a trace without a wall clock as no flight to keep', () => {
		// A drawn line on the synthesised clock from the epoch: the library
		// refuses it whatever takeoff its fake speeds commit.
		const drawn = phased(TAKEOFF, 0);
		expect(decide(drawn, { origin: 'import', filed: false, nowMs: Date.now() }).discard).toBe(
			'noClock',
		);
	});
});
