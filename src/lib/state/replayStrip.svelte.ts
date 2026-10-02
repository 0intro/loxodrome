/* replayStrip.svelte.ts: the replay's transport on the map, on both layouts
 * (components/ReplayStrip.svelte; docs/nav-live.md "The replay strip").
 *
 * A finished trace on the map is a replay, and its strip is up with it:
 * after a stop, an import, a flight loaded from the library, a boot inside
 * the outing window. A recording owns the playhead, so the strip stands down
 * while one runs and comes back at the stop. It is the replay's one
 * transport: the Navigation tab keeps the trace's actions, and the trace
 * profile seats its Play only while the strip is folded.
 *
 * Its close FOLDS it into a chip at the map's foot, which a tap unfolds: the
 * trace stays, its line, the aircraft at the playhead and the trace profile
 * reading it as before (a close on the map never unloads what it closes;
 * the Navigation tab's Close and the library's unload take a trace off).
 * The fold is scoped to the trace ARRAY it was made on, the terrain
 * inhibit's idiom: every fresh session replaces the array (an import, a
 * restored outing, a cleared trace, a new recording), so a new trace shows
 * its controls with no hook anywhere, while a resumed flight appends in
 * place and keeps the fold.
 *
 * Map chrome, like the band: no placement, no history entry, never stored (a
 * replay does not outlive the session). */

import type { TrackPoint } from '$lib/nav/trace';
import { nav, togglePlay, traceReplayable } from './navRecording.svelte';

const strip = $state<{ foldedOn: readonly TrackPoint[] | null; scrubbing: boolean }>({
	foldedOn: null,
	scrubbing: false,
});

/** A replay is on the map: a finished trace, nothing recording. Reads
 *  reactive state. */
export function replayOpen(): boolean {
	return traceReplayable();
}

/** The strip is up: a replay is open and its strip is not folded on this
 *  trace. Reads reactive state. */
export function replayStripShown(): boolean {
	return replayOpen() && strip.foldedOn !== nav.points;
}

/** The strip's close: fold it into its chip. A replay left running with no
 *  transport on screen is what the strip exists to prevent, so it pauses
 *  too; the trace and the playhead stay. */
export function foldReplayStrip(): void {
	strip.foldedOn = nav.points;
	strip.scrubbing = false;
	if (nav.playing) {
		togglePlay();
	}
}

/** The chip: the strip back. */
export function unfoldReplayStrip(): void {
	strip.foldedOn = null;
}

/** A finger holds the scrubber: follow pans only near the view's edge until
 *  it lets go (map/navLayer.ts syncNavAircraft). */
export function setReplayScrub(on: boolean): void {
	strip.scrubbing = on;
}

/** The scrubber is held on a strip that is up. Reads reactive state. */
export function replayScrubbing(): boolean {
	return strip.scrubbing && replayStripShown();
}
