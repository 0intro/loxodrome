/* Pure reducers for the multi-route list: add, remove, set-active and the
 * moves, each returning a new { list, activeId } so the reactive wrappers in
 * route.svelte.ts stay thin and the logic is unit-testable without a Svelte
 * runtime. Generic over `{ id }` so tests can use plain objects. */

import { stopBaseKey, type RouteLike, type StopWaypoint } from '$lib/aircraft/trips';

export interface RouteListState<R extends { id: string }> {
	list: R[];
	activeId: string;
}

/** Append `route` and make it active, unless the list is already at `max`. */
export function addRouteTo<R extends { id: string }>(
	s: RouteListState<R>,
	route: R,
	max: number,
): RouteListState<R> {
	if (s.list.length >= max) {
		return s;
	}
	return { list: [...s.list, route], activeId: route.id };
}

/** Remove route `id`; refuses to drop the last one (returns unchanged). When the
 *  active route is removed, the previous neighbour (or the first) becomes active. */
export function removeRouteFrom<R extends { id: string }>(
	s: RouteListState<R>,
	id: string,
): RouteListState<R> {
	if (s.list.length <= 1) {
		return s;
	}
	const idx = s.list.findIndex((r) => r.id === id);
	if (idx < 0) {
		return s;
	}
	const list = s.list.filter((r) => r.id !== id);
	const activeId = s.activeId === id ? list[Math.max(0, idx - 1)].id : s.activeId;
	return { list, activeId };
}

/** Activate route `id` if it is in the list, else leave unchanged. */
export function setActiveIn<R extends { id: string }>(
	s: RouteListState<R>,
	id: string,
): RouteListState<R> {
	return s.list.some((r) => r.id === id) ? { list: s.list, activeId: id } : s;
}

/** The routes a move of the route at `i` carries, as [start, end): a trip
 *  with the alternates that follow it up to the next trip, so a trip never
 *  leaves its alternate behind, or an alternate alone. */
function blockAt(list: readonly RouteLike[], i: number): [number, number] {
	let end = i + 1;
	if (!list[i].alternate) {
		while (end < list.length && list[end].alternate) {
			end += 1;
		}
	}
	return [i, end];
}

/** The positions route `id` may take, ascending: the gaps of the list
 *  without the route's block, its own gap included. A trip goes before a
 *  trip or at the end, so every alternate keeps its trip. An alternate goes
 *  right after a trip that holds none, the trip it then attaches to, never
 *  above the first trip. Nothing goes above `floor`, and a route above it
 *  keeps its place (the routes a recorded flight has flown). */
export function routeSlots<R extends RouteLike & { id: string }>(
	list: readonly R[],
	id: string,
	floor = 0,
): number[] {
	const i = list.findIndex((r) => r.id === id);
	if (i < 0) {
		return [];
	}
	const [start, end] = blockAt(list, i);
	if (start < floor) {
		return [start];
	}
	const rest = [...list.slice(0, start), ...list.slice(end)];
	const trip = (k: number): boolean => k >= 0 && k < rest.length && !rest[k].alternate;
	const slots: number[] = [];
	for (let g = floor; g <= rest.length; g++) {
		const fits = list[i].alternate
			? g - 1 >= floor && trip(g - 1) && (g === rest.length || trip(g))
			: g === rest.length || trip(g);
		if (fits || g === start) {
			slots.push(g);
		}
	}
	return slots;
}

/** Move route `id`, with its block, to slot `gap` (one routeSlots gave).
 *  The active id is unchanged; a move that changes nothing returns `s`. */
export function moveRouteToIn<R extends RouteLike & { id: string }>(
	s: RouteListState<R>,
	id: string,
	gap: number,
): RouteListState<R> {
	const i = s.list.findIndex((r) => r.id === id);
	if (i < 0) {
		return s;
	}
	const [start, end] = blockAt(s.list, i);
	const rest = [...s.list.slice(0, start), ...s.list.slice(end)];
	if (gap === start || gap < 0 || gap > rest.length) {
		return s;
	}
	return {
		list: [...rest.slice(0, gap), ...s.list.slice(start, end), ...rest.slice(gap)],
		activeId: s.activeId,
	};
}

/** Move route `id` one slot earlier (-1) or later (1). */
export function moveRouteIn<R extends RouteLike & { id: string }>(
	s: RouteListState<R>,
	id: string,
	delta: -1 | 1,
	floor = 0,
): RouteListState<R> {
	const i = s.list.findIndex((r) => r.id === id);
	if (i < 0) {
		return s;
	}
	const [start] = blockAt(s.list, i);
	const slots = routeSlots(s.list, id, floor);
	const to = delta < 0 ? slots.filter((g) => g < start).at(-1) : slots.find((g) => g > start);
	return to === undefined ? s : moveRouteToIn(s, id, to);
}

/** The slot nearest `gap`, the earlier of two as near. */
export function nearestSlot(slots: readonly number[], gap: number): number | null {
	let best: number | null = null;
	for (const g of slots) {
		if (best === null || Math.abs(g - gap) < Math.abs(best - gap)) {
			best = g;
		}
	}
	return best;
}

/** The slot a drop before the route at list index `ins` lands in (`ins` =
 *  the list's length: after the last): the nearest routeSlots gives. */
export function dropSlot<R extends RouteLike & { id: string }>(
	list: readonly R[],
	id: string,
	ins: number,
	floor = 0,
): number | null {
	const i = list.findIndex((r) => r.id === id);
	if (i < 0) {
		return null;
	}
	const [start, end] = blockAt(list, i);
	const gap = ins <= start ? ins : ins >= end ? ins - (end - start) : start;
	return nearestSlot(routeSlots(list, id, floor), gap);
}

/** The list index the drop bar stands before (the list's length: after the
 *  last route) when route `id` moves to slot `gap`; null for its own slot. */
export function dropBarIndex<R extends RouteLike & { id: string }>(
	list: readonly R[],
	id: string,
	gap: number,
): number | null {
	const i = list.findIndex((r) => r.id === id);
	if (i < 0) {
		return null;
	}
	const [start, end] = blockAt(list, i);
	if (gap === start) {
		return null;
	}
	return gap < start ? gap : gap + (end - start);
}

/** The slot that binds alternate `id` to the trip it diverts from: right
 *  after the trip, holding no alternate, that arrives where the alternate
 *  departs, matched by the stop key the refuel stops use (the ident, else
 *  the position), the nearest before the alternate, else after it. Null
 *  when the alternate has no point yet or no such trip is free. */
export function departureSlot<R extends RouteLike & { id: string; waypoints: readonly StopWaypoint[] }>(
	list: readonly R[],
	id: string,
	floor = 0,
): number | null {
	const i = list.findIndex((r) => r.id === id);
	const from = list[i]?.waypoints[0];
	if (!from) {
		return null;
	}
	const key = stopBaseKey(from);
	const rest = list.filter((r) => r.id !== id);
	const fits = routeSlots(list, id, floor).filter((g) => {
		const trip = rest[g - 1];
		const end = trip?.waypoints[trip.waypoints.length - 1];
		return trip !== undefined && !trip.alternate && end !== undefined && stopBaseKey(end) === key;
	});
	const before = fits.filter((g) => g <= i);
	return before.length > 0 ? before[before.length - 1] : (fits[0] ?? null);
}

/** The first list position a move may take during a recording: past the
 *  last route the flight has flown or is flying, with the alternates
 *  behind it, so no move changes the order that cut the recorded trace.
 *  0 when nothing is flown. */
export function flownFloor<R extends RouteLike & { id: string }>(
	list: readonly R[],
	flownIds: readonly string[],
): number {
	let last = -1;
	list.forEach((r, i) => {
		if (flownIds.includes(r.id)) {
			last = i;
		}
	});
	return last < 0 ? 0 : blockAt(list, last)[1];
}
