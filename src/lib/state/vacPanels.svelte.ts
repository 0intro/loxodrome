/* Rendering VAC panels for the map: the queue, the cache and the bytes.
 *
 * A panel is one rectangle of one page of one plate. Rendering it means
 * fetching that plate's PDF (offline/docFetch.ts, from a downloaded pack or
 * by ranged reads of the same archive on the worker) and drawing the clip
 * region with pdf.js, which the app already carries for the printed meteo
 * annex.
 *
 * Vector in, raster out, at the resolution the map is actually showing. The
 * plates are pure vector, so a panel is crisp at any zoom as long as it is
 * re-rendered when the zoom moves far enough to matter; the scale is
 * bucketed by half a power of two so panning and small zoom steps reuse
 * what is already drawn. That is the whole reason this feature ships the
 * PDFs rather than a tile pyramid: the same 195 MB pack a pilot already
 * downloads for the plates themselves serves the overlay, at any scale,
 * with nothing new to store.
 *
 * The cache is bounded by BYTES, and it has to be: a panel's bitmap spans
 * three orders of magnitude between a thumbnail at zoom 9 and a full-size
 * approach sheet, so a ceiling counted in panels is not a ceiling on
 * anything. Counting eight of them held about two megabytes over the Loire
 * and would have held ninety over an aerodrome, and it thrashed at the
 * small end: eleven sheets are drawn at once on a wide screen at zoom 9,
 * three were evicted after every pass, and the two nearest the middle
 * flickered on and off as they took turns being redrawn.
 *
 * Eviction never touches a panel the CURRENT pass asked for, whatever the
 * budget says. A view that wants more bitmap than the ceiling should go
 * over it for as long as it is on screen; dropping what is being drawn to
 * stay under a number is how the flicker happened. */

import { untrack } from 'svelte';

import { panelPtPerDegLat, type VacPanel } from '$lib/data/vacgeo';
import { currentAiracString } from '$lib/data/airac';
import { fetchDocBytes, resetDocFetchCache, type DocSource } from '$lib/offline/docFetch';
import { docPackDef } from '$lib/offline/docPacks';
import { vacDocName } from '$lib/offline/docNames';
import { docPackFor } from '$lib/state/offlineDocs.svelte';
import {
	evictable,
	PANEL_BITMAP_BUDGET,
	panelKey,
	scaleBucket,
	standInKey,
} from '$lib/state/panelCache';
import { proxyBase } from '$lib/autorouter/state.svelte';

/** Longest side a rendered panel may have, in device pixels. Past this the
 *  bitmap costs more memory than the extra detail is worth on a phone. */
const MAX_SIDE_PX = 2600;

/** How many plates to fetch and rasterize at once. */
const MAX_INFLIGHT = 2;

export const vacRenderState = $state<{
	/** Bumped whenever a panel finishes or fails, so the map layer redraws. */
	gen: number;
	/** Panels being fetched or drawn right now, for a quiet progress hint. */
	pending: number;
}>({ gen: 0, pending: 0 });

/** One drawn panel, ready to blit. */
export interface RenderedPanel {
	panel: VacPanel;
	canvas: HTMLCanvasElement;
	/** Device pixels per PDF point, so the layer can tell how sharp it is. */
	scale: number;
}

interface Entry {
	used: number;
	/** The bitmap's size, and zero for a render that failed: a miss is
	 *  remembered so a plate the packs do not carry is not re-fetched on
	 *  every map move, and remembering it costs nothing. */
	bytes: number;
	value: RenderedPanel | null;
}

// Plain maps: the gen counter above is the reactive signal. Rendered
// bitmaps must never become reactive state, or every draw would deep-proxy
// a canvas.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- render cache, keyed by hand
const cache = new Map<string, Entry>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- in-flight guard
const inflight = new Set<string>();
let clock = 0;
let cacheBytes = 0;
// The clock reading the current pass began at. Anything touched since is
// on screen now.
let passStart = 0;
let queue: { panel: VacPanel; scale: number; key: string }[] = [];

/** The plate file a panel lives in, and where to read it from. Current
 *  cycle first: before a promotion the pre-release pack holds NEXT cycle's
 *  edition of the same file name, which must not win while this cycle's is
 *  on disk.
 *
 *  Only the current-cycle source carries a relay. The proxy route names an
 *  AIRAC cycle, and the cycle in force is the one the plate links elsewhere
 *  in the app resolve to (siaAtlasVacUrl); asking the publisher for a
 *  pre-release edition it may not have published is not a fallback, it is a
 *  guess. */
function sourcesFor(p: VacPanel): { name: string; sources: DocSource[] } {
	const name = vacDocName(p.ident, p.section);
	const sources: DocSource[] = [];
	for (const id of ['fr-vac', 'fr-vac-next'] as const) {
		const def = docPackDef(id);
		if (!def) {
			continue;
		}
		sources.push({
			local: docPackFor(id),
			archive: def.archive,
			relay:
				id === 'fr-vac'
					? `${proxyBase()}/sia/vac/${currentAiracString()}/${name}`
					: null,
		});
	}
	return { name, sources };
}

/** A rendered panel if it is in hand, else null. Requesting one that is not
 *  queues it; the layer redraws when vacRenderState.gen moves. */
export function renderedPanel(p: VacPanel, scale: number): RenderedPanel | null {
	const bucket = scaleBucket(scale);
	const key = panelKey(p, bucket);
	const hit = cache.get(key);
	if (hit) {
		hit.used = ++clock;
		// The wanted scale is in hand, so the older pictures of this panel
		// are dead weight: they were only ever there to stand in until this
		// arrived, and the next zoom will stand in on THIS one. Left alone
		// they would hold their bytes until the next selection pass, since
		// eviction spares whatever the current pass has touched, and a
		// reader who zooms once and stops would sit on two bitmaps a panel.
		for (const k of [...cache.keys()]) {
			if (k !== key && standInKey([k], p, bucket) === k) {
				cacheBytes -= cache.get(k)?.bytes ?? 0;
				cache.delete(k);
			}
		}
		return hit.value;
	}
	if (!inflight.has(key) && !queue.some((q) => q.key === key)) {
		queue.push({ panel: p, scale: bucket, key });
		pump();
	}
	// Nothing at this scale yet, so hand back the picture this panel
	// already has at another one and let it stretch until the right one
	// lands. Without it a zoom step misses every panel at once and the
	// whole overlay goes blank, layer and all, for as long as the batch
	// takes to rasterise.
	const drawnKeys: string[] = [];
	for (const [k, e] of cache) {
		if (e.value) {
			drawnKeys.push(k);
		}
	}
	const stand = standInKey(drawnKeys, p, bucket);
	if (stand !== null) {
		const e = cache.get(stand);
		if (e?.value) {
			e.used = ++clock;
			return e.value;
		}
	}
	return null;
}

/** Open a pass: the caller is about to ask for the panels it wants now.
 *
 *  Drops everything the queue has not started, so a pan away from an
 *  aerodrome does not keep fetching its plates, and marks the clock so
 *  eviction can tell what is on screen from what merely was. */
export function beginPanelPass(): void {
	queue = [];
	passStart = clock;
}

function pump(): void {
	while (inflight.size < MAX_INFLIGHT && queue.length > 0) {
		const job = queue.shift();
		if (!job || cache.has(job.key) || inflight.has(job.key)) {
			continue;
		}
		inflight.add(job.key);
		untrack(() => {
			vacRenderState.pending = inflight.size + queue.length;
		});
		void renderPanel(job.panel, job.scale)
			.then((value) => {
				const bytes = value ? value.canvas.width * value.canvas.height * 4 : 0;
				cache.set(job.key, { used: ++clock, bytes, value });
				cacheBytes += bytes;
				evict();
			})
			.catch(() => {
				cache.set(job.key, { used: ++clock, bytes: 0, value: null });
			})
			.finally(() => {
				inflight.delete(job.key);
				untrack(() => {
					vacRenderState.pending = inflight.size + queue.length;
					vacRenderState.gen++;
				});
				pump();
			});
	}
}

function evict(): void {
	while (cacheBytes > PANEL_BITMAP_BUDGET) {
		const key = evictable(cache, passStart);
		if (key === null) {
			return;
		}
		cacheBytes -= cache.get(key)?.bytes ?? 0;
		cache.delete(key);
	}
}

interface Rasterizer {
	render(
		data: ArrayBuffer,
		page: number,
		clip: readonly [number, number, number, number],
		scale: number,
	): Promise<HTMLCanvasElement>;
}

let rasterizer: Promise<Rasterizer> | null = null;

/** pdf.js on demand, with ONE shared worker for the session: a map pans
 *  across many aerodromes and spinning a worker per plate would cost more
 *  than the drawing. The tripCharts.ts pattern, with the document destroyed
 *  after each render and the worker kept. */
function loadRasterizer(): Promise<Rasterizer> {
	rasterizer ??= (async () => {
		const [pdfjs, workerUrl] = await Promise.all([
			import('pdfjs-dist'),
			import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
		]);
		pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;
		const worker = new pdfjs.PDFWorker();
		return {
			async render(data, pageNo, clip, scale) {
				const task = pdfjs.getDocument({ data: new Uint8Array(data), worker });
				try {
					const doc = await task.promise;
					const page = await doc.getPage(pageNo);
					// rotation 0 on purpose: the clip rectangle is in the
					// page's own unrotated coordinates, which is what
					// cmd/vacgeo measured, and honouring a /Rotate here
					// would silently transpose it.
					const viewport = page.getViewport({ scale, rotation: 0 });
					const canvas = document.createElement('canvas');
					canvas.width = Math.max(1, Math.round((clip[2] - clip[0]) * scale));
					canvas.height = Math.max(1, Math.round((clip[3] - clip[1]) * scale));
					// Shift the clip's top-left corner to the canvas origin.
					// Viewport space is top-down, so the clip's TOP is its
					// y1 measured from the page's own bottom-left origin.
					const dx = -clip[0] * scale;
					const dy = -(viewport.height - clip[3] * scale);
					await page.render({
						canvas,
						viewport,
						transform: [1, 0, 0, 1, dx, dy],
					}).promise;
					return canvas;
				} finally {
					await task.destroy();
				}
			},
		};
	})();
	return rasterizer;
}

async function renderPanel(p: VacPanel, scale: number): Promise<RenderedPanel | null> {
	const wPt = p.clip[2] - p.clip[0];
	const hPt = p.clip[3] - p.clip[1];
	if (wPt <= 0 || hPt <= 0) {
		return null;
	}
	const capped = Math.min(scale, MAX_SIDE_PX / Math.max(wPt, hPt));
	const { name, sources } = sourcesFor(p);
	const data = await fetchDocBytes(name, sources);
	if (!data) {
		return null;
	}
	const r = await loadRasterizer();
	const canvas = await r.render(data, p.page, p.clip, capped);
	return { panel: p, canvas, scale: capped };
}

/** What a panel's bitmap will cost, in bytes, at this zoom on this screen.
 *  The selector spends its budget in these units, so the model lives here
 *  beside the cap it has to respect rather than being guessed at twice. */
export function panelBitmapBytes(p: VacPanel, zoom: number, dpr: number): number {
	const wPt = p.clip[2] - p.clip[0];
	const hPt = p.clip[3] - p.clip[1];
	if (wPt <= 0 || hPt <= 0) {
		return 0;
	}
	const scale = Math.min(panelScaleFor(p, zoom, dpr), MAX_SIDE_PX / Math.max(wPt, hPt));
	return wPt * scale * hPt * scale * 4;
}

/** Device pixels per PDF point a panel needs to look right at this zoom. */
export function panelScaleFor(p: VacPanel, zoom: number, dpr: number): number {
	const ptPerDeg = panelPtPerDegLat(p);
	if (ptPerDeg <= 0) {
		return 1;
	}
	const lat = ((p.south + p.north) / 2) * (Math.PI / 180);
	const pxPerDeg = ((256 * Math.pow(2, zoom)) / 360) / Math.cos(lat);
	return (pxPerDeg / ptPerDeg) * dpr;
}

/** Drop every rendered panel. For tests, and when a pack lands or goes. */
export function resetVacPanels(): void {
	cache.clear();
	cacheBytes = 0;
	queue = [];
}

let seenDocGen = -1;

/** A pack that landed, went, or was promoted at a cycle boundary changes
 *  what a plate's bytes ARE, under file names that did not move: the
 *  pre-release pack carries next cycle's edition of every one of them. So
 *  both the fetched documents and the pictures drawn from them go when
 *  `offlineDocs.gen` moves.
 *
 *  Called from the map effect, which already reads that signal. Comparing
 *  against the last value seen is what makes it a change test rather than a
 *  cache the effect empties on every run. */
export function syncDocPacks(gen: number): void {
	if (gen === seenDocGen) {
		return;
	}
	seenDocGen = gen;
	resetDocFetchCache();
	resetVacPanels();
}
