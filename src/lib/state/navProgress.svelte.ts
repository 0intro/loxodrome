/* Shared along-route progress checkpoints: the ONE active trace (nav.points)
 * folded against a route's waypoints (nav/routeProgress), memoised and
 * extended in place per appended fix, feeding the merged live selector
 * (state/navLive.svelte.ts). Reactive reads (points ref / length / head time
 * / waypoint coords / the pilot's leg pins) happen BEFORE the cache check,
 * the notamCorridor idiom, so callers track appends, trace resets, route
 * edits and corrections. Same ref with a grown length extends in place;
 * anything else (import, clear, the MAX_POINTS front-splice shifting the
 * head, a moved waypoint, a new leg pin) recomputes and hands out a FRESH
 * checkpoints array, so downstream memos may key on the array reference.
 * Contract: docs/nav-live.md. */

import { nav } from './navRecording.svelte';
import { legPinsFor } from './navRoute.svelte';
import {
	computeRouteProgress,
	extendRouteProgress,
	type LegPin,
	type RouteProgressPoint,
} from '$lib/nav/routeProgress';
import type { TrackPoint } from '$lib/nav/trace';
import type { Waypoint } from './route.svelte';

interface ProgressMemo {
	points: TrackPoint[];
	len: number;
	firstTimeMs: number;
	checkpoints: RouteProgressPoint[];
}

const MEMO_MAX = 8;
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a fold cache read through a plain function, never rendered
const progressMemo = new Map<string, ProgressMemo>();

/** The active trace's progress checkpoints against these waypoints, folded
 *  from `fromIdx` on (empty under two waypoints, the fold's own rule). Call
 *  inside $derived / $effect.
 *
 *  Keyed rather than single-entry: a plan of consecutive legs evaluates one
 *  leg per surface and pages between them, and a single entry would recompute
 *  the whole fold on every alternation. The key carries the geometry, the
 *  segment start, the pilot's leg pins and the caller's own id, since two legs
 *  of one plan can share a coordinate list (a there-and-back). A new pin
 *  therefore re-keys, which recomputes and hands out a FRESH array: the
 *  stamps re-derive against the corrected axis exactly as they do after a
 *  waypoint is moved. */
export function traceRouteCheckpoints(
	waypoints: Waypoint[],
	fromIdx = 0,
	id = '',
): RouteProgressPoint[] {
	const points = nav.points;
	const len = points.length;
	const firstTimeMs = len > 0 ? points[0].timeMs : 0;
	const pins = legPinsFor(id);
	const key = `${id}|${fromIdx}|${pinKey(pins)}|${waypoints.map((w) => `${w.lat},${w.lon}`).join(';')}`;
	const hit = progressMemo.get(key);
	if (hit && hit.points === points && hit.firstTimeMs === firstTimeMs && hit.len <= len) {
		if (hit.len < len) {
			extendRouteProgress(hit.checkpoints, points, waypoints, fromIdx, pins);
			hit.len = len;
		}
		return hit.checkpoints;
	}
	if (progressMemo.size >= MEMO_MAX) {
		progressMemo.clear(); // tiny bound; at most the plan's leg count is live
	}
	const entry: ProgressMemo = {
		points,
		len,
		firstTimeMs,
		checkpoints: computeRouteProgress(points, waypoints, fromIdx, pins),
	};
	progressMemo.set(key, entry);
	return entry.checkpoints;
}

function pinKey(pins: readonly LegPin[]): string {
	return pins.map((p) => `${p.legIdx}@${p.sinceMs}`).join(',');
}
