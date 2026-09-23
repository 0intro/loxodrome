/* opera.ts: the EUMETNET OPERA precipitation composites as the app reads
 * them (docs/precipitation-radar.md): the product registry (cadence,
 * publication lag, grid, unit, age tiers), the frame slots and their keys,
 * the frames index the proxy lists, which frames a loop holds, when the
 * index is next worth asking for, how old a frame is and what that age
 * means, which tiles a viewport needs, the two scales the legend and the
 * canvas share, and the URLs of the two proxy routes. Pure and locale-free:
 * the words a reading needs come in as a vocab pack (docs/i18n.md rule 6). */

import { OPERA_GRID, OPERA_GRID_2KM, gridColRow, type OperaGrid } from './laea';

/** The DBZH cadence, minutes. */
export const FRAME_MIN = 5;
export const OPERA_PRODUCTS = ['DBZH', 'RATE'] as const;
export type OperaProduct = (typeof OPERA_PRODUCTS)[number];
export type RadarUnit = 'dBZ' | 'mm/h';
/** The head of a frame the proxy prepends to every tile answer: the five
 *  directories of the composite end at byte 5 673. */
export const OPERA_HEAD_BYTES = 8192;

/** The two ODIM states a decoded cell can carry beside a value: never
 *  radiated (no coverage), and radiated with nothing detected (no echo).
 *  Below every reflectivity the composite carries (-32 dBZ observed), and
 *  below every rain rate (the tenths start at 0). */
export const NODATA = -128;
export const UNDETECT = -127;
/** The GeoTIFF's own nodata value; its undetect is NaN. */
export const RAW_NODATA = -9999000;
/** Below this the composite is cloud, drizzle and clutter, and nothing is
 *  drawn: the FAA's "when the decibel value reaches 15, light precipitation
 *  is present" (AC 00-45H 3.3.4) and Météo-France's aviation floor of
 *  0.4 mm/h, 17 dBZ through Marshall-Palmer (16.6). */
export const DISPLAY_FLOOR_DBZ = 15;
/** The same floor in the RATE product's own unit. */
export const DISPLAY_FLOOR_MMH = 0.4;

const MIN_MS = 60_000;

export type Staleness = 'fresh' | 'aging' | 'stale' | 'expired';

/** The age tiers, minutes: the advisory orange, the danger red, and the
 *  expiry at which the echoes are withdrawn. */
export interface StalenessTiers {
	readonly aging: number;
	readonly stale: number;
	readonly expired: number;
}

export interface OperaProductInfo {
	/** Nominal frame interval, minutes. */
	readonly cadenceMin: number;
	/** How long after its nominal time a frame is expected in the bucket. */
	readonly publicationLagMs: number;
	readonly unit: RadarUnit;
	readonly grid: OperaGrid;
	/** The p90 compressed base tile, for the loop cap. */
	readonly p90TileBytes: number;
	/** Bytes one DECODED cell takes (radarDecode.ts): an Int8 dBZ, or an
	 *  Int16 tenth of mm/h. What a tile costs in the decoded tier. */
	readonly cellBytes: 1 | 2;
	readonly staleness: StalenessTiers;
}

/** The registry, one entry per product. DBZH: the CIRRUS reflectivity
 *  composite, every 5 min, published 4.1 to 5.5 min after nominal (median
 *  4.2; 6.3 worst in XCSoar's day-long measurement); tiers 15 / 20 / 30,
 *  ForeFlight's yellow at 15 and red at 20, which is Garmin's half-of-expiry
 *  rule for a 30-minute expiry. RATE: the NIMBUS instantaneous rain rate
 *  composite on the 2 km grid, every 15 min, published 10.1 min after
 *  nominal on every one of a day's frames; tiers 30 / 35 / 45, since the
 *  successor lands about 26 min after a frame's nominal time (an aging tier
 *  at 25 would go orange a minute before it CAN arrive, every cycle), and
 *  with ONE frame missing the next lands at 40.1 and is listed by the 40.5
 *  poll, so an expiry at 40 would withdraw the echoes for half a minute on
 *  every single gap; 45 is inside ICAO Doc 8896's 75-minute discard
 *  (docs/precipitation-radar.md "The age policy"). */
export const OPERA_PRODUCT_INFO: Record<OperaProduct, OperaProductInfo> = {
	DBZH: {
		cadenceMin: FRAME_MIN,
		publicationLagMs: 4.5 * MIN_MS,
		unit: 'dBZ',
		grid: OPERA_GRID,
		p90TileBytes: 100_000,
		cellBytes: 1,
		staleness: { aging: 15, stale: 20, expired: 30 },
	},
	RATE: {
		cadenceMin: 15,
		publicationLagMs: 10.5 * MIN_MS,
		unit: 'mm/h',
		grid: OPERA_GRID_2KM,
		// Measured on two frames of 2026-09-20 (19:00Z, 19:15Z): p90 135 and
		// 138 KB, the largest 160 KB, the twenty tiles 1.05 MB together.
		p90TileBytes: 150_000,
		cellBytes: 2,
		staleness: { aging: 30, stale: 35, expired: 45 },
	},
};

/** The slot (nominal frame time) at or before `ms`. */
export function floorSlotMs(ms: number, stepMin = FRAME_MIN): number {
	const step = stepMin * MIN_MS;
	return Math.floor(ms / step) * step;
}

/** The key of the slot at or before `ms`: 'YYYYMMDDTHHMM', the bucket's
 *  own spelling. */
export function frameSlot(ms: number, stepMin = FRAME_MIN): string {
	const d = new Date(floorSlotMs(ms, stepMin));
	const p2 = (n: number): string => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}`;
}

const SLOT_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})$/;

/** 'HH:MMZ' of a slot key, the strip's and the badge's time stamp. */
export function slotHHMM(t: string): string {
	return `${t.slice(9, 11)}:${t.slice(11, 13)}Z`;
}

/** 'HH:MMZ' of an instant (a frame's publication time). */
export function hhmmZ(ms: number): string {
	const d = new Date(ms);
	const p2 = (n: number): string => String(n).padStart(2, '0');
	return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}Z`;
}

/** The UTC instant a slot key names, or null for anything else. */
export function slotMs(t: string): number | null {
	const m = SLOT_RE.exec(t);
	if (!m) {
		return null;
	}
	const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
	return frameSlot(ms, 1) === t ? ms : null;
}

export interface RadarFrame {
	/** The slot key. */
	t: string;
	/** Its nominal UTC instant. */
	ms: number;
	/** The object's size, when listed. */
	bytes: number;
	/** When the bucket received it; null when unstated. */
	publishedMs: number | null;
}

export interface FramesIndex {
	product: OperaProduct;
	/** Ascending by time; the newest last. */
	frames: RadarFrame[];
	/** The proxy's own clock when it ANSWERED (its x-opera-now header; the
	 *  body's `now` is the listing's instant, up to the edge TTL earlier on
	 *  a hit, and stands in only when the header is missing), and ours when
	 *  we received it: an age is measured from the first plus the local
	 *  time elapsed since the second, so a skewed device clock never
	 *  expires a fresh frame (or keeps a dead one). */
	upstreamNowMs: number;
	fetchedAtMs: number;
	/** The MONOTONIC clock when we received it (performance.now()): the
	 *  elapsed time an age adds is the longer of the two clocks' own, so a
	 *  device clock stepped back cannot freeze an age (it read a 36-minute
	 *  old frame as 10 minutes old, its echoes never withdrawn), and a
	 *  monotonic clock paused through a device's sleep cannot either. */
	fetchedAtMono: number;
}

/** The monotonic clock the ages elapse on beside the device's. */
export function monoNowMs(): number {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** How far past the proxy's own clock a slot may be dated, and how far
 *  before its nominal time a frame may be published, before it is taken for
 *  a producer's error: the minute the two upstream clocks may disagree by. */
export const SLOT_CLOCK_SLACK_MS = MIN_MS;

/** The proxy's /opera/frames answer, validated field by field, `servedAtMs`
 *  the instant its x-opera-now header states when it does. Null for a
 *  malformed document.
 *
 *  A slot dated after the proxy's own clock, or published before its own
 *  nominal time, is no frame of the composite (a producer keying a frame
 *  ahead of its scan, an hour-offset bug) and is dropped: taken at face
 *  value it read 0 min old, so a feed that had stopped 40 min earlier read
 *  fresh with its echoes drawn, pushed the next index poll out past the
 *  bogus slot, and slid the loop window off the real frames. Judged only
 *  against an UPSTREAM clock (the serve time or the listing's own), never
 *  the device's, which may be slow enough to put a real frame ahead of it. */
export function parseFramesIndex(
	json: unknown,
	fetchedAtMs: number,
	servedAtMs?: number,
	fetchedAtMono: number = monoNowMs(),
): FramesIndex | null {
	if (!json || typeof json !== 'object') {
		return null;
	}
	const o = json as Record<string, unknown>;
	const product = o.product;
	if (product !== 'DBZH' && product !== 'RATE') {
		return null;
	}
	if (!Array.isArray(o.frames)) {
		return null;
	}
	const byKey = new Map<string, RadarFrame>();
	for (const f of o.frames) {
		if (!f || typeof f !== 'object') {
			continue;
		}
		const r = f as Record<string, unknown>;
		const t = typeof r.t === 'string' ? r.t : '';
		const ms = slotMs(t);
		if (ms == null) {
			continue;
		}
		const bytes = typeof r.bytes === 'number' && Number.isFinite(r.bytes) ? r.bytes : 0;
		const pub = typeof r.publishedAt === 'string' ? Date.parse(r.publishedAt) : NaN;
		byKey.set(t, { t, ms, bytes, publishedMs: Number.isFinite(pub) ? pub : null });
	}
	const now = typeof o.now === 'string' ? Date.parse(o.now) : NaN;
	const served = servedAtMs != null && Number.isFinite(servedAtMs) ? servedAtMs : null;
	const upstream = served ?? (Number.isFinite(now) ? now : null);
	const frames = [...byKey.values()]
		.filter(
			(f) =>
				upstream == null ||
				(f.ms <= upstream + SLOT_CLOCK_SLACK_MS &&
					(f.publishedMs == null || f.publishedMs >= f.ms - SLOT_CLOCK_SLACK_MS)),
		)
		.sort((a, b) => a.ms - b.ms);
	return {
		product,
		frames,
		upstreamNowMs: upstream ?? fetchedAtMs,
		fetchedAtMs,
		fetchedAtMono,
	};
}

/** The time elapsed since the index arrived: the longer of the device
 *  clock's and the monotonic clock's (FramesIndex.fetchedAtMono), never
 *  negative. */
export function indexElapsedMs(index: FramesIndex, nowMs: number, monoMs: number = monoNowMs()): number {
	return Math.max(0, nowMs - index.fetchedAtMs, monoMs - index.fetchedAtMono);
}

/** The frames a loop of `loopMin` minutes holds, ending on the newest
 *  frame, at most `cap` of them (the newest kept): an hour is 13 frames,
 *  both ends included. */
export function loopFrames(frames: readonly RadarFrame[], loopMin: number, cap: number): RadarFrame[] {
	if (frames.length === 0) {
		return [];
	}
	const newest = frames[frames.length - 1];
	const start = newest.ms - loopMin * MIN_MS;
	const inWindow = frames.filter((f) => f.ms >= start);
	const keep = Math.max(1, Math.floor(cap));
	return inWindow.length > keep ? inWindow.slice(inWindow.length - keep) : inWindow;
}

/** The slot after (dir 1) or before (dir -1) the shown one, wrapping; a
 *  null `shownT` means the newest frame is shown. Null when there are no
 *  frames. */
export function nextFrame(frames: readonly RadarFrame[], shownT: string | null, dir: 1 | -1): string | null {
	const n = frames.length;
	if (n === 0) {
		return null;
	}
	let idx = shownT == null ? -1 : frames.findIndex((f) => f.t === shownT);
	if (idx < 0) {
		idx = n - 1;
	}
	return frames[(idx + dir + n) % n].t;
}

/** The DBZH publication lag (the registry's; kept named for the specs). */
export const PUBLICATION_LAG_MS = OPERA_PRODUCT_INFO.DBZH.publicationLagMs;
/** While a frame is overdue the index is asked again once a minute. */
export const INDEX_RETRY_MS = MIN_MS;
/** The overdue re-poll comes due this much before the full minute: the gate
 *  is read on the shared minute tick (plus the ensure's debounce), whose
 *  beats land a few milliseconds either side of 60 000 apart, and a beat a
 *  hair early skipped its poll and put the next one two minutes out (six
 *  polls in ten beats), which is the margin RATE's 45-minute expiry is
 *  reasoned on (the successor after one missing frame listed by the 40.5
 *  poll). */
export const INDEX_RETRY_SLACK_MS = 5_000;

/** When the frames index is next worth fetching, on the DEVICE's clock:
 *  never blindly every minute (1 440 requests a day for one idle tab), but
 *  at the instant the next frame should have landed on the INDEX'S OWN
 *  product's cadence and lag, then once a minute while it is overdue. Zero
 *  with no index at all. The slots are on the proxy's clock, so the instant
 *  is moved onto ours by the offset the index carries (the one frameAgeMs
 *  uses): a device minutes slow would otherwise poll that many minutes late
 *  while the age, on the proxy's clock, ran through every tier, and one
 *  minutes ahead would poll every minute. */
export function nextIndexPollMs(index: FramesIndex | null, lastPollMs: number, nowMs: number): number {
	if (!index || index.frames.length === 0) {
		return lastPollMs > 0 ? lastPollMs + INDEX_RETRY_MS : 0;
	}
	const info = OPERA_PRODUCT_INFO[index.product];
	const newest = index.frames[index.frames.length - 1];
	const skewMs = index.upstreamNowMs - index.fetchedAtMs;
	const expected = newest.ms + info.cadenceMin * MIN_MS + info.publicationLagMs - skewMs;
	if (nowMs < expected) {
		return expected;
	}
	return Math.max(expected, lastPollMs + INDEX_RETRY_MS - INDEX_RETRY_SLACK_MS);
}

/** A frame's age at `nowMs`, counted from its NOMINAL time (the scans in
 *  it are older still: the CIRRUS window reaches 10 min back), on the
 *  proxy's clock plus the time elapsed locally since the index arrived
 *  (indexElapsedMs, on both local clocks). */
export function frameAgeMs(frame: RadarFrame, index: FramesIndex, nowMs: number, monoMs: number = monoNowMs()): number {
	const upstreamNow = index.upstreamNowMs + indexElapsedMs(index, nowMs, monoMs);
	return Math.max(0, upstreamNow - frame.ms);
}

/** The DBZH tiers (the registry's; kept named for the specs). */
export const STALENESS_MIN = OPERA_PRODUCT_INFO.DBZH.staleness;

/** The minutes an age PRINTS: floored, since the tiers compare the exact
 *  age. Rounded, 14.6 min printed "15 min ago" in the fresh ink, 19.6 "20"
 *  in the advisory orange and 29.6 "30 min ago" over echoes still drawn, the
 *  expiry notice saying they go AT 30, for up to a minute at each tier. */
export function ageMinutes(ageMs: number): number {
	return Math.max(0, Math.floor(ageMs / MIN_MS));
}

/** The tier an age falls in, on the product's own tiers (a graceful
 *  default: a missed product reads a RATE frame as older than it is,
 *  never as fresher). */
export function radarStaleness(ageMs: number, product: OperaProduct = 'DBZH'): Staleness {
	const tiers = OPERA_PRODUCT_INFO[product].staleness;
	const min = ageMs / MIN_MS;
	if (min >= tiers.expired) {
		return 'expired';
	}
	if (min >= tiers.stale) {
		return 'stale';
	}
	if (min >= tiers.aging) {
		return 'aging';
	}
	return 'fresh';
}

/** One cache tier a loop must fit in: the bytes it may plan on, and what
 *  ONE view tile of one frame costs there. */
export interface LoopTier {
	readonly budgetBytes: number;
	readonly bytesPerTile: number;
}

/** How many frames a loop may hold for a view of `tileCount` tiles: the
 *  fewest that ANY tier holds, at least one. Two tiers hold a loop in
 *  state/radar.svelte.ts and both bound it: tier A, the COMPRESSED tiles the
 *  loop replays from, at the bytes the view's tiles measure (the product's
 *  p90 until they are held), and tier B, the DECODED cells the paint reads,
 *  at their exact size for the display pooling (decodedTileBytes). A cap on
 *  tier A alone let a two-hour DBZH loop over six tiles at pooling 1 want
 *  39 MB of decoded cells from a phone's 32: the eviction then took, at
 *  every beat, the very frame the loop showed next, and the canvas inflated
 *  it again, for as long as the layer was on. */
export function loopFrameCap(tileCount: number, tier: LoopTier, ...more: LoopTier[]): number {
	if (tileCount <= 0) {
		return 1;
	}
	let cap = Infinity;
	for (const t of [tier, ...more]) {
		cap = Math.min(cap, Math.floor(t.budgetBytes / (tileCount * t.bytesPerTile)));
	}
	return Math.max(1, cap);
}

/** The bytes one DECODED tile holds at pooling `p`: (512 / p) squared cells
 *  of the product's cell type (maxPool keeps the element type). */
export function decodedTileBytes(product: OperaProduct, p: number): number {
	const info = OPERA_PRODUCT_INFO[product];
	const side = info.grid.tile / Math.max(1, p);
	return side * side * info.cellBytes;
}

/** A max-pooling factor: a power of two, up to a tile's own 512 cells. */
export type OperaPooling = 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256 | 512;

/** The max-pooling factor for a map drawn at `metresPerPx`: the smallest
 *  power of two whose pooled cell spans at least sqrt(2) screen pixels, so
 *  every cell holds a pixel centre whatever its angle to the screen (the
 *  grid's cells turn against Mercator's away from the projection's central
 *  meridian). The paint reads the one cell under each pixel's centre, and a
 *  cell holding none was never drawn, whatever its maximum: rounding to the
 *  NEAREST power of two let cells shrink to 0.7 px, and north of about 55 N
 *  up to half of them, the strongest echoes among them, never reached the
 *  map (ICAO Doc 8896 App. 9 3.2.2: never understate the most intense cell).
 *  A pooled cell spans sqrt(2) to 2 sqrt(2) pixels at `metresPerPx`, which
 *  must be the view's largest (poolingAt). Pooling keeps the maximum, so a
 *  coarser cell never loses an echo, and a tile's 512 divides evenly. */
export function poolingFor(metresPerPx: number, cellM: number): OperaPooling {
	if (!(metresPerPx > 0)) {
		return 1;
	}
	const e = Math.ceil(Math.log2((Math.SQRT2 * metresPerPx) / cellM));
	return (2 ** Math.max(0, Math.min(9, e))) as OperaPooling;
}

/** Web Mercator's metres per CSS pixel at the equator and zoom 0. */
const MERCATOR_M_PER_PX_Z0 = 156543.03392;

/** The pooling a view draws at, from the zoom and the view's latitudes: ONE
 *  recipe for the canvas's draw and the ensure's prefetch, so a zoom paints
 *  through its own pooling at once rather than a debounced pass's last. Read
 *  at the view's latitude nearest the equator, where a pixel covers the most
 *  ground and a pooled cell the fewest pixels. */
export function poolingAt(zoom: number, south: number, north: number, cellM: number): OperaPooling {
	const lat = south <= 0 && north >= 0 ? 0 : Math.min(Math.abs(south), Math.abs(north));
	return poolingFor((MERCATOR_M_PER_PX_Z0 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom, cellM);
}

/** Inclusive cell bounds on the grid. */
export interface GridBox {
	c0: number;
	r0: number;
	c1: number;
	r1: number;
}

const EDGE_SAMPLES = 8;

/** The cells a geographic box reaches, from a lattice of its points
 *  projected one by one (a lat/lon rectangle is a curved quadrilateral on
 *  the grid, and a box wide enough to hold the whole composite has every
 *  edge point north of it, over the pole, or on the far hemisphere, where
 *  the projection has no place: the interior is what reaches the grid), or
 *  null when none of it lies on the composite. */
export function gridBoxOfBounds(
	b: { west: number; south: number; east: number; north: number },
	grid: OperaGrid,
): GridBox | null {
	// Leaflet's bounds are unwrapped: a drag round the world leaves Europe
	// at 350..370 E, which the projection's own periodicity handles but a
	// clamp to 180 would read as off the composite. Both edges move by the
	// turn that brings the centre into [-180, 180).
	const turn = 360 * Math.floor(((b.west + b.east) / 2 + 180) / 360);
	b = { west: b.west - turn, east: b.east - turn, south: b.south, north: b.north };
	let c0 = Infinity;
	let r0 = Infinity;
	let c1 = -Infinity;
	let r1 = -Infinity;
	const take = (lat: number, lon: number): void => {
		const g = gridColRow(Math.max(-89.9, Math.min(89.9, lat)), Math.max(-180, Math.min(180, lon)), grid);
		if (!g) {
			return;
		}
		if (g.col < c0) c0 = g.col;
		if (g.col > c1) c1 = g.col;
		if (g.row < r0) r0 = g.row;
		if (g.row > r1) r1 = g.row;
	};
	for (let i = 0; i <= EDGE_SAMPLES; i++) {
		const lon = b.west + (i / EDGE_SAMPLES) * (b.east - b.west);
		for (let j = 0; j <= EDGE_SAMPLES; j++) {
			take(b.south + (j / EDGE_SAMPLES) * (b.north - b.south), lon);
		}
	}
	if (!Number.isFinite(c0) || c1 < 0 || r1 < 0 || c0 >= grid.cols || r0 >= grid.rows) {
		return null;
	}
	return {
		c0: Math.max(0, Math.floor(c0)),
		r0: Math.max(0, Math.floor(r0)),
		c1: Math.min(grid.cols - 1, Math.floor(c1)),
		r1: Math.min(grid.rows - 1, Math.floor(r1)),
	};
}

/** The tile indices (row-major, under the grid's count) covering a cell
 *  box, ascending. */
export function tilesCovering(box: GridBox, grid: OperaGrid): number[] {
	const out: number[] = [];
	const t = grid.tile;
	for (let ty = Math.floor(box.r0 / t); ty <= Math.floor(box.r1 / t); ty++) {
		for (let tx = Math.floor(box.c0 / t); tx <= Math.floor(box.c1 / t); tx++) {
			out.push(ty * grid.tileCols + tx);
		}
	}
	return out;
}

export type RadarWord = 'light' | 'moderate' | 'heavy' | 'extreme';

export interface RadarScaleStep {
	/** Inclusive lower bound, in the scale's unit. */
	min: number;
	color: string;
	/** ICAO Doc 8896 App. 9 Table A9-1 level. */
	level: 1 | 2 | 3 | 4 | 5 | 6;
	word: RadarWord;
}

/** A product's scale: its unit, the display floor (the first step's bound),
 *  how many stored integers make one unit (1 for dBZ, 10 for the tenths of
 *  mm/h), and the steps. */
export interface RadarScale {
	readonly unit: RadarUnit;
	readonly floor: number;
	readonly perUnit: 1 | 10;
	readonly steps: readonly RadarScaleStep[];
}

/** The reflectivity scale: ICAO Doc 8896 App. 9 Table A9-1 (the only ICAO
 *  cockpit precipitation levels: green up to 30 dBZ, amber to 40, red
 *  above, magenta above 50) at the FIS-B bin edges (GDL 90 Table 20 /
 *  DO-358: 20 / 30 / 40 / 45 / 50 / 55), each level shaded once for
 *  detail, NEXRAD-family hues, no blue (blue is snow in the EFB legends),
 *  and the FAA's four words (AIM 7-1-12). Fixed hex: the canvas and the
 *  legend chips read this one table (map overlays never read CSS
 *  variables). Strictly ascending; every step reachable (pinned). */
export const RADAR_SCALE: RadarScale = {
	unit: 'dBZ',
	floor: DISPLAY_FLOOR_DBZ,
	perUnit: 1,
	steps: [
		{ min: 15, color: '#a5d6a7', level: 1, word: 'light' },
		{ min: 20, color: '#43a047', level: 1, word: 'light' },
		{ min: 30, color: '#ffee58', level: 2, word: 'moderate' },
		{ min: 35, color: '#ffb300', level: 2, word: 'moderate' },
		{ min: 40, color: '#f4511e', level: 3, word: 'heavy' },
		{ min: 45, color: '#d32f2f', level: 4, word: 'heavy' },
		{ min: 50, color: '#d81b60', level: 5, word: 'extreme' },
		{ min: 55, color: '#8e24aa', level: 6, word: 'extreme' },
	],
};

/** The rain-rate scale: the SAME hue ramp with mm/h bounds, so a pilot
 *  toggling the unit never watches a cell change hazard colour. The bounds
 *  carry all six edges of Météo-France's Guide aviation legend (0.4, 2, 11,
 *  20, 65, 115 mm/h) plus 1 and 5 so each level is shaded twice like the
 *  dBZ table's; the words align with the dBZ words through Marshall-Palmer
 *  within its factor of two (light under 2 mm/h is about 15 to 28 dBZ,
 *  moderate 2 to 11 about 28 to 40, heavy 11 to 65 about 40 to 52, extreme
 *  above). Météo-France's own violet / cyan ramp is a later preference
 *  (docs/precipitation-radar-backlog.md 3.2). */
export const RATE_SCALE: RadarScale = {
	unit: 'mm/h',
	floor: DISPLAY_FLOOR_MMH,
	perUnit: 10,
	steps: [
		{ min: 0.4, color: '#a5d6a7', level: 1, word: 'light' },
		{ min: 1, color: '#43a047', level: 1, word: 'light' },
		{ min: 2, color: '#ffee58', level: 2, word: 'moderate' },
		{ min: 5, color: '#ffb300', level: 2, word: 'moderate' },
		{ min: 11, color: '#f4511e', level: 3, word: 'heavy' },
		{ min: 20, color: '#d32f2f', level: 4, word: 'heavy' },
		{ min: 65, color: '#d81b60', level: 5, word: 'extreme' },
		{ min: 115, color: '#8e24aa', level: 6, word: 'extreme' },
	],
};

export const RADAR_SCALES: Record<OperaProduct, RadarScale> = { DBZH: RADAR_SCALE, RATE: RATE_SCALE };

/** The darker check Level 6 alternates with: the texture Table A9-1 lets
 *  the top level carry, visible once a cell spans a few pixels. */
export const LEVEL6_TEXTURE_COLOR = '#4a148c';
/** The no-coverage hatch ink (over the grey the pane's night dim keeps). */
export const NO_COVERAGE_COLOR = '#78909c';

/** Index into a scale's steps for a STORED cell integer (dBZ, or tenths of
 *  mm/h), -1 below the display floor. The bounds are compared in the stored
 *  integer's own resolution (min * perUnit), so 0.4 mm/h is tenths 4. */
export function cellClass(cell: number, scale: RadarScale): number {
	let k = -1;
	const steps = scale.steps;
	for (let i = 0; i < steps.length; i++) {
		if (cell >= Math.round(steps[i].min * scale.perUnit)) {
			k = i;
		} else {
			break;
		}
	}
	return k;
}

/** The class of a value in the scale's UNIT (a badge's reading). */
export function valueClass(value: number, scale: RadarScale): number {
	return cellClass(Math.round(value * scale.perUnit), scale);
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** One RGBA pixel as the Uint32 an ImageData's buffer holds on this
 *  platform (bytes r, g, b, a in memory order). */
export function packRgba(r: number, g: number, b: number, a: number): number {
	return LITTLE_ENDIAN
		? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
		: ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

export function hexRgba(hex: string, a = 255): number {
	const n = parseInt(hex.slice(1), 16);
	return packRgba((n >> 16) & 255, (n >> 8) & 255, n & 255, a);
}

/** Every LUT is indexed `cell + LUT_OFFSET`, whatever the product: the two
 *  sentinels sit at 0 and 1, a dBZ cell in -128..127 within the first 256
 *  entries, and the tenths of mm/h in 0..4095 above the offset. One paint
 *  path, one sample path. */
export const LUT_OFFSET = 128;
/** The widest stored cell: 409.5 mm/h in tenths (the composite tops at 137). */
export const RATE_CELL_MAX = 4095;

/** What the canvas paints a product with: the colour of every stored cell
 *  value (the sentinels and everything under the floor transparent; the
 *  no-coverage hatch is painted separately, from the sentinel itself), and
 *  the Level 6 texture: from which stored value the darker check applies
 *  and its ink. */
export interface RadarPaint {
	readonly lut: Uint32Array;
	readonly textureFrom: number;
	readonly textureRgba: number;
}

export function buildPaint(product: OperaProduct): RadarPaint {
	const scale = RADAR_SCALES[product];
	const top = scale.perUnit === 1 ? 127 : RATE_CELL_MAX;
	const lut = new Uint32Array(LUT_OFFSET + top + 1);
	for (let v = -128; v <= top; v++) {
		if (v === NODATA || v === UNDETECT) {
			continue;
		}
		const k = cellClass(v, scale);
		if (k >= 0) {
			lut[v + LUT_OFFSET] = hexRgba(scale.steps[k].color);
		}
	}
	const last = scale.steps[scale.steps.length - 1];
	return { lut, textureFrom: Math.round(last.min * scale.perUnit), textureRgba: hexRgba(LEVEL6_TEXTURE_COLOR) };
}

/** Rain rate from reflectivity by Marshall-Palmer, Z = 200 R^1.6, the
 *  relation the composite's own RATE product states (zr_a 200, zr_b 1.6;
 *  WMO-No. 8 Vol. III 7.3, "uncertainty of a factor of two"). */
export function marshallPalmerMmH(dbz: number): number {
	return (10 ** (dbz / 10) / 200) ** (1 / 1.6);
}

/** The inverse: the reflectivity a rain rate reads as (the RATE legend's
 *  tooltip). */
export function marshallPalmerDbz(mmH: number): number {
	return 10 * Math.log10(200 * mmH ** 1.6);
}

export function framesUrl(base: string, product: OperaProduct, hours: number): string {
	return `${base}/opera/frames?product=${product}&hours=${Math.max(1, Math.min(6, Math.round(hours)))}`;
}

export function frameUrl(base: string, t: string, product: OperaProduct, tiles: readonly number[]): string {
	return `${base}/opera/${t}/${product}.tiff?tiles=${tiles.join(',')}`;
}

/** What the map answers under a point: an echo with its value in the
 *  product's unit, a radiated dry cell, or no coverage. */
export interface RadarSample {
	kind: 'echo' | 'none' | 'nocoverage';
	product: OperaProduct;
	/** dBZ, or mm/h to the tenth. */
	value: number | null;
	/** The frame it was read from. */
	t: string;
}

/** The stored cell of a sample (tenths under mm/h), for a legend lookup. */
export function sampleCell(sample: RadarSample): number | null {
	return sample.value == null ? null : Math.round(sample.value * RADAR_SCALES[sample.product].perUnit);
}

export interface RadarWords {
	/** "Radar" */
	radar: string;
	noCoverage: string;
	words: Record<RadarWord, string>;
	/** The locale's number with `digits` decimals ("2,4" in French). */
	number: (value: number, digits: number) => string;
}

/** The badge / menu lines for a sample: the value in its unit with its
 *  word, or the no-coverage statement; nothing for a dry cell. */
export function radarTipLines(sample: RadarSample, words: RadarWords): string[] {
	if (sample.kind === 'nocoverage') {
		return [words.noCoverage];
	}
	if (sample.kind === 'echo' && sample.value != null) {
		const scale = RADAR_SCALES[sample.product];
		const k = valueClass(sample.value, scale);
		const word = k >= 0 ? `, ${words.words[scale.steps[k].word]}` : '';
		const value = scale.perUnit === 1 ? String(sample.value) : words.number(sample.value, 1);
		return [`${words.radar} ${value} ${scale.unit}${word}`];
	}
	return [];
}
