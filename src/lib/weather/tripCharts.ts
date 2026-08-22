/* Flight-relevant TEMSI / WINTEM chart snapshot for the printed flight
 * dossier's meteo annex (the tripWx.ts pattern: plain async orchestration,
 * never rejects, per-chart degradation). The pure half - flight-level
 * parsing, the planned-altitude range, the zone pick and the selection of
 * catalog charts covering the flight window - is exported for the Vitest
 * pins; the fetch half downloads each selected PDF through the worker relay
 * (GET /sofia/chart: aviation.meteo.fr sends no CORS headers and its tokens
 * bind one exact chart, so the browser cannot read the bytes directly) and
 * rasterizes page 1 with a dynamically imported pdf.js, keeping the main
 * bundle clean. Catalogs are passed IN (state/sofiaCharts.svelte.ts owns the
 * cache and the SOFIA pacing); callers gate on display.liveWeather.
 * Contract notes: docs/sofia-charts.md. */

import type { SofiaChart, SofiaChartProduct, SofiaZone } from '$lib/sofia/charts';

/** Nominal validity spacing when a group has a single chart (TEMSI / WINTEM
 *  FRANCE are 3-hourly; a lone EUROC chart errs conservative). */
const NOMINAL_STEP_MS = 3 * 3_600_000;

/** Politeness pause between two chart PDF downloads. */
const DOWNLOAD_PACE_MS = 250;

/** Hung requests must settle (the awc.ts convention). */
const FETCH_TIMEOUT_MS = 15_000;

/** Long side of the rasterized chart, px (~190 dpi on A4). */
const RASTER_LONG_SIDE_PX = 2200;

export interface TripChartEntry {
	chart: SofiaChart;
	pngDataUrl: string;
	wPx: number;
	hPx: number;
}

/** Why a product+zone group yielded no chart, printed as a note line so a
 *  missing TEMSI is never read as "no significant weather applies":
 *  'not-yet-published' = the catalog has charts but the flight window lies
 *  beyond the last validity (TEMSI FRANCE appears only ~1-2 h ahead),
 *  'undated' = the group's validity dates were unreadable. */
export interface TripChartNote {
	product: SofiaChartProduct;
	zone: string;
	kind: 'not-yet-published' | 'undated';
}

export interface TripChartsDoc {
	/** Snapshot time, ms: the sheets' "Retrieved" stamp. */
	fetchedAtMs: number;
	/** Rendered charts in print order: TEMSI then WINTEM. */
	entries: TripChartEntry[];
	notes: TripChartNote[];
	/** Charts selected but not rendered (download or rasterize failure). */
	failedCount: number;
	/** Every requested zone's catalog failed. */
	catalogError: boolean;
}

/** The chart's invariant display token (SOFIA's own product / zone / level
 *  vocabulary): sheet heads and the print-progress step line. */
export function chartToken(c: SofiaChart): string {
	return `${c.product} ${c.zone}${c.level ? ` ${c.level}` : ''}`;
}

/** "FL020" / "FL115" -> feet; bands ("FL20-150") and anything else null. */
export function parseChartFl(level: string | null): number | null {
	if (!level) {
		return null;
	}
	const m = /^FL(\d{2,3})$/.exec(level.trim());
	return m ? Number(m[1]) * 100 : null;
}

/** Min/max planned altitude over the printed routes' per-leg values; null
 *  when no route has a leg. */
export function altRange(
	legAltsFt: readonly (readonly number[])[],
): { minFt: number; maxFt: number } | null {
	let min = Infinity;
	let max = -Infinity;
	for (const legs of legAltsFt) {
		for (const ft of legs) {
			if (Number.isFinite(ft)) {
				min = Math.min(min, ft);
				max = Math.max(max, ft);
			}
		}
	}
	return max === -Infinity ? null : { minFt: min, maxFt: max };
}

/** Coarse TEMSI / WINTEM EUROC coverage (western + central Europe, per the
 *  Meteo-France Guide Aviation): a flight outside both the French FIRs and
 *  this box gets no chart sheets rather than an irrelevant EUROC set. */
export const EUROC_BBOX = { minLat: 25, minLon: -30, maxLat: 72, maxLon: 45 };

/** The chart zones relevant to the planned routes: FRANCE when any sampled
 *  point sits in the French metropolitan FIRs (or the FIR data is
 *  unavailable: `presence` null, the conservative domestic default), EUROC
 *  added when any point leaves them and the routes touch EUROC coverage. */
export function chartZones(
	presence: { inside: boolean; outside: boolean } | null,
	routesWaypoints: readonly (readonly { lat: number; lon: number }[])[],
): SofiaZone[] {
	if (!presence) {
		return ['FRANCE'];
	}
	const zones: SofiaZone[] = [];
	if (presence.inside || !presence.outside) {
		zones.push('FRANCE');
	}
	if (presence.outside) {
		let minLat = Infinity;
		let minLon = Infinity;
		let maxLat = -Infinity;
		let maxLon = -Infinity;
		for (const wps of routesWaypoints) {
			for (const w of wps) {
				minLat = Math.min(minLat, w.lat);
				maxLat = Math.max(maxLat, w.lat);
				minLon = Math.min(minLon, w.lon);
				maxLon = Math.max(maxLon, w.lon);
			}
		}
		const inEuroc =
			maxLat >= EUROC_BBOX.minLat &&
			minLat <= EUROC_BBOX.maxLat &&
			maxLon >= EUROC_BBOX.minLon &&
			minLon <= EUROC_BBOX.maxLon;
		if (maxLat !== -Infinity && inEuroc) {
			zones.push('EUROC');
		}
	}
	return zones;
}

export interface ChartSelection {
	picks: SofiaChart[];
	notes: TripChartNote[];
}

interface ChartGroup {
	product: SofiaChartProduct;
	zone: string;
	/** Distinct WINTEM level ('FL020', or the band string when the link
	 *  carried no level); '' for TEMSI. */
	levelKey: string;
	levelFt: number | null;
	/** Dated charts, validity ascending. */
	dated: SofiaChart[];
	undated: number;
}

/** Each chart covers half-way to its neighbouring validities (half-open);
 *  at the group's edges the median gap extends the cover, so a 6-hourly
 *  EUROC set keeps 6-hourly edges (3 h nominal for single-chart groups). */
function groupCovers(dated: readonly SofiaChart[]): [number, number][] {
	const v = dated.map((c) => c.validAtMs!);
	const gaps: number[] = [];
	for (let i = 1; i < v.length; i++) {
		gaps.push(v[i] - v[i - 1]);
	}
	const sorted = [...gaps].sort((a, b) => a - b);
	const edge = sorted.length > 0 ? sorted[Math.floor((sorted.length - 1) / 2)] : NOMINAL_STEP_MS;
	return v.map((t, i) => {
		const prev = i > 0 ? v[i] - v[i - 1] : edge;
		const next = i + 1 < v.length ? v[i + 1] - v[i] : edge;
		return [t - prev / 2, t + next / 2];
	});
}

/** Select the catalog charts relevant to the flight: TEMSI = every validity
 *  whose cover intersects the window; WINTEM = per relevant flight level
 *  (the levels bracketing the planned altitude range, per zone), the single
 *  covering validity nearest mid-flight. `altRangeFt` null skips WINTEM
 *  entirely. Returns the picks in print order (TEMSI then WINTEM, FRANCE
 *  before EUROC, level then validity ascending) plus the per-group notes. */
export function selectTripCharts(
	charts: readonly SofiaChart[],
	opts: {
		windowStartMs: number;
		windowEndMs: number;
		altRangeFt: { minFt: number; maxFt: number } | null;
	},
): ChartSelection {
	const groups = new Map<string, ChartGroup>();
	for (const c of charts) {
		const levelKey = c.product === 'WINTEM' ? (c.level ?? '') : '';
		const key = `${c.product}|${c.zone}|${levelKey}`;
		let g = groups.get(key);
		if (!g) {
			g = {
				product: c.product,
				zone: c.zone,
				levelKey,
				levelFt: c.product === 'WINTEM' ? parseChartFl(c.level) : null,
				dated: [],
				undated: 0,
			};
			groups.set(key, g);
		}
		if (c.validAtMs == null) {
			g.undated++;
		} else {
			g.dated.push(c);
		}
	}
	for (const g of groups.values()) {
		g.dated.sort((a, b) => a.validAtMs! - b.validAtMs!);
	}

	// Relevant WINTEM levels, per zone: every level inside the planned range,
	// plus the bracketing level below the min and above the max.
	const relevantByZone = new Map<string, Set<number>>();
	if (opts.altRangeFt) {
		const { minFt, maxFt } = opts.altRangeFt;
		const levelsByZone = new Map<string, number[]>();
		for (const g of groups.values()) {
			if (g.product === 'WINTEM' && g.levelFt != null) {
				const l = levelsByZone.get(g.zone) ?? [];
				if (!l.includes(g.levelFt)) {
					l.push(g.levelFt);
				}
				levelsByZone.set(g.zone, l);
			}
		}
		for (const [zone, levels] of levelsByZone) {
			const rel = new Set<number>();
			let below: number | null = null;
			let above: number | null = null;
			for (const l of levels) {
				if (l >= minFt && l <= maxFt) {
					rel.add(l);
				} else if (l < minFt) {
					below = below == null ? l : Math.max(below, l);
				} else {
					above = above == null ? l : Math.min(above, l);
				}
			}
			if (below != null) {
				rel.add(below);
			}
			if (above != null) {
				rel.add(above);
			}
			relevantByZone.set(zone, rel);
		}
	}

	const picks: SofiaChart[] = [];
	const notes = new Map<string, TripChartNote>();
	const note = (g: ChartGroup, kind: TripChartNote['kind']): void => {
		notes.set(`${g.product}|${g.zone}|${kind}`, { product: g.product, zone: g.zone, kind });
	};
	const windowMid = (opts.windowStartMs + opts.windowEndMs) / 2;
	for (const g of groups.values()) {
		if (g.product === 'WINTEM') {
			if (!opts.altRangeFt) {
				continue;
			}
			if (g.levelFt != null && !relevantByZone.get(g.zone)?.has(g.levelFt)) {
				continue;
			}
		}
		if (g.dated.length === 0) {
			if (g.undated > 0) {
				note(g, 'undated');
			}
			continue;
		}
		const covers = groupCovers(g.dated);
		const covering = g.dated.filter(
			(_, i) => covers[i][0] < opts.windowEndMs && opts.windowStartMs < covers[i][1],
		);
		if (covering.length === 0) {
			if (opts.windowStartMs >= covers[covers.length - 1][1]) {
				note(g, 'not-yet-published');
			}
			continue;
		}
		if (g.product === 'TEMSI') {
			picks.push(...covering);
		} else {
			picks.push(
				covering.reduce((best, c) =>
					Math.abs(c.validAtMs! - windowMid) < Math.abs(best.validAtMs! - windowMid) ? c : best,
				),
			);
		}
	}

	const zoneRank = (z: string): number => (z === 'FRANCE' ? 0 : z === 'EUROC' ? 1 : 2);
	picks.sort(
		(a, b) =>
			(a.product === b.product ? 0 : a.product === 'TEMSI' ? -1 : 1) ||
			zoneRank(a.zone) - zoneRank(b.zone) ||
			a.zone.localeCompare(b.zone) ||
			(parseChartFl(a.level) ?? 9e9) - (parseChartFl(b.level) ?? 9e9) ||
			(a.validAtMs ?? 0) - (b.validAtMs ?? 0),
	);
	return { picks, notes: [...notes.values()] };
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch one chart's PDF bytes through the worker relay: the three query
 *  params of the catalog link, and nothing else, cross the proxy. */
async function downloadChart(
	proxyBase: string,
	chartUrl: string,
	signal?: AbortSignal,
): Promise<ArrayBuffer> {
	const src = new URL(chartUrl);
	const params = new URLSearchParams();
	for (const k of ['login', 'layer', 'echeance']) {
		const v = src.searchParams.get(k);
		if (!v) {
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			throw new Error(`chart link missing ${k}`);
		}
		params.set(k, v);
	}
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const res = await fetch(`${proxyBase}/sofia/chart?${params}`, {
		signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
	});
	if (!res.ok) {
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new Error(`chart download failed: ${res.status}`);
	}
	const buf = await res.arrayBuffer();
	const magic = new Uint8Array(buf.slice(0, 4));
	// %PDF: an expired token answers 200 with an HTML error page.
	if (magic[0] !== 0x25 || magic[1] !== 0x50 || magic[2] !== 0x44 || magic[3] !== 0x46) {
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new Error('chart response is not a PDF');
	}
	return buf;
}

interface ChartRasterizer {
	render(data: ArrayBuffer): Promise<{ pngDataUrl: string; wPx: number; hPx: number }>;
	destroy(): void;
}

/** pdf.js, loaded on demand (the export/pdf.ts dynamic-import pattern) with
 *  ONE shared PDFWorker for the whole pack; each document is destroyed after
 *  its page renders. Every chart rasterizes LANDSCAPE, filling its A4
 *  landscape sheet: the default rotation honours the TEMSI /Rotate 90, and a
 *  portrait source (WINTEM) is turned a further quarter anticlockwise, so
 *  the reader turns the printed page clockwise to read it. */
async function loadRasterizer(): Promise<ChartRasterizer> {
	const [pdfjs, workerUrl] = await Promise.all([
		import('pdfjs-dist'),
		import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
	]);
	pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;
	const worker = new pdfjs.PDFWorker();
	return {
		async render(data) {
			const task = pdfjs.getDocument({ data: new Uint8Array(data), worker });
			try {
				const doc = await task.promise;
				const page = await doc.getPage(1);
				// The page's own rotation applies by default; base tells the
				// natural orientation after it.
				const base = page.getViewport({ scale: 1 });
				const rotation =
					base.width >= base.height ? page.rotate : (page.rotate + 270) % 360;
				const turned = page.getViewport({ scale: 1, rotation });
				const scale = RASTER_LONG_SIDE_PX / Math.max(turned.width, turned.height);
				const viewport = page.getViewport({ scale, rotation });
				const canvas = document.createElement('canvas');
				canvas.width = Math.round(viewport.width);
				canvas.height = Math.round(viewport.height);
				await page.render({ canvas, viewport }).promise;
				return {
					pngDataUrl: canvas.toDataURL('image/png'),
					wPx: canvas.width,
					hPx: canvas.height,
				};
			} finally {
				// Frees the document; the externally owned shared worker survives.
				await task.destroy();
			}
		},
		destroy() {
			worker.destroy();
		},
	};
}

export interface TripChartsInput {
	proxyBase: string;
	/** Per requested zone: the catalog entries, or null when its fetch
	 *  failed (all-null drives catalogError). */
	catalogs: readonly { zone: SofiaZone; charts: SofiaChart[] | null }[];
	windowStartMs: number;
	windowEndMs: number;
	altRangeFt: { minFt: number; maxFt: number } | null;
	/** Stops the download loop between picks and aborts the in-flight
	 *  download; the partial doc is returned (callers discard on cancel). */
	signal?: AbortSignal;
	/** Absolute download progress; `current` is the invariant chart token
	 *  (chartToken) while one is being fetched, null between charts. */
	onProgress?: (done: number, total: number, current: string | null) => void;
}

/** Select, download and rasterize the flight-relevant charts. Never rejects:
 *  a failed chart counts in failedCount, a failed catalog in catalogError,
 *  and the sheets degrade to note lines. */
export async function fetchTripCharts(input: TripChartsInput): Promise<TripChartsDoc> {
	const ok = input.catalogs.filter((c) => c.charts != null);
	const catalogError = input.catalogs.length > 0 && ok.length === 0;
	const { picks, notes } = selectTripCharts(
		ok.flatMap((c) => c.charts!),
		{
			windowStartMs: input.windowStartMs,
			windowEndMs: input.windowEndMs,
			altRangeFt: input.altRangeFt,
		},
	);
	input.onProgress?.(0, picks.length, null);
	const entries: TripChartEntry[] = [];
	let failedCount = 0;
	let raster: ChartRasterizer | null = null;
	try {
		for (const [i, chart] of picks.entries()) {
			if (input.signal?.aborted) {
				break;
			}
			if (i > 0) {
				await pause(DOWNLOAD_PACE_MS);
			}
			input.onProgress?.(i, picks.length, chartToken(chart));
			try {
				const bytes = await downloadChart(input.proxyBase, chart.url, input.signal);
				raster ??= await loadRasterizer();
				entries.push({ chart, ...(await raster.render(bytes)) });
			} catch {
				if (input.signal?.aborted) {
					break; // an aborted download is a cancel, not a failure
				}
				failedCount++;
			}
		}
	} finally {
		raster?.destroy();
	}
	input.onProgress?.(entries.length + failedCount, picks.length, null);
	return { fetchedAtMs: Date.now(), entries, notes, failedCount, catalogError };
}
