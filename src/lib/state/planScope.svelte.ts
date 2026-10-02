/* What a FLIGHT PLAN tells surfaces that also have to work without one.
 *
 * Five of this app's answers are not properties of the thing being shown at
 * all. Which NOTAMs a corridor keeps, what period the planned flight covers,
 * what order a bulletin's aerodrome blocks come in, which traffic category's
 * entry conditions are the ones in force, and which areas the reference data
 * must cover beyond the map: every one is a fact about the route workspace,
 * read by a surface that is otherwise about a briefing, an airspace or a
 * dataset.
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
 * an airspace panel that prints BOTH published entry clauses because neither
 * is in force, and data loaded for what the map shows. Loxodrome fills all
 * five in state/flightScope.ts.
 *
 * Precedent: `setOutingSettledHook` (navRecording.svelte.ts) and
 * `setPaneCapHook` (workspace.svelte.ts), each a hook rather than an import so
 * that the module below never reads the module above. This one is `$state`
 * rather than their plain `let` for one reason: `filteredNotams()`'s memo KEY
 * reads it. A plain slot filled after a first read would be silently missed for
 * the life of that memo, where a reactive one invalidates it.
 */

import type { Notam } from '$lib/notam/types';
import type { CoverageArea } from '$lib/state/coverage.svelte';

/** The planned flight, as the period surfaces need it. One object rather than
 *  three slots so that "there is a flight" and "here is its span" cannot
 *  disagree: a half-registered scope would offer a Flight period that resolves
 *  to nothing. */
export interface PlanFlight {
	/** Its span, its whole day when it has no times to go on (`timed`), or
	 *  null when no trip has two waypoints. */
	window: () => { from: number; to: number } | null;
	/** Is there a route a span could be derived from? Drives whether the
	 *  period's Flight option is offered at all, and must not depend on the
	 *  mode already being 'flight'. */
	flyable: () => boolean;
	/** Was a departure time STATED? Without one the window is the flight's
	 *  whole day, and the fallback must never be worded as a stated one. */
	etdStated: () => boolean;
	/** Does the window carry the flight's own times? False for the whole day:
	 *  no departure time stated, or none a cruise speed can fly. */
	timed: () => boolean;
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
	/** The areas the plan needs reference data for wherever the map is,
	 *  read by the coverage gate (state/coverage.svelte.ts). */
	extent: (() => readonly CoverageArea[]) | null;
}>({
	flight: null,
	corridor: null,
	aerodromeRank: null,
	flightRules: null,
	extent: null,
});
