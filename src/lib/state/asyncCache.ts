/* The async caches' shared guard helpers, and ONLY the guards: freshness
 * against a TTL, and the keyed abort/supersede check an abortable fetch's
 * settle re-states. The full cache lifecycle stays per module by decision
 * (docs/simplicity-review-2026-07.md "Deferred"): those modules carry
 * written untrack reactivity contracts, and a shared lifecycle that got
 * untrack placement wrong would break them all at once as silent effect
 * loops. */

/** A cache stamp is fresh while its age is under the TTL. Takes the raw
 *  timestamp (ms epoch), so every stamp shape fits: a record field
 *  (weather's fetchedAt, sofiaCharts' / sigmets' fetchedAtMs, the METAR
 *  tiles' atMs), a per-key number map (routeWind), or a failure-cooldown
 *  stamp (routeTerrain's retry pacing). A missing stamp (undefined /
 *  null) reads stale, and so does the 0 the stores initialise with (a
 *  1970 stamp is decades past any TTL). */
export function isFresh(
	atMs: number | null | undefined,
	ttlMs: number,
	nowMs = Date.now(),
): boolean {
	return atMs != null && nowMs - atMs < ttlMs;
}

/** The keyed supersede guard of an abortable per-slot fetch (routeTerrain /
 *  routeWind): a settle (then AND catch) may commit only while its own
 *  request is still the slot's CURRENT one, i.e. not aborted and the
 *  slot's key still the one this fetch started under (a newer ensure
 *  overwrites the key before aborting, so both checks are needed: abort
 *  delivery is async, and a same-key restart swaps the controller). */
export function settleGuard(
	signal: AbortSignal,
	stillCurrent: () => boolean,
): () => boolean {
	return () => !signal.aborted && stillCurrent();
}
