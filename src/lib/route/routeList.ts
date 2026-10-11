/* Pure reducers for the multi-route list: add / remove / set-active, each
 * returning a new { list, activeId } so the reactive wrappers in
 * route.svelte.ts stay thin and the logic is unit-testable without a Svelte
 * runtime. Generic over `{ id }` so tests can use plain objects. */

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

/** Move the route at `from` to index `to` (both clamped); active id unchanged.
 *  Returns `s` unchanged when the move is a no-op. */
export function reorderRouteIn<R extends { id: string }>(
	s: RouteListState<R>,
	from: number,
	to: number,
): RouteListState<R> {
	const n = s.list.length;
	if (from < 0 || from >= n) {
		return s;
	}
	const dst = Math.max(0, Math.min(n - 1, to));
	if (dst === from) {
		return s;
	}
	const list = [...s.list];
	const [moved] = list.splice(from, 1);
	list.splice(dst, 0, moved);
	return { list, activeId: s.activeId };
}
