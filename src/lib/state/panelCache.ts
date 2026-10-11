/* The rendered-panel cache's arithmetic, kept out of the state module so a
 * test can reach it: vacPanels.svelte.ts pulls in the offline pack store and
 * Leaflet behind it, and none of that is needed to decide what a bitmap is
 * keyed by or which one goes next. The house pattern of state/asyncCache.ts. */

/** How much rendered bitmap the overlay may hold, and so how much it may
 *  ask for: the selector spends this budget choosing what to draw and the
 *  cache holds exactly that, which is why they are one number. A selector
 *  that asked for more than the cache keeps would force it to evict what is
 *  on screen, and that is the flicker the pass guard below exists to stop.
 *
 *  Enough for a dozen sheets over the Paris basin, or four full-size ones
 *  over an aerodrome. Drawing every sheet in view instead would be 112 MB
 *  over Creteil at zoom 13 and 121 MB over Lognes at zoom 12. */
export const PANEL_BITMAP_BUDGET = 64 << 20;

/** The scale a panel is rendered at is bucketed to half a power of two: a
 *  pan or a small zoom step then reuses the bitmap instead of asking pdf.js
 *  for the same picture again. */
export function scaleBucket(scale: number): number {
	return Math.pow(2, Math.round(Math.log2(Math.max(scale, 1e-6)) * 2) / 2);
}

/** What identifies a drawn panel: which rectangle of which page, and how big
 *  it was drawn. Never the raw scale, or every pixel of pan would be a miss. */
export function panelKey(
	p: { ident: string; section: number; page: number },
	bucket: number,
): string {
	return `${p.ident}|${p.section}|${p.page}|${bucket.toFixed(3)}`;
}

/** How far from the wanted scale a bitmap may be and still stand in for it,
 *  as a ratio. One zoom step doubles the scale, so 2 covers the common case
 *  and 4 covers a double-click or a pinch of two levels; past that the
 *  picture is a smear and waiting is better. */
const STAND_IN_RATIO = 4;

/** A bitmap of the same panel at another scale, to draw while the wanted one
 *  renders, or null if nothing close enough is held.
 *
 *  The cache is keyed by scale bucket, so a zoom step misses EVERY panel at
 *  once and the whole overlay went blank until the batch finished
 *  rasterising: 1.5 seconds over the Paris basin, twenty-one sheets two at a
 *  time. A tile layer does not do this; it keeps the parent tile and lets it
 *  stretch. The panel layer can do the same for nothing, because it places
 *  each panel by its own three corners and any bitmap resolution is already
 *  just a scale.
 *
 *  The LARGER bucket wins a tie: downscaling a bitmap looks like a chart
 *  slightly soft, upscaling one looks like a smear. */
export function standInKey(
	drawn: Iterable<string>,
	p: { ident: string; section: number; page: number },
	want: number,
): string | null {
	const prefix = `${p.ident}|${p.section}|${p.page}|`;
	let best: string | null = null;
	let bestOff = Infinity;
	let bestBucket = 0;
	for (const k of drawn) {
		if (!k.startsWith(prefix)) {
			continue;
		}
		const bucket = Number(k.slice(prefix.length));
		if (!(bucket > 0) || bucket === want) {
			continue;
		}
		const ratio = bucket > want ? bucket / want : want / bucket;
		if (ratio > STAND_IN_RATIO) {
			continue;
		}
		const off = Math.abs(Math.log2(bucket / want));
		if (off < bestOff || (off === bestOff && bucket > bestBucket)) {
			best = k;
			bestOff = off;
			bestBucket = bucket;
		}
	}
	return best;
}

/** The next panel to drop: the least recently used one the CURRENT pass did
 *  not ask for, or null when every panel held is on screen.
 *
 *  Protecting the pass is what stops the flicker, and no budget can do it
 *  instead. Eleven approach sheets are drawn at once on a wide screen at
 *  zoom 9; each pass touches all eleven, so a ceiling below that evicts
 *  whichever were touched first, they are redrawn on the next pass, and
 *  they evict others in their turn. A view that wants more bitmap than the
 *  ceiling goes over it for as long as it is on screen, which is the right
 *  way round: dropping what is being drawn to stay under a number is how
 *  the flicker happened. */
export function evictable(
	entries: Iterable<readonly [string, { used: number }]>,
	passStart: number,
): string | null {
	let oldestKey: string | null = null;
	let oldest = Infinity;
	for (const [k, e] of entries) {
		if (e.used > passStart || e.used >= oldest) {
			continue;
		}
		oldest = e.used;
		oldestKey = k;
	}
	return oldestKey;
}
