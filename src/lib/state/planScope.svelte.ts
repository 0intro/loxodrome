/* What a FLIGHT PLAN tells surfaces that also have to work without one.
 *
 * Four of this app's answers are not properties of the thing being shown at
 * all. Which NOTAMs a corridor keeps, what period the planned flight covers,
 * what order a bulletin's aerodrome blocks come in, and which traffic
 * category's entry conditions are the ones in force: every one is a fact about
 * the route workspace, read by a surface that is otherwise about a briefing or
 * an airspace.
 *
 * They cannot arrive as parameters. `filteredNotams()` and `activeEvalWindow()`
 * are zero-argument global selectors by doctrine, read by about thirty
 * always-live selectors and memoised on a signature string; threading a
 * corridor and a flight span through every call site would invert the very
 * chokepoint they exist to be. So they arrive here instead, as nullable
 * providers an app registers once at boot.
 *
 * NULL IS NOT A DEGRADED MODE. It is the honest answer of an app with no route
 * workspace: no corridor clause, no flight period offered, no aerodrome rank,
 * and an airspace panel that prints BOTH published entry clauses because
 * neither is in force. Loxodrome fills all four in state/flightScope.ts.
 *
 * Precedent: `setOutingSettledHook` (navRecording.svelte.ts) and
 * `setPaneCapHook` (workspace.svelte.ts), each a hook rather than an import so
 * that the module below never reads the module above. This one is `$state`
 * rather than their plain `let` for one reason: `filteredNotams()`'s memo KEY
 * reads it. A plain slot filled after a first read would be silently missed for
 * the life of that memo, where a reactive one invalidates it.
 */

import type { Notam } from '$lib/notam/types';

/** The planned flight, as the period surfaces need it. One object rather than
 *  three slots so that "there is a flight" and "here is its span" cannot
 *  disagree: a half-registered scope would offer a Flight period that resolves
 *  to nothing. */
export interface PlanFlight {
	/** Its span, or null when no plan resolves one (no trip of two waypoints,
	 *  no cruise speed to fly it at). */
	window: () => { from: number; to: number } | null;
	/** Is there a route a span could be derived from? Drives whether the
	 *  period's Flight option is offered at all, and must not depend on the
	 *  mode already being 'flight'. */
	flyable: () => boolean;
	/** Was a departure time STATED, or is the span the flight's whole day? The
	 *  fallback must never be worded as a stated one. */
	etdStated: () => boolean;
}

/** The route-corridor NOTAM filter: the source ids to keep, or null when the
 *  toggle is off or no route has a corridor. Signature is
 *  notamCorridor.svelte.ts's own. */
export type CorridorFilter = (notams: Notam[], parsedAt: number) => ReadonlySet<string> | null;

export const planScope = $state<{
	flight: PlanFlight | null;
	corridor: CorridorFilter | null;
	/** Each route aerodrome's ICAO ident mapped to its position along the
	 *  routes: the aerodrome-block order SOFIA gives a bulletin. */
	aerodromeRank: (() => Map<string, number>) | null;
	/** The flight rules in force, which decide WHICH published entry condition
	 *  an airspace panel says was applied. */
	flightRules: (() => 'vfr' | 'ifr') | null;
}>({
	flight: null,
	corridor: null,
	aerodromeRank: null,
	flightRules: null,
});
