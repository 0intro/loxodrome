/* The ONE motion fold over the active trace: the outing's takeoff, landing
 * and block times (nav/navlogLive.ts), shared by the live nav-log selector
 * (state/navLive.svelte.ts) and the recording auto-stop evaluator, which
 * must answer ROUTELESS where the selector gates on a two-waypoint route.
 * Keyed on the points array REFERENCE (navRecording appends in place and
 * replaces the reference on an import / restore / clear) and on its head
 * instant (the in-memory cap drops the oldest fixes in place, which refolds,
 * the checkpoint memo's rule), and extended in place per call, so the
 * second caller per change is a cursor no-op. The points come in as a
 * parameter, keeping the module free of reactive imports; the element reads
 * inside extendMotion are what a $derived / $effect caller tracks. */

import { extendMotion, newMotionFold, type MotionFold } from '$lib/nav/navlogLive';
import type { TrackPoint } from '$lib/nav/trace';

let memo: { points: readonly TrackPoint[]; headMs: number; fold: MotionFold } | null = null;

/** The motion facts folded over this trace, extended to its current end. */
export function traceMotion(points: readonly TrackPoint[]): MotionFold {
	const headMs = points.length > 0 ? points[0].timeMs : 0;
	if (!memo || memo.points !== points || memo.headMs !== headMs) {
		memo = { points, headMs, fold: newMotionFold() };
	}
	return extendMotion(memo.fold, points);
}
