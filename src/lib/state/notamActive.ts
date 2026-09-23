/* Is this NOTAM in force over the range the caller is asking about?
 *
 * Two questions every override resolver asks before it changes anything the
 * AIP published: the B)/C) validity has to reach into the range, and the D)
 * day schedule has to be in force during it. The second answers null for a
 * schedule outside the parsed subset, which every applier turns into a flag
 * or a note and never into an action (docs/notam-relationships.md).
 *
 * One copy, shared by the frequency, fuel, runway, aerodrome and navaid
 * resolvers: they asked the same two questions in the same words, and a
 * consumer arriving with its own copy is how they would drift apart. The
 * frequency overrides are gated on validIn too: a future-dated change must
 * not move a frequency today (freqOverride applied them date-blind once).
 * Pure. */

import { notamAnchor } from '$lib/notam/geometry';
import { parseItemD, scheduleActiveIn } from '$lib/notam/schedule';
import { notamSections } from '$lib/notam/sections';
import type { Notam } from '$lib/notam/types';
import { sunLookupFor } from '$lib/route/sun';
import { notamSpanMs } from './notam.svelte';
import type { ResolveAt } from './freqOverride.svelte';

/** The NOTAM's own B)/C) validity reaches into the range being asked about:
 *  a withdrawal that ended last week does not strike anything today. */
export function validIn(n: Notam, at: ResolveAt): boolean {
	const { start, end } = notamSpanMs(n);
	return start <= at.toMs && end >= at.fromMs;
}

/** Whether the NOTAM is in force over `at`: its validity AND its D) day
 *  schedule. null = unknown, which the callers' ladders turn into a flag.
 *
 *  The sun is read at the NOTAM's own position, which is what a D) item
 *  anchored on SR/SS means; without a position it stays unknown. */
export function activeIn(n: Notam, at: ResolveAt): boolean | null {
	const d = notamSections(n).D;
	const item = d != null && d.trim() !== '' ? parseItemD(d) : undefined;
	const a = notamAnchor(n);
	return scheduleActiveIn(
		notamSpanMs(n),
		item,
		{ fromMs: at.fromMs, toMs: at.toMs },
		a ? sunLookupFor(a.lat, a.lon) : undefined,
	);
}
