/* Precipitation radar session cache: the EUMETNET OPERA composite frames a
 * loop holds, viewport-tiled, feeding the radarLayer canvas, the map-mounted
 * timeline and the Weather tab (docs/precipitation-radar.md).
 *
 * Two tiers of plain-Map cache. Tier A keeps each tile's COMPRESSED bytes
 * exactly as the proxy delivered them (5 to 160 KB a tile), the durable
 * store a loop replays from; tier B keeps the decoded cells (Int8 dBZ, or
 * Int16 tenths of mm/h) at the pooling the map is drawn at, rebuilt from
 * tier A on demand (an inflate off-thread, a few ms of conversion one tile
 * per macrotask). Both run under a byte budget, the phone's a quarter of
 * the desktop's in tier A and a third in tier B, and the loop the view is
 * OFFERED is capped by BOTH budgets
 * rather than thrashed through either (loopFrameCap). Frames are
 * content-addressed by PRODUCT and slot (every key carries the product, so
 * a fetch of the product before a switch can never seed a tile of one grid
 * under the other's key and draw it misplaced), a late arrival is never
 * wrong and no abort machinery exists; a tile no longer needed is simply
 * not asked for again. A product switch drops both tiers, the heads and
 * the index: the browser's private, immutable cache makes a toggle-back
 * cheap.
 *
 * Reactivity contract (the metarStations one): the caches and the frames
 * index live in plain module variables, consumers re-derive through four
 * counters, `indexSeq` (the frames list changed), `fetchSeq` (a frame's
 * tiles arrived or failed), `paintSeq` (a tile of the SHOWN frame is ready
 * to draw) and `viewSeq` (the view the loop is held for moved), and every
 * ensure-path status write happens inside
 * untrack(). The frames index is asked for at the instant the next frame
 * is expected, never blindly every minute (nextIndexPollMs); failures are
 * stamped so the minute tick retries at the module's own pace; a 429 stands
 * the fetches down behind a doubling timer (the windAloft rule). Everything
 * is gated on display.liveWeather AND the show-on-map toggle; hidden costs
 * nothing and frees both tiers. */

import { untrack } from 'svelte';
import { readItem, removeItem, writeItem } from './persist';
import { display } from './display.svelte';
import { nav } from './navRecording.svelte';
import { notamState } from './notam.svelte';
import { ui } from './ui.svelte';
import { t } from './i18n.svelte';
import { proxyBase } from '$lib/autorouter/state.svelte';
import { errorTextOf, type ErrorText } from '$lib/i18n/errorText';
import { inflateZlib } from '$lib/files/deflate';
import { isOperaLayout, parseTiledTiffHead, type TiffLayout } from '$lib/files/tiff';
import {
	OPERA_HEAD_BYTES,
	OPERA_PRODUCT_INFO,
	decodedTileBytes,
	frameAgeMs,
	frameUrl,
	framesUrl,
	loopFrameCap,
	loopFrames,
	monoNowMs,
	nextFrame,
	nextIndexPollMs,
	parseFramesIndex,
	radarStaleness,
	type FramesIndex,
	type OperaPooling,
	type OperaProduct,
	type RadarFrame,
	type Staleness,
} from '$lib/weather/opera';
import { decodeTile, maskPadding, maxPool, type RadarCells } from '$lib/weather/radarDecode';

const SHOW_KEY = 'loxodrome:radar-map';
const OPACITY_KEY = 'loxodrome:radar-opacity';
const COVERAGE_KEY = 'loxodrome:radar-coverage';
const LOOP_KEY = 'loxodrome:radar-loop';
/** 'seen' once the in-flight caution has been acknowledged. */
const CAUTION_KEY = 'loxodrome:radar-caution';
/** The product shown, stored only as 'RATE' (DBZH is the default). */
const PRODUCT_KEY = 'loxodrome:radar-product';

export const OPACITY_MIN_PCT = 30;
export const OPACITY_MAX_PCT = 100;
const OPACITY_DEFAULT_PCT = 70;

export type RadarLoopMin = 30 | 60 | 120;
export const RADAR_LOOPS: readonly RadarLoopMin[] = [30, 60, 120];
const LOOP_DEFAULT: RadarLoopMin = 60;

/** Hours of frames the index lists: a two-hour loop plus slack. */
const INDEX_HOURS = 3;
/** The index answer end to end; a frame answer's HEADERS, and the longest a
 *  frame's body may go without a byte (readFrameBody). */
const FETCH_TIMEOUT_MS = 20_000;
/** The longest a frame's body may take whole, however steadily it comes: a
 *  frame older than this by the time it lands has aged through most of the
 *  loop it was fetched for. */
const FRAME_BODY_MAX_MS = 5 * 60_000;
/** Whole frames in flight at once (a phone's socket and memory budget). */
const MAX_INFLIGHT = 2;
/** Concurrent tile decodes (the inflate runs off-thread; the conversion
 *  after it is one macrotask a tile). */
const MAX_DECODES = 2;
/** A failed or unpublished frame is asked for again after this. */
const FRAME_RETRY_MS = 60_000;
const RATE_LIMIT_RETRY_MS = 66_000;
const RATE_LIMIT_RETRY_MAX_MS = 15 * 60_000;
/** A refusal landing longer than this after the backoff timer fired belongs
 *  to a NEW incident: the retry pass's own requests (headers within
 *  FETCH_TIMEOUT_MS of the pass) had their answer by then and drew none. */
const RATE_LIMIT_QUIET_MS = 30_000;

function initialProduct(): OperaProduct {
	return readItem(PRODUCT_KEY) === 'RATE' ? 'RATE' : 'DBZH';
}

function initialOpacity(): number {
	const raw = readItem(OPACITY_KEY);
	if (raw == null) {
		return OPACITY_DEFAULT_PCT;
	}
	const n = Number(raw);
	return Number.isFinite(n) && n >= OPACITY_MIN_PCT && n <= OPACITY_MAX_PCT ? n : OPACITY_DEFAULT_PCT;
}

/** The loop length, persisted away from the default (the opacity idiom):
 *  a pilot who reads two hours of motion wants them again next time. */
function initialLoop(): RadarLoopMin {
	const raw = readItem(LOOP_KEY);
	const n = raw == null ? LOOP_DEFAULT : Number(raw);
	return (RADAR_LOOPS as readonly number[]).includes(n) ? (n as RadarLoopMin) : LOOP_DEFAULT;
}

export const radar = $state<{
	showOnMap: boolean;
	/** The composite shown: DBZH (reflectivity, 1 km, every 5 min) or RATE
	 *  (rain rate, 2 km, every 15 min); persisted only as RATE. */
	product: OperaProduct;
	/** Layer opacity, percent (persisted away from the default). */
	opacityPct: number;
	/** Draw the no-coverage hatch (persisted only when off). */
	coverage: boolean;
	/** The loop length, minutes (persisted away from the default). */
	loopMin: RadarLoopMin;
	playing: boolean;
	/** The slot shown; null follows the newest frame as it arrives, so a
	 *  refreshed index never jumps the loop position. */
	shownT: string | null;
	status: 'idle' | 'loading' | 'ok' | 'error' | 'outside';
	error: ErrorText | null;
	indexSeq: number;
	fetchSeq: number;
	paintSeq: number;
	/** Bumped by the rate-limit retry timer; the ensure effect tracks it. */
	retrySeq: number;
	/** Bumped when the view the loop is held for moves (its tiles, its
	 *  pooling or its product), which the loop and the held flags depend on
	 *  and which a pan changes with nothing fetched. */
	viewSeq: number;
	/** The cap the budget put on the loop for this view, null when the
	 *  whole loop fits. */
	frameCap: number | null;
	/** Frames whose view tiles are all held / frames the loop wants. */
	loaded: number;
	wanted: number;
	/** The in-flight caution is owed now (Toolbar hosts the dialog). */
	cautionDue: boolean;
}>({
	showOnMap: readItem(SHOW_KEY) === 'on',
	product: initialProduct(),
	opacityPct: initialOpacity(),
	coverage: readItem(COVERAGE_KEY) !== 'off',
	loopMin: initialLoop(),
	playing: false,
	shownT: null,
	status: 'idle',
	error: null,
	indexSeq: 0,
	fetchSeq: 0,
	paintSeq: 0,
	retrySeq: 0,
	viewSeq: 0,
	frameCap: null,
	loaded: 0,
	wanted: 0,
	cautionDue: false,
});

export function setShowRadarOnMap(on: boolean): void {
	radar.showOnMap = on;
	if (on) {
		writeItem(SHOW_KEY, 'on');
		// The layer is on whatever the answer: a caution never gates
		// safety-adjacent information, it accompanies it.
		noteRadarInFlight();
	} else {
		removeItem(SHOW_KEY);
		radar.cautionDue = false;
		radar.playing = false;
		radar.shownT = null;
		// Hidden costs nothing: both tiers go (the browser's own cache keeps
		// the slices a minute's worth of turning it back on would refetch),
		// and the failure stamps with them (dropTiles).
		dropTiles();
	}
}

/** The in-flight caution (docs/precipitation-radar.md "The age policy"):
 *  the first time the radar is USED in flight, once per device. Two entry
 *  paths, both user gestures and never an effect on nav.recording (the
 *  goFlying doctrine): the layer switched on while a recording runs, and
 *  the Fly tap with the layer already on from planning, since what EASA
 *  AMC9 SPA.EFB.100(b)(3) trains is the use of observed weather in flight,
 *  not the act of switching. Silent when Live weather is off (the layer
 *  draws nothing then) and once acknowledged. The Android boot reconcile
 *  flips nav.recording without either path, so a resume shows nothing. */
export function noteRadarInFlight(): void {
	if (
		nav.recording &&
		radar.showOnMap &&
		display.liveWeather &&
		!cautionUnwritable &&
		readItem(CAUTION_KEY) !== 'seen'
	) {
		radar.cautionDue = true;
	}
}

/** Set only when the acknowledgement could NOT be persisted. writeItem is
 *  best-effort by design (persist.ts swallows a refusal), so where storage is
 *  unavailable -- a WebView with it disabled, private browsing, a full quota --
 *  "once per device" silently became "every single time", stealing a cockpit
 *  tap on every Fly and every switch-on. Once per SESSION is the most such a
 *  device lets us promise. Deliberately not set when the write succeeded:
 *  storage is then the one record, and a second session asks again only if it
 *  really lost it. */
let cautionUnwritable = false;

/** "Understood": remembered on this device. */
export function acknowledgeRadarCaution(): void {
	writeItem(CAUTION_KEY, 'seen');
	cautionUnwritable = readItem(CAUTION_KEY) !== 'seen';
	radar.cautionDue = false;
}

/** Escape or the backdrop: closed, not remembered, asked again next time. */
export function dismissRadarCaution(): void {
	radar.cautionDue = false;
}

/** Switch the product. Both tiers, the heads, the index and the failure
 *  stamps go, the loop stops and the shown slot resets, so the strip's
 *  loading branch and a blank canvas cover the refetch: the old product's
 *  picture never sits under the new legend. A pending index answer is
 *  discarded by fetchIndex's product check. */
export function setRadarProduct(p: OperaProduct): void {
	if (p === curProduct) {
		return;
	}
	curProduct = p;
	radar.product = p;
	if (p === 'RATE') {
		writeItem(PRODUCT_KEY, p);
	} else {
		removeItem(PRODUCT_KEY);
	}
	radar.playing = false;
	radar.shownT = null;
	index = null;
	lastIndexPollMs = 0;
	indexInflight = null;
	dropTiles();
	radar.frameCap = null;
	radar.wanted = 0;
	// The other product's last status or error must not stand under the
	// new legend: loading until the next ensure pass says otherwise. A rate
	// limit is the proxy's, whichever product asked, and its notice stands
	// with its timer.
	if (!retryTimer) {
		radar.status = 'loading';
		radar.error = null;
		errorFkey = null;
	}
	radar.indexSeq++;
}

export function setRadarOpacity(pct: number): void {
	const p = Math.min(OPACITY_MAX_PCT, Math.max(OPACITY_MIN_PCT, Math.round(pct)));
	radar.opacityPct = p;
	if (p === OPACITY_DEFAULT_PCT) {
		removeItem(OPACITY_KEY);
	} else {
		writeItem(OPACITY_KEY, String(p));
	}
}

export function setRadarCoverage(on: boolean): void {
	radar.coverage = on;
	if (on) {
		removeItem(COVERAGE_KEY);
	} else {
		writeItem(COVERAGE_KEY, 'off');
	}
}

export function setRadarLoop(min: RadarLoopMin): void {
	radar.loopMin = min;
	radar.shownT = null;
	if (min === LOOP_DEFAULT) {
		removeItem(LOOP_KEY);
	} else {
		writeItem(LOOP_KEY, String(min));
	}
}

export function setRadarPlaying(on: boolean): void {
	radar.playing = on;
	if (!on) {
		// Stopping returns to the newest frame (the ForeFlight arrangement).
		radar.shownT = null;
	}
}

/** Show one slot of the loop; the newest frame's own key means "follow". */
export function setRadarShownFrame(key: string | null): void {
	const frames = untrack(() => loopForView().frames);
	const newest = frames.length > 0 ? frames[frames.length - 1].t : null;
	radar.shownT = key == null || key === newest ? null : key;
	radar.paintSeq++;
}

export function stepRadarFrame(dir: 1 | -1): void {
	const frames = untrack(() => loopForView().frames);
	setRadarShownFrame(nextFrame(frames, untrack(() => radar.shownT), dir));
}

// Plain (non-reactive) bookkeeping; see the contract in the header.
/** The product's plain mirror for the untracked paths (the canvas's
 *  tileAt, the decode queue), set beside radar.product. */
let curProduct: OperaProduct = radar.product;
let index: FramesIndex | null = null;
let lastIndexPollMs = 0;
/** The frame whose failure is the error on show (null for the index's or
 *  a rate limit's): its own arrival is what clears it. */
let errorFkey: string | null = null;
/** Refresh asked for the index again ahead of its poll instant, the one
 *  held staying on screen until the answer lands. */
let indexPollForced = false;
let indexInflight: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** When the pending backoff timer fires (Date.now's clock). */
let retryDueMs = 0;
let retryDelayMs = RATE_LIMIT_RETRY_MS;
/* When the backoff timer last fired, on the MONOTONIC clock. The doubling
 * belongs to one incident, and an incident ends when the retry pass draws no
 * refusal (RATE_LIMIT_QUIET_MS). No success can say so instead: a frame may
 * be the browser's cached slice or a request answered from inside the
 * incident, and the index is an edge HIT the relay's miss ceiling never
 * counts, so it lists through an incident in which every frame is refused:
 * reset on the index, a sustained frames-only refusal was retried at 66,
 * 132 and 264 s round and round, never the 528 and 900 of the doubling. */
let retryFiredMono = 0;
/** The view last ensured: which tiles and at which pooling. */
let view: RadarView | null = null;
/** Its signature, for the viewSeq bump. */
let viewSig = '';
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- module cache, published through the counters
const tierA = new Map<string, { bytes: Uint8Array; used: number }>();
let tierABytes = 0;
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- module cache, published through the counters
const tierB = new Map<string, { tile: RadarCells; used: number }>();
let tierBBytes = 0;
/** A frame's head as it last ARRIVED, beside the directory parsed off it:
 *  the bytes are what a later answer is compared against, since the byte
 *  counts that frame the tiles are only as good as the head they came in. */
interface HeldHead {
	bytes: Uint8Array;
	layout: TiffLayout;
}
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- the parsed directory per frame
const heads = new Map<string, HeldHead>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- in-flight dedup bookkeeping, not state
const frameInflight = new Map<string, Promise<void>>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- failure stamps, not state
const frameFailedAt = new Map<string, number>();
/** When a frame's object last changed under the client (monotonic): a
 *  second change inside the retry minute paces the frame at that minute. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- retry bookkeeping, not state
const headSwapAt = new Map<string, number>();
/** Frames whose bytes did not READ (a head that is not the layout, a tile
 *  that does not inflate): the browser holds a slice for a day, so the
 *  retry after the minute bypasses its cache once, else a bad copy (a
 *  slicing deploy, a corrupt object) would be re-read from it forever. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- retry bookkeeping, not state
const reloadNext = new Set<string>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- decode queue bookkeeping, not state
const decodeQueued = new Set<string>();
const decodeQueue: string[] = [];
let decodesRunning = 0;
let useStamp = 0;

// Every key leads with the product (the header's contract).
const keyA = (prod: OperaProduct, t: string, tile: number): string => `${prod}|${t}|${tile}`;
const keyB = (prod: OperaProduct, t: string, tile: number, p: number): string => `${prod}|${t}|${tile}|${p}`;
/** The heads, the in-flight frames and the failure stamps: one per frame. */
const keyF = (prod: OperaProduct, t: string): string => `${prod}|${t}`;

/** The frames of ONE product in flight: a switch cannot abort the other
 *  product's fetches (no abort machinery by design), and they must not
 *  hold the new product's slots for up to their timeout. */
function inflightCount(prod: OperaProduct): number {
	let n = 0;
	for (const k of frameInflight.keys()) {
		if (k.startsWith(prod + '|')) {
			n++;
		}
	}
	return n;
}

function tierABudget(): number {
	return ui.isMobile ? 16_000_000 : 64_000_000;
}

function tierBBudget(): number {
	return ui.isMobile ? 32_000_000 : 96_000_000;
}

export interface RadarView {
	/** The product the tiles were computed for (its grid). */
	product: OperaProduct;
	/** The base tiles (under the grid's count) the viewport reaches, ascending. */
	tiles: number[];
	/** The pooling the prefetch decodes at (the canvas computes its own per
	 *  draw, so a zoom never paints through a stale one). */
	p: OperaPooling;
}

/** Whether a view reaches the composite at all. MapView hands ensureRadar
 *  NULL when gridBoxOfBounds finds no cell of the grid under the map (a pan
 *  to New York, the far hemisphere), and that is the real path: a box always
 *  yields at least one tile, so the empty list is only the defensive half.
 *  The status and the loop both read off this one test, so the strip and
 *  the Weather tab cannot tell the pilot two different things: the loop fell
 *  through to a one-frame floor on a null view, and the strip printed the
 *  newest European frame, its age and "loading" over a map with nothing on
 *  it while the tab said "outside the composite". */
function reachesComposite(v: RadarView | null): v is RadarView {
	return v != null && v.tiles.length > 0;
}

/** Both tiers, the heads, the decode queue and the failure stamps: what a
 *  hidden layer and a product switch let go of. The stamps go with the
 *  tiles: kept across a hide and a show, a frame that failed was held back
 *  for the rest of its minute while the notice that said so had gone with
 *  the hide, the strip reading "loading" with nothing fetching. */
function dropTiles(): void {
	tierA.clear();
	tierB.clear();
	heads.clear();
	headSwapAt.clear();
	frameFailedAt.clear();
	tierABytes = 0;
	tierBBytes = 0;
	decodeQueue.length = 0;
	decodeQueued.clear();
	radar.loaded = 0;
}

/** How many of `frames` hold every tile of the view. */
function heldCount(frames: readonly RadarFrame[], v: RadarView): number {
	let n = 0;
	for (const f of frames) {
		if (v.tiles.every((i) => tierA.has(keyA(curProduct, f.t, i)))) {
			n++;
		}
	}
	return n;
}

/** The bytes a view tile takes in tier A: the MEAN over the loop's frames
 *  whose view tiles are all held, the product's p90 tile until one is. The
 *  cap is then exact for the day's own tiles: an estimate a rainy frame
 *  overran admitted more frames than the budget held, and the eviction and
 *  the refetch chased each other at the debounce for as long as the layer
 *  was on (found by a review's scratch drive: 240 fetches over 120 passes,
 *  the loop never complete). */
function viewTileBytes(tiles: readonly number[], frames: readonly RadarFrame[]): number {
	const p90 = OPERA_PRODUCT_INFO[curProduct].p90TileBytes;
	if (tiles.length === 0) {
		return p90;
	}
	let held = 0;
	let bytes = 0;
	for (const f of frames) {
		let sum = 0;
		let all = true;
		for (const i of tiles) {
			const e = tierA.get(keyA(curProduct, f.t, i));
			if (!e) {
				all = false;
				break;
			}
			sum += e.bytes.length;
		}
		if (all) {
			held++;
			bytes += sum;
		}
	}
	return held === 0 ? p90 : bytes / held / tiles.length;
}

/** The share of each tier's budget the loop may plan on: the rest is what
 *  a pan or a zoom holds beside the view's own (tiles next to it in tier A,
 *  the previous pooling's decodes in tier B). */
const LOOP_BUDGET_SHARE = 0.9;

/** The loop for the current view: the newest frames of the index within
 *  loopMin, under the cap BOTH tiers put on this view's tile count, tier A
 *  at the bytes its tiles measure and tier B at the decoded tile's exact
 *  size for the view's pooling (loopFrameCap). Tracked through indexSeq and
 *  loopMin. */
function loopForView(): { frames: RadarFrame[]; cap: number | null } {
	void radar.indexSeq;
	void radar.viewSeq;
	const loopMin = radar.loopMin;
	if (!index) {
		return { frames: [], cap: null };
	}
	const v = view;
	if (!reachesComposite(v)) {
		// Off the composite there is nothing to loop: the strip says so
		// rather than reading a frame off a picture that has nothing in it
		// (the one-frame floor of loopFrameCap is for a view WITH tiles).
		return { frames: [], cap: null };
	}
	const all = loopFrames(index.frames, loopMin, Number.POSITIVE_INFINITY);
	const cap = loopFrameCap(
		v.tiles.length,
		{ budgetBytes: tierABudget() * LOOP_BUDGET_SHARE, bytesPerTile: viewTileBytes(v.tiles, all) },
		{ budgetBytes: tierBBudget() * LOOP_BUDGET_SHARE, bytesPerTile: decodedTileBytes(curProduct, v.p) },
	);
	const frames = loopFrames(index.frames, loopMin, cap);
	return { frames, cap: frames.length < all.length ? cap : null };
}

/** The newest frame's key, tracked. */
function newestKey(): string | null {
	void radar.indexSeq;
	return index && index.frames.length > 0 ? index.frames[index.frames.length - 1].t : null;
}

function rateLimitMsg(delayMs: number): ErrorText {
	const sec = Math.max(1, Math.round(delayMs / 1000));
	return () => t.errors.proxyBusy(sec);
}

/** A 429 from either route: stand every fetch down behind a doubling timer
 *  whose expiry re-runs the ensure through retrySeq (the windAloft rule).
 *  ONE timer per incident: the two frames and the index refused in the same
 *  window are one refusal, not three doublings (66, 132, 264 s). The proxy's
 *  own Retry-After, when it states one, is the floor of the wait, and the
 *  STRICTEST instruction of the incident wins: a later refusal asking for a
 *  longer wait than the timer has left moves the timer and the notice out to
 *  it, and one asking for less changes nothing. Taking the first refusal's
 *  word instead made the wait an accident of arrival order: a frame refused
 *  with no header a moment before the index refused with Retry-After 300
 *  retried at 66 s, into the window the proxy had asked to be left alone. */
function rateLimited(retryAfterS = 0): void {
	const now = Date.now();
	const askedMs = Number.isFinite(retryAfterS) && retryAfterS > 0 ? retryAfterS * 1000 : 0;
	if (retryTimer) {
		if (now + askedMs <= retryDueMs) {
			return;
		}
		clearTimeout(retryTimer);
		armRetry(now, askedMs);
		return;
	}
	if (retryFiredMono > 0 && monoNowMs() - retryFiredMono > RATE_LIMIT_QUIET_MS) {
		// The last incident's retry pass drew no refusal: this is a new one.
		retryDelayMs = RATE_LIMIT_RETRY_MS;
	}
	armRetry(now, Math.max(retryDelayMs, askedMs));
	retryDelayMs = Math.min(retryDelayMs * 2, RATE_LIMIT_RETRY_MAX_MS);
}

function armRetry(now: number, delayMs: number): void {
	// The notice is written only where it is read: a refusal landing while
	// the layer is hidden arms the timer all the same, and the show says it
	// (ensureRadar's stand-down branch).
	if (untrack(() => radar.showOnMap && display.liveWeather)) {
		radar.status = 'error';
		radar.error = rateLimitMsg(delayMs);
	}
	retryDueMs = now + delayMs;
	retryTimer = setTimeout(() => {
		retryTimer = null;
		retryFiredMono = monoNowMs();
		radar.retrySeq++;
	}, delayMs);
}

/** Start (or keep) the fetches for the current viewport: the index when it
 *  is due, then the loop's frames, the shown one first, then the newest,
 *  then backwards, two in flight. Cheap when everything is held; safe from
 *  host effects (untracked writes). */
export function ensureRadar(v: RadarView | null, nowMs = Date.now()): void {
	if (!display.liveWeather || !radar.showOnMap) {
		untrack(() => {
			if (radar.status !== 'idle') {
				radar.status = 'idle';
				radar.error = null;
				errorFkey = null;
				// Hidden costs nothing, whichever switch hid it.
				dropTiles();
			}
		});
		return;
	}
	if (v && v.product !== curProduct) {
		// A view computed for the product before a switch: the host effect
		// re-runs with the right one (the switch bumps indexSeq).
		return;
	}
	view = v;
	const sig = v ? `${v.product}|${v.p}|${v.tiles.join(',')}` : '';
	if (sig !== viewSig) {
		viewSig = sig;
		untrack(() => radar.viewSeq++);
	}
	if (retryTimer) {
		// The backoff timer is the sole path back to the network, and the
		// notice says so whatever cleared it meanwhile: a hide and a show
		// inside the stand-down left "loading" with nothing fetching. The
		// view's own figures still follow a pan: skipped here, the strip read
		// a view panned to tiles not held as whole, and one panned off the
		// composite as a two-frame loop with its age.
		const due = retryDueMs;
		untrack(() => {
			if (!reachesComposite(v)) {
				radar.status = 'outside';
				radar.wanted = 0;
				radar.loaded = 0;
				radar.frameCap = null;
				return;
			}
			if (radar.status !== 'error' || radar.error == null) {
				radar.status = 'error';
				radar.error = rateLimitMsg(Math.max(0, due - nowMs));
			}
			const { frames, cap } = loopForView();
			radar.wanted = frames.length;
			radar.loaded = heldCount(frames, v);
			radar.frameCap = cap;
		});
		return;
	}
	if (nowMs < lastIndexPollMs) {
		// The device clock went back past the last poll: the instant the next
		// frame is due, on that clock, is as far off as the step, and the
		// fresh listing is what re-anchors the offset.
		indexPollForced = true;
	}
	if (!indexInflight && (indexPollForced || nowMs >= nextIndexPollMs(index, lastIndexPollMs, nowMs))) {
		fetchIndex(nowMs);
	}
	if (!reachesComposite(v)) {
		untrack(() => {
			radar.status = 'outside';
			radar.wanted = 0;
			radar.loaded = 0;
			radar.frameCap = null;
		});
		return;
	}
	if (!index) {
		untrack(() => {
			if (radar.status !== 'error') {
				radar.status = 'loading';
			}
		});
		return;
	}
	const { frames, cap } = untrack(loopForView);
	const shown = untrack(() => radar.shownT);
	const order: RadarFrame[] = [];
	const shownFrame = frames.find((f) => f.t === shown);
	if (shownFrame) {
		order.push(shownFrame);
	}
	for (let i = frames.length - 1; i >= 0; i--) {
		if (frames[i] !== shownFrame) {
			order.push(frames[i]);
		}
	}
	const prod = curProduct;
	const loaded = heldCount(frames, v);
	for (const f of order) {
		if (inflightCount(prod) >= MAX_INFLIGHT) {
			break;
		}
		const missing = v.tiles.filter((i) => !tierA.has(keyA(prod, f.t, i)));
		if (missing.length === 0 || frameInflight.has(keyF(prod, f.t))) {
			continue;
		}
		// A stamp ahead of the clock is a clock stepped back (the index
		// poll's own rule): honoured, it held the frame back for the whole
		// step, its slot drawn with no tiles and a hole in the loop.
		const failedAt = frameFailedAt.get(keyF(prod, f.t));
		if (failedAt != null && failedAt <= nowMs && nowMs - failedAt < FRAME_RETRY_MS) {
			continue;
		}
		fetchFrame(prod, f.t, missing);
	}
	// Decode what the view will draw ahead of the paint asking for it, in
	// the order the loop needs it: the shown frame, then the newest, then
	// backwards (the fetch order above).
	for (const f of order) {
		for (const i of v.tiles) {
			if (tierA.has(keyA(prod, f.t, i)) && !tierB.has(keyB(prod, f.t, i, v.p))) {
				enqueueDecode(prod, f.t, i, v.p);
			}
		}
	}
	const inflight = inflightCount(prod);
	untrack(() => {
		radar.wanted = frames.length;
		radar.loaded = loaded;
		radar.frameCap = cap;
		// An error stands while it explains a gap: a frame's failure keeps
		// the status line honest through its retry minute rather than
		// reading "loading" with nothing in flight, and a sibling frame's
		// arrival does not clear it (the frame that failed is still
		// missing). It clears when every wanted frame is held, when its
		// own frame arrives, or when the index is listed afresh.
		if (inflight > 0 || loaded < frames.length) {
			radar.status = radar.error ? 'error' : 'loading';
		} else if (radar.error && errorFkey == null) {
			// The index's own failure (or a rate limit) stands until the index
			// is listed again, whatever frames are held: a refetch that failed
			// is worth knowing, and the next success clears it.
			radar.status = 'error';
		} else {
			radar.status = 'ok';
			radar.error = null;
			errorFkey = null;
		}
	});
}

function fetchIndex(nowMs: number): void {
	lastIndexPollMs = nowMs;
	indexPollForced = false;
	const product = curProduct;
	// NEVER the browser's HTTP cache for the index: the edge is the sharing
	// layer (60 s), and the zone rewrites a cached answer's browser TTL to
	// four hours, which held a RATE list 37 minutes stale in a drive. The
	// frames themselves stay cacheable: they are immutable by slot.
	const p: Promise<void> = fetch(framesUrl(proxyBase(), product, INDEX_HOURS), {
		cache: 'no-store',
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	})
		.then(async (res) => {
			if (product !== curProduct) {
				// The product switched while this was in flight: the answer is
				// the other product's list and is discarded whole.
				return;
			}
			if (res.status === 429) {
				rateLimited(Number(res.headers.get('retry-after')));
				return;
			}
			if (!res.ok) {
				// i18n-ignore-start: wire / operator-deploy diagnostics, stay EN (docs/i18n.md rule 7)
				throw new Error(
					res.status === 404
						? 'Deploy the updated notam-proxy worker to enable the precipitation radar.'
						: `radar index failed: ${res.status}`,
				);
				// i18n-ignore-end
			}
			// The serve time: the body's `now` is the listing's instant, up to
			// the edge's minute earlier on a hit, and an age counted from it
			// read that much younger than it was.
			const served = Date.parse(res.headers.get('x-opera-now') ?? '');
			const parsed = parseFramesIndex(await res.json(), Date.now(), Number.isFinite(served) ? served : undefined);
			if (!parsed) {
				// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
				throw new Error('radar index: unreadable answer');
			}
			if (parsed.product !== curProduct) {
				return;
			}
			const newestBefore = newestKeyUntracked();
			index = parsed;
			// A frame's directory is kept while the frame is listed: the rest
			// held about 9 KB a frame for the session, outside both budgets.
			const listed = new Set(parsed.frames.map((f) => keyF(parsed.product, f.t)));
			for (const k of heads.keys()) {
				if (!listed.has(k)) {
					heads.delete(k);
				}
			}
			for (const k of headSwapAt.keys()) {
				if (!listed.has(k)) {
					headSwapAt.delete(k);
				}
			}
			// In flight, an unplayed scrub follows the arrivals: a thumb brushed
			// across the slider in a mount would otherwise pin the picture to
			// an old frame for the rest of the flight, the only cue a red age
			// on the strip. On the ground a scrub holds, as every EFB's does.
			const newestNow = newestKeyUntracked();
			if (nav.recording && !radar.playing && radar.shownT != null && newestNow !== newestBefore) {
				radar.shownT = null;
			}
			// A fresh listing clears whatever error stood: the index's own
			// (whatever the status meanwhile, an 'outside' pass having kept the
			// text without the status) and a frame's, the listing being a
			// fresh start.
			//
			// Except behind a 429 stand-down, which this answer does not lift:
			// the timer is the SOLE path back to the network (ensureRadar
			// returns early on it), so clearing the notice here leaves the
			// strip reading "loading" for the whole backoff, up to 15 minutes,
			// with nothing fetching and the frames ageing through every tier.
			// An index request already in flight when the refusal landed is
			// exactly how it happens: one ensure pass starts the listing and
			// the frames together, and a frame is what gets refused.
			if (!retryTimer) {
				if (radar.status === 'error') {
					radar.status = 'loading';
				}
				radar.error = null;
				errorFkey = null;
			}
			radar.indexSeq++;
		})
		.catch((err: unknown) => {
			if (product !== curProduct || !untrack(() => radar.showOnMap && display.liveWeather)) {
				// The other product's rejection (a timeout after the switch)
				// is not this product's error, and a hidden layer's is nobody's.
				return;
			}
			errorFkey = null;
			radar.status = 'error';
			radar.error = errorTextOf(err);
			radar.indexSeq++;
		})
		.finally(() => {
			// Only this fetch's own slot: a switch may have started another.
			if (indexInflight === p) {
				indexInflight = null;
			}
		});
	indexInflight = p;
}

function fetchFrame(product: OperaProduct, t: string, tiles: number[]): void {
	const fkey = keyF(product, t);
	const reload = reloadNext.delete(fkey);
	// The HEADERS must come within the fetch timeout; the body is read against
	// a stall timer instead (readFrameBody). A frame is one request for every
	// tile in view, 850 KB on a rainy day over a phone's France view, and
	// under one deadline a link at 190 kbit/s shared by the two frames in
	// flight read a quarter of it, was aborted, and started again from byte
	// zero a minute later, for as long as the link stayed that slow: the
	// newest frame never drew, in flight, where such links are.
	const ctrl = new AbortController();
	const headers = setTimeout(() => ctrl.abort(timeoutError()), FETCH_TIMEOUT_MS);
	const p = fetch(frameUrl(proxyBase(), t, product, tiles), {
		cache: reload ? 'reload' : 'default',
		signal: ctrl.signal,
	})
		.then(async (res) => {
			clearTimeout(headers);
			if (res.status === 429) {
				// The proxy's refusal stands whoever asked and whatever was
				// switched or hidden since (the index route's own rule): read
				// as a straggler, a refusal landing after a hide was forgotten
				// and the show asked again inside the proxy's own window.
				if (product === curProduct) {
					errorFkey = fkey;
				}
				rateLimited(Number(res.headers.get('retry-after')));
				return;
			}
			if (product !== curProduct || !untrack(() => radar.showOnMap && display.liveWeather)) {
				// A straggler of the product before a switch, or of a layer
				// hidden since: never stored, so no tile of one grid can be
				// drawn at the other's placement and hidden holds nothing.
				return;
			}
			if (res.status === 404) {
				// Listed but not readable yet (or expired): try again later.
				frameFailedAt.set(fkey, Date.now());
				return;
			}
			if (!res.ok) {
				// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
				throw new Error(`radar frame failed: ${res.status}`);
			}
			const buf = await readFrameBody(res, ctrl);
			if (product !== curProduct || !untrack(() => radar.showOnMap && display.liveWeather)) {
				// The body was still streaming at the switch-off or the switch.
				return;
			}
			if (buf.length < OPERA_HEAD_BYTES) {
				// Past the browser's cache next time, like every unreadable
				// answer: a short cached slice was read back every minute.
				reloadNext.add(fkey);
				// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
				throw new Error('radar frame: short answer');
			}
			// Every answer is framed by the head IT carries, never by one a
			// previous answer left: the directory of a slot is the object's,
			// and the object behind a slot can change under the client (a
			// re-published frame, a slicing deploy, the browser's day-long
			// copy of an older cut), which sliced a later answer with the
			// earlier byte counts and filled tier A with the wrong bytes,
			// caught only one inflate and a 2 MB allocation per tile later.
			// A head byte-identical to the one held is the held directory;
			// any other is parsed and checked afresh.
			const headBytes = buf.subarray(0, OPERA_HEAD_BYTES);
			const held = heads.get(fkey);
			let layout: TiffLayout;
			if (held && sameBytes(held.bytes, headBytes)) {
				layout = held.layout;
			} else {
				const parsed = parseTiledTiffHead(headBytes);
				if (!parsed || !isOperaLayout(parsed, OPERA_PRODUCT_INFO[product].grid)) {
					// Another grid or product: refused, never drawn misplaced.
					reloadNext.add(fkey);
					// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
					throw new Error('radar frame: not the composite layout');
				}
				if (held) {
					// Another object behind the same slot: what is held was
					// cut from the one before, and one frame is never drawn
					// from two objects.
					dropFrameTiles(product, t);
					// The tiles dropped are asked again PAST the browser's
					// cache: its day-long copy of their URL is the old
					// object's, which answered as "another object" in turn,
					// the two evicting each other at the ensure pace for as
					// long as the frame was in the loop, never whole. A second
					// change inside the minute (two objects answering even past
					// the cache) paces the frame at its retry minute.
					reloadNext.add(fkey);
					const mono = monoNowMs();
					const lastSwap = headSwapAt.get(fkey);
					headSwapAt.set(fkey, mono);
					if (lastSwap != null && mono - lastSwap < FRAME_RETRY_MS) {
						frameFailedAt.set(fkey, Date.now());
					}
				}
				layout = parsed;
				heads.set(fkey, { bytes: headBytes.slice(), layout });
			}
			let at = OPERA_HEAD_BYTES;
			for (const i of tiles) {
				const n = layout.tileByteCounts[i];
				// `n` undefined makes every comparison below FALSE, so an index
				// past the directory would slice NaN..NaN, store a 0-byte tile
				// as good data and take every later tile of the request with
				// it: tier A would report the frame held and the failure would
				// only surface in the decoder. Reachable only from a grid whose
				// tile counts disagree with the layout, which is what the head
				// guard exists to catch, so say so here rather than trust it.
				if (n === undefined || at + n > buf.length) {
					reloadNext.add(fkey);
					// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
					throw new Error('radar frame: truncated tiles');
				}
				putTierA(keyA(product, t, i), buf.slice(at, at + n));
				at += n;
			}
			frameFailedAt.delete(fkey);
			if (errorFkey === fkey && !retryTimer) {
				// The frame that failed is held: its error has nothing left
				// to explain. Another frame's failure keeps its own, and a
				// rate limit standing keeps its notice (the timer is the only
				// way back, and it has not fired).
				errorFkey = null;
				radar.error = null;
				if (radar.status === 'error') {
					radar.status = 'loading';
				}
			}
			const v = view;
			if (v) {
				const shownNow = t === shownKeyUntracked();
				for (const i of tiles) {
					enqueueDecode(product, t, i, v.p, shownNow);
				}
			}
		})
		.catch((err: unknown) => {
			clearTimeout(headers);
			frameFailedAt.set(fkey, Date.now());
			if (product !== curProduct || !untrack(() => radar.showOnMap && display.liveWeather)) {
				return;
			}
			errorFkey = fkey;
			radar.status = 'error';
			radar.error = errorTextOf(err);
		})
		.finally(() => {
			frameInflight.delete(fkey);
			radar.fetchSeq++;
		});
	frameInflight.set(fkey, p);
}

/** What a fetch timed out by the module's own timers is aborted with: the
 *  error AbortSignal.timeout rejects with, so it reads the same. */
function timeoutError(): DOMException {
	// i18n-ignore: wire diagnostic, the platform's own abort message, stays EN (docs/i18n.md rule 7)
	return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

/** A frame answer's body, read against a STALL timer: aborted once no byte
 *  has come for FETCH_TIMEOUT_MS, or once the whole read outlasts
 *  FRAME_BODY_MAX_MS, never at a deadline sized for the headers. A link that
 *  keeps delivering, however slowly, delivers the frame. */
async function readFrameBody(res: Response, ctrl: AbortController): Promise<Uint8Array> {
	const body = res.body;
	if (!body) {
		return new Uint8Array(await res.arrayBuffer());
	}
	const reader = body.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	let stall: ReturnType<typeof setTimeout> | null = null;
	const arm = (): void => {
		if (stall != null) {
			clearTimeout(stall);
		}
		stall = setTimeout(() => ctrl.abort(timeoutError()), FETCH_TIMEOUT_MS);
	};
	const whole = setTimeout(() => ctrl.abort(timeoutError()), FRAME_BODY_MAX_MS);
	try {
		arm();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			parts.push(value);
			size += value.length;
			arm();
		}
	} finally {
		if (stall != null) {
			clearTimeout(stall);
		}
		clearTimeout(whole);
	}
	const out = new Uint8Array(size);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

/** Every tile of one frame, both tiers, the counters following the maps. */
function dropFrameTiles(product: OperaProduct, t: string): void {
	const prefix = keyF(product, t) + '|';
	for (const [key, e] of tierA) {
		if (key.startsWith(prefix)) {
			tierA.delete(key);
			tierABytes -= e.bytes.length;
		}
	}
	for (const [key, e] of tierB) {
		if (key.startsWith(prefix)) {
			tierB.delete(key);
			tierBBytes -= e.tile.byteLength;
		}
	}
}

function putTierA(key: string, bytes: Uint8Array): void {
	const prev = tierA.get(key);
	if (prev) {
		tierABytes -= prev.bytes.length;
	}
	tierA.set(key, { bytes, used: ++useStamp });
	tierABytes += bytes.length;
	if (tierABytes > tierABudget()) {
		evict(tierA, (e) => e.bytes.length, tierABudget(), (n) => (tierABytes -= n));
	}
}

// Counted in BYTES, not elements: an Int16 tile is twice its length.
function putTierB(key: string, tile: RadarCells): void {
	const prev = tierB.get(key);
	if (prev) {
		tierBBytes -= prev.tile.byteLength;
	}
	tierB.set(key, { tile, used: ++useStamp });
	tierBBytes += tile.byteLength;
	if (tierBBytes > tierBBudget()) {
		evict(tierB, (e) => e.tile.byteLength, tierBBudget(), (n) => (tierBBytes -= n));
	}
}

/** Evict down to the budget: first anything of another product and the
 *  frames outside the loop (oldest first), then tiles outside the view by
 *  last use; never a tile of the shown frame that the view draws. */
function evict<E extends { used: number }>(
	store: Map<string, E>,
	sizeOf: (e: E) => number,
	budget: number,
	release: (n: number) => void,
): void {
	const { frames } = untrack(loopForView);
	const inLoop = new Set(frames.map((f) => f.t));
	const shown = shownIn(frames);
	const viewTiles = new Set(view?.tiles ?? []);
	const candidates: { key: string; rank: number; used: number; size: number }[] = [];
	let held = 0;
	for (const [key, e] of store) {
		held += sizeOf(e);
		const [prod, t, tileStr] = key.split('|');
		const tile = Number(tileStr);
		const inView = viewTiles.has(tile);
		const mine = prod === curProduct;
		if (mine && t === shown && inView) {
			continue;
		}
		candidates.push({
			key,
			rank: !mine || !inLoop.has(t) ? 0 : !inView ? 1 : 2,
			used: e.used,
			size: sizeOf(e),
		});
	}
	candidates.sort((a, b) => a.rank - b.rank || a.used - b.used);
	for (const c of candidates) {
		if (held <= budget) {
			break;
		}
		store.delete(c.key);
		held -= c.size;
		release(c.size);
	}
}

function enqueueDecode(prod: OperaProduct, t: string, tile: number, p: number, urgent = false): void {
	const key = keyB(prod, t, tile, p);
	if (tierB.has(key)) {
		return;
	}
	if (decodeQueued.has(key)) {
		if (urgent) {
			// The paint is asking for it now: ahead of the prefetches.
			const at = decodeQueue.indexOf(key);
			if (at > 0) {
				decodeQueue.splice(at, 1);
				decodeQueue.unshift(key);
			}
		}
		return;
	}
	decodeQueued.add(key);
	if (urgent) {
		decodeQueue.unshift(key);
	} else {
		decodeQueue.push(key);
	}
	drainDecodes();
}

function drainDecodes(): void {
	while (decodesRunning < MAX_DECODES && decodeQueue.length > 0) {
		const key = decodeQueue.shift()!;
		decodesRunning++;
		void decodeOne(key).finally(() => {
			decodesRunning--;
			decodeQueued.delete(key);
			// One tile per macrotask keeps the main thread free between
			// conversions (the paint and the GPS clock share it).
			setTimeout(drainDecodes, 0);
		});
	}
}

async function decodeOne(key: string): Promise<void> {
	const [prod, t, tileStr, pStr] = key.split('|') as [OperaProduct, string, string, string];
	const tile = Number(tileStr);
	const p = Number(pStr);
	const a = tierA.get(keyA(prod, t, tile));
	if (!a) {
		return;
	}
	a.used = ++useStamp;
	const head = heads.get(keyF(prod, t));
	// An inflated tile: 512 x 512 pixels of two Float32 samples, on either grid.
	const grid = OPERA_PRODUCT_INFO[prod].grid;
	const inflatedBytes = grid.tile * grid.tile * 2 * 4;
	try {
		const inflated = await inflateZlib(a.bytes, inflatedBytes);
		if (prod !== curProduct || !untrack(() => radar.showOnMap && display.liveWeather)) {
			// Queued before a switch or before the layer was hidden: the
			// tiers were dropped, and a tile of the other grid must not come
			// back into tier B.
			return;
		}
		if (heads.get(keyF(prod, t)) !== head) {
			// The frame's object was replaced while this inflated (fetchFrame
			// dropped its tiles): these cells are the old object's.
			return;
		}
		if (inflated.length !== inflatedBytes) {
			// A stream that inflates SHORT is as broken as one that does not
			// inflate: thrown, so the bytes are dropped below rather than
			// re-queued by every paint and inflated again at every beat.
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			throw new Error('radar tile: short stream');
		}
		const base = decodeTile(inflated, prod, head?.layout.nodata ?? undefined);
		// The padding past the grid's edge in the last tile column and row
		// is no coverage, never a value the pool would keep.
		const tx = tile % grid.tileCols;
		const ty = Math.floor(tile / grid.tileCols);
		maskPadding(base, grid.tile, grid.cols - tx * grid.tile, grid.rows - ty * grid.tile);
		putTierB(key, maxPool(base, grid.tile, p));
		if (t === shownKeyUntracked()) {
			radar.paintSeq++;
		}
	} catch (err: unknown) {
		// A tile that does not inflate is dropped from tier A too: a
		// refetch is the only cure, at the frame's retry pace and past the
		// browser's cache, and the frame's failure is SAID. Silently
		// dropped, the ensure pass refetched the same bad copy from the
		// cache at the debounce, two inflates a second for as long as the
		// frame was in the loop, the strip reading "loading" throughout.
		// Only the entry this decode read: a drop or an eviction may have
		// taken it already, and the accounting follows the map, never a
		// stale handle.
		if (tierA.get(keyA(prod, t, tile)) === a) {
			tierA.delete(keyA(prod, t, tile));
			tierABytes -= a.bytes.length;
		}
		const fkey = keyF(prod, t);
		frameFailedAt.set(fkey, Date.now());
		reloadNext.add(fkey);
		if (prod === curProduct && untrack(() => radar.showOnMap && display.liveWeather)) {
			errorFkey = fkey;
			radar.status = 'error';
			radar.error = errorTextOf(err);
			radar.fetchSeq++;
		}
	}
}

function newestKeyUntracked(): string | null {
	return index && index.frames.length > 0 ? index.frames[index.frames.length - 1].t : null;
}

/** The frame the map draws among `frames` (the view's loop): the scrubbed one
 *  while the loop holds it, else the loop's newest, radarLoop's own fallback.
 *  A scrub the loop has left (its slot aged out, a zoom capped the loop) is
 *  not what is drawn, and the fetch, the decode's repaint and the eviction
 *  all asked about it instead: the drawn frame's tiles decoded without a
 *  repaint, and the eviction guarded the wrong frame. */
function shownIn(frames: readonly RadarFrame[]): string | null {
	const shown = untrack(() => radar.shownT);
	if (shown != null && frames.some((f) => f.t === shown)) {
		return shown;
	}
	return frames.length > 0 ? frames[frames.length - 1].t : newestKeyUntracked();
}

function shownKeyUntracked(): string | null {
	return shownIn(untrack(loopForView).frames);
}

/** The decoded tile of a frame at a pooling, or null while it is not held
 *  (a decode is queued when the bytes are). Untracked by design: the canvas
 *  reads it per paint; arrivals repaint through paintSeq. */
export function radarTileAt(t: string, tile: number, p: number): RadarCells | null {
	const prod = curProduct;
	const b = tierB.get(keyB(prod, t, tile, p));
	if (b) {
		b.used = ++useStamp;
		return b.tile;
	}
	if (tierA.has(keyA(prod, t, tile))) {
		enqueueDecode(prod, t, tile, p, true);
	}
	return null;
}

/** Ask for the index again on the next ensure pass and drop the failure
 *  stamps (the Refresh button); the index held keeps the frames on screen
 *  until the answer lands, and the tiles stay, being immutable by slot. */
export function refreshRadar(): void {
	indexPollForced = true;
	frameFailedAt.clear();
	radar.indexSeq++;
}

/** The loop the view holds, its shown frame and the cap, tracked: the cap
 *  follows the view's tile count, which a zoom moves with nothing fetched
 *  when every tile is held, so the ensure pass's own figures are read too. */
export function radarLoop(): { frames: RadarFrame[]; shownIdx: number; capped: boolean } {
	void radar.fetchSeq;
	void radar.wanted;
	void radar.frameCap;
	const { frames, cap } = loopForView();
	const shown = radar.shownT;
	let idx = shown == null ? -1 : frames.findIndex((f) => f.t === shown);
	if (idx < 0) {
		idx = frames.length - 1;
	}
	return { frames, shownIdx: idx, capped: cap != null };
}

/** The frame the map shows, tracked. */
export function shownRadarFrame(): RadarFrame | null {
	const { frames, shownIdx } = radarLoop();
	return shownIdx >= 0 ? frames[shownIdx] : null;
}

/** A frame's age and tier, on the minute tick. */
export function radarAge(frame: RadarFrame): { ms: number; staleness: Staleness } {
	void notamState.tick;
	void radar.indexSeq;
	if (!index) {
		return { ms: 0, staleness: 'fresh' };
	}
	const ms = frameAgeMs(frame, index, Date.now());
	return { ms, staleness: radarStaleness(ms, index.product) };
}

/** The FEED's age: the newest frame's, which is what decides whether the
 *  echoes are still drawn at all (a scrubbed older frame is the loop). */
export function radarFeed(): { newest: RadarFrame; ms: number; staleness: Staleness } | null {
	void radar.indexSeq;
	if (!index || index.frames.length === 0) {
		return null;
	}
	const newest = index.frames[index.frames.length - 1];
	return { newest, ...radarAge(newest) };
}

/** Whether a frame's tiles for the current view are all held (the strip's
 *  loaded dots and its "loading" word), tracked through fetchSeq and
 *  viewSeq: a pan to tiles not held changes the answer with nothing
 *  fetched, which during a stand-down is the whole stand-down. */
export function radarFrameHeld(t: string): boolean {
	void radar.fetchSeq;
	void radar.viewSeq;
	const v = view;
	return !!v && v.tiles.every((i) => tierA.has(keyA(curProduct, t, i)));
}

/** The newest frame's key, tracked (the timeline's "now" mark). */
export function radarNewestKey(): string | null {
	return newestKey();
}

/** The loop frame a map reading of slot `t` was taken from, while the map
 *  still draws the radar: the layer shown, the feed not expired and the slot
 *  still in the view's loop; null otherwise. The hover badge keeps a reading
 *  under a resting pointer, and it outlived the feed's expiry, the layer's
 *  switch-off and the slot's own departure from the loop, printing an echo
 *  the map no longer drew. Tracked (the minute tick through radarFeed). */
export function radarReadingFrame(t: string): RadarFrame | null {
	if (!radar.showOnMap || !display.liveWeather) {
		return null;
	}
	const feed = radarFeed();
	if (!feed || feed.staleness === 'expired') {
		return null;
	}
	return radarLoop().frames.find((f) => f.t === t) ?? null;
}

/** Reset for tests (the resetVacGeoForTest precedent): the backoff, the
 *  index and every cache and stamp, as a fresh module holds them. The module
 *  is a singleton, and a spec running a backoff timer under fake timers
 *  otherwise hands the next test that timer, never to fire on the real
 *  clock, and stamps dated on the fake one. */
export function resetRadarForTest(): void {
	if (retryTimer) {
		clearTimeout(retryTimer);
	}
	retryTimer = null;
	retryDueMs = 0;
	retryDelayMs = RATE_LIMIT_RETRY_MS;
	retryFiredMono = 0;
	index = null;
	lastIndexPollMs = 0;
	indexPollForced = false;
	indexInflight = null;
	errorFkey = null;
	view = null;
	viewSig = '';
	frameInflight.clear();
	reloadNext.clear();
	dropTiles();
	radar.status = 'idle';
	radar.error = null;
	radar.playing = false;
	radar.shownT = null;
	radar.frameCap = null;
	radar.wanted = 0;
}

/** The frames whose head is held, for tests. */
export function radarHeadKeysForTest(): string[] {
	return [...heads.keys()];
}

/** Whether the product shown has nothing in flight or queued (its index,
 *  its frames, a decode), for tests to settle on the work rather than on a
 *  fixed sleep a loaded machine overran. */
export function radarIdleForTest(): boolean {
	return indexInflight == null && inflightCount(curProduct) === 0 && decodesRunning === 0 && decodeQueue.length === 0;
}
