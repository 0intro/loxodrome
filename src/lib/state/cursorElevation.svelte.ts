/* The ground under the map cursor, for the bottom-left coordinate badge
 * (components/CursorCoords.svelte).
 *
 * The number itself is the one every other terrain surface reads,
 * `elevationFtAt`: the route profile's ground line, the map altitude profile
 * and the airspace alert engine's AGL all answer from the same point query,
 * so the badge cannot disagree with the chart beside it.
 *
 * What is special here is the RATE. Terrain is a network read and mousemove
 * is a firehose; terrain.ts's runLimited is a FIFO queue rather than a
 * dropper, so an ungated readout would not be rejected, it would build an
 * unbounded backlog behind six sockets and keep asking the chart worker for
 * tiles nobody will look at. Four rules, in the order they apply, and the one
 * to remember is that THE BADGE NEVER FETCHES WHILE THE POINTER IS MOVING:
 *
 *  1. Ask only for what is shown. No badge on screen, no probe.
 *  2. Answer from what is already decoded. `peekElevationFtAt` is a handful
 *     of Map lookups, so over ground already read (a planned route's
 *     corridor, a profile, an offline pin, or anywhere the pointer has
 *     rested before) the badge tracks the pointer at frame rate for nothing.
 *  3. On a miss, arm a TRAILING debounce. Sweeping the map issues no
 *     requests at all; only a pointer that comes to rest asks. Deliberately
 *     not the leading+trailing throttle MapView's hash restamp uses: there,
 *     starving during continuous motion would be the bug, here it is the
 *     point, because an answer for a place the pointer has already left is
 *     worth nothing and costs a tile.
 *  4. One query in flight, DROPPED and not queued (the ensureGround shape in
 *     state/airspaceAlert). On settle it re-reads whatever is under the
 *     pointer now, usually inside the tile just fetched, and re-arms only if
 *     that is still unknown.
 *
 * Locality then does the rest: one resting probe decodes a whole tile, about
 * 6.9 km square at z12 and 45 N, after which every point inside it is a free
 * peek; and getTile caches a settled null, so a hole is probed once ever. A
 * pixel-level hysteresis on top would be dead code for that reason.
 *
 * The bucket below is what makes the ceiling statable rather than argued.
 *
 * Plain module lets for the timer, the in-flight flag and the bucket,
 * deliberately outside $state: they are the machine, not the readout, and
 * nothing may re-render on them (the routeTerrain / filter idiom). */

import { display } from '$lib/state/display.svelte';
import { elevationFtAt, peekElevationFtAt } from '$lib/map/terrain';
import { ui } from '$lib/state/ui.svelte';

/** How long the pointer must rest before the badge is worth a tile. */
const PROBE_IDLE_MS = 150;

/** The badge's own ceiling on tile reads, as a token bucket: at most
 *  PROBE_BUDGET probes, refilled one a second. Rules 1 to 4 keep an ordinary
 *  session in the single digits, so a user never reaches this; it is here so
 *  the bound can be STATED, not argued. Spent, the badge falls back to
 *  peek-only until it refills, which reads as a value that stops following
 *  onto new ground rather than as an error. */
const PROBE_BUDGET = 60;
const PROBE_REFILL_MS = 1000;

/** Ground under the cursor in feet, null while unknown (nothing decoded yet,
 *  or the source states no data there). The badge prints the placeholder for
 *  null rather than holding a stale reading: an elevation from the last place
 *  the pointer was is a lie, and the debounce fills this in within a beat. */
export const cursorElevation = $state<{ ft: number | null }>({ ft: null });

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let probePending = false;
/** The point the pointer is over, i.e. what a settling probe should answer
 *  for. Read at settle rather than captured per request, so a probe that
 *  landed late still updates the badge to where the pointer actually is. */
let wanted: { lat: number; lon: number } | null = null;
let tokens = PROBE_BUDGET;
let tokensAtMs = 0;

/** One token, or false when the budget is spent. Refills by elapsed time, so
 *  no interval has to run while the map sits idle. */
function takeToken(nowMs: number): boolean {
	if (tokensAtMs === 0) {
		tokensAtMs = nowMs;
	}
	const refill = Math.floor((nowMs - tokensAtMs) / PROBE_REFILL_MS);
	if (refill > 0) {
		tokens = Math.min(PROBE_BUDGET, tokens + refill);
		tokensAtMs += refill * PROBE_REFILL_MS;
	}
	if (tokens <= 0) {
		return false;
	}
	tokens--;
	return true;
}

/** The badge is on screen: it is gated on the same preference CursorCoords
 *  renders under, and hidden outright on a phone (where mousemove does not
 *  fire anyway, and the sheet owns the bottom edge). */
function badgeShown(): boolean {
	return display.cursorCoords && !ui.isMobile;
}

function armTimer(): void {
	if (idleTimer !== null) {
		clearTimeout(idleTimer);
	}
	idleTimer = setTimeout(runProbe, PROBE_IDLE_MS);
}

/** Write whatever is already decoded for the point under the pointer. True
 *  when that answered (a number, or a definite "no data"), false when a tile
 *  is still needed. */
function writeFromPeek(): boolean {
	if (!wanted) {
		return true;
	}
	const ft = peekElevationFtAt(wanted.lat, wanted.lon);
	cursorElevation.ft = ft ?? null;
	return ft !== undefined;
}

function runProbe(): void {
	idleTimer = null;
	if (probePending || !wanted || !badgeShown()) {
		return; // a settling probe re-arms; a hidden badge asks for nothing
	}
	if (!takeToken(Date.now())) {
		return;
	}
	probePending = true;
	const { lat, lon } = wanted;
	void elevationFtAt(lat, lon)
		.catch(() => null)
		.finally(() => {
			probePending = false;
			// The tile is in the shared cache now, so the answer for wherever
			// the pointer has got to comes out of the peek: no result is
			// carried across, and none can land on the wrong point.
			if (!writeFromPeek() && badgeShown()) {
				armTimer();
			}
		});
}

/** The pointer is over (lat, lon). Answers from what is already decoded, in
 *  this frame, and arms a fetch only once the pointer comes to rest. */
export function probeCursorElevation(lat: number, lon: number): void {
	if (!badgeShown()) {
		return;
	}
	wanted = { lat, lon };
	if (writeFromPeek()) {
		// Known, one way or the other: nothing left to ask for.
		cancelProbe();
		return;
	}
	armTimer();
}

/** Drop the pending fetch, for the map's teardown. Deliberately NOT called
 *  when the pointer leaves the map or the view moves under it: the badge
 *  freezes its coordinate at that same instant, so an armed probe is
 *  answering for the point still on screen, and dropping it leaves the line
 *  on its placeholder. Under follow mode, where the map pans about once a
 *  second with no mousemove, that stranded it for the whole flight. */
export function cancelCursorElevation(): void {
	cancelProbe();
}

function cancelProbe(): void {
	if (idleTimer !== null) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
}

/** Test hook: forget the pending fetch, the point and the budget. */
export function resetCursorElevation(): void {
	cancelProbe();
	probePending = false;
	wanted = null;
	tokens = PROBE_BUDGET;
	tokensAtMs = 0;
	cursorElevation.ft = null;
}
