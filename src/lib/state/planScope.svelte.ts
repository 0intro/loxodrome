/* What a FLIGHT PLAN tells surfaces that also have to work without one.
 *
 * Seven of this app's answers are not properties of the thing being shown at
 * all. Which NOTAMs a corridor keeps, what period the planned flight covers,
 * what order a bulletin's aerodrome blocks come in, which traffic category's
 * entry conditions are the ones in force, which areas the reference data
 * must cover beyond the map, what the loaded briefing lacks for the
 * flight, and what the pilot noted a unit said of a zone for it: every one
 * is a fact about the route workspace,
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
 * is in force, data loaded for what the map shows, and a bulletin judged
 * against no flight, and a zone's state with no note on it. Loxodrome fills
 * all seven in state/flightScope.ts.
 *
 * Precedent: `setOutingSettledHook` (navRecording.svelte.ts) and
 * `setPaneCapHook` (workspace.svelte.ts), each a hook rather than an import so
 * that the module below never reads the module above. This one is `$state`
 * rather than their plain `let` for one reason: `filteredNotams()`'s memo KEY
 * reads it. A plain slot filled after a first read would be silently missed for
 * the life of that memo, where a reactive one invalidates it.
 */

import type { BriefingVerdict } from '$lib/notam/briefingVerdict';
import type { Notam } from '$lib/notam/types';
import type { CoverageArea } from '$lib/state/coverage.svelte';
import type { ZoneNote } from '$lib/state/zoneNotes.svelte';

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
	/** The window a NOTAM fetch for the flight asks for: its span while it is
	 *  still to come, else from the current minute (timeWindow.svelte.ts
	 *  briefingWindow). Null when no trip has two waypoints. */
	briefingWindow: () => { from: number; to: number } | null;
}

/** The pilot's notes of what a unit said of a zone (state/zoneNotes.svelte.ts),
 *  by the zone's volume id: what settles a zone that may be active
 *  (state/activity.svelte.ts), and the panel's means to take and clear one
 *  (detail/ZoneNote.svelte). */
export interface ZoneNotesScope {
	/** The note in force on the zone `id`, null where there is none. */
	note: (id: string) => ZoneNote | null;
	/** Every note kept, by zone id, a new object at each change. */
	all: () => Readonly<Record<string, ZoneNote>>;
	set: (id: string, note: ZoneNote) => void;
	clear: (id: string) => void;
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
	/** The loaded briefing judged against the planned flight
	 *  (state/briefing.svelte.ts): what a printed bulletin states under its
	 *  head. */
	briefingVerdict: (() => BriefingVerdict) | null;
	/** The pilot's notes on zones for the flight. */
	zoneNotes: ZoneNotesScope | null;
}>({
	flight: null,
	corridor: null,
	aerodromeRank: null,
	flightRules: null,
	extent: null,
	briefingVerdict: null,
	zoneNotes: null,
});
