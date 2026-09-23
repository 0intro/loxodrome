/* Which publishers' features are drawn, pushed to the layers that draw them.
 *
 * Two rules live here, both learned the hard way, and both of which a second
 * map would otherwise have to restate:
 *
 * ITERATE, NEVER NAME. The wanted set is read by walking PUBLISHERS, not by a
 * hand-kept list of countries. A list here silently produced a dead checkbox
 * for every publisher added after the first eight: Switzerland's and the United
 * States' obstacles ignored their toggle, and so did the airspaces of Georgia,
 * the Netherlands, Italy and the whole eAIP cohort. Nothing type-checks a call
 * list, so the loop is the only thing that can be correct by construction.
 *
 * PUSH ONLY WHAT CHANGED. Re-pushing all of them was affordable at eight and is
 * not at twenty-one: setAirspacePublisher re-sorts and re-stacks every visible
 * polygon. A flag set before a layer is built still lands, since the setters
 * record it and the build reconciles every entry against it.
 *
 * The SINKS are the caller's, because which layers exist differs per map.
 */

import { PUBLISHERS, layers, type Publisher } from '$lib/state/layers.svelte';

/** One layer's "draw this publisher or not" setter, already bound to its map. */
export type PublisherSink = (p: Publisher, on: boolean) => void;

/** A fresh cache of what has been pushed: nothing yet. One per map. */
export function noPublishersPushed(): Record<Publisher, boolean> {
	return Object.fromEntries(PUBLISHERS.map((p) => [p, true])) as Record<Publisher, boolean>;
}

/** Every publisher's current flag. Reading all of them is also what TRACKS all
 *  of them, so call this first in an effect, ahead of any early return. */
export function wantedPublishers(): Record<Publisher, boolean> {
	const want = {} as Record<Publisher, boolean>;
	for (const p of PUBLISHERS) {
		want[p] = layers.publisher[p];
	}
	return want;
}

/** Push the flags that differ from `pushed` to every sink, updating `pushed` in
 *  place. True when anything moved, which is the caller's cue to repaint
 *  whatever draws downstream of the change. */
export function pushChangedPublishers(
	pushed: Record<Publisher, boolean>,
	want: Record<Publisher, boolean>,
	sinks: readonly PublisherSink[],
): boolean {
	let moved = false;
	for (const p of PUBLISHERS) {
		if (pushed[p] === want[p]) {
			continue;
		}
		pushed[p] = want[p];
		for (const sink of sinks) {
			sink(p, want[p]);
		}
		moved = true;
	}
	return moved;
}
