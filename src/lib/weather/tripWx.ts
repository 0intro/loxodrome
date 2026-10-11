/* Trip-wide weather snapshot for the printed flight dossier: one nearest
 * METAR per aerodrome of the trip chain (the performance page's recipe, a
 * nearestMetar pick over a nearestSearchBbox area query, so the aerodrome's
 * own station wins when it reports), plus each picked station's TAF. Plain
 * async orchestration over the awc fetchers, no session cache: the ensure*
 * records in state/weather.svelte.ts are TTL-gated, display-driven and
 * fire-and-forget, while a print prefetch must always fetch and always
 * settle before the snapshot renders. The caller gates on
 * display.liveWeather. */

import type { TripWxStop } from '$lib/aircraft/aerodromes';
import { fetchMetarsByBbox, fetchTafs, type AwcTaf } from './awc';
import { nearestMetar, nearestSearchBbox, splitRawTaf, type NearestPick } from './metar';

/** The proxy accepts at most this many idents per /wx ids request. */
const IDS_PER_REQUEST = 12;

export interface TripWxEntry {
	/** The trip-chain aerodrome (not necessarily the reporting station). */
	icao: string;
	/** 'error' = the area query failed; 'ok' with pick null = nothing
	 *  reports within 50 NM. */
	status: 'ok' | 'error';
	pick: NearestPick | null;
	/** The picked station's TAF; null when it publishes none or the TAF
	 *  fetch failed. */
	taf: AwcTaf | null;
}

export interface TripWxDoc {
	/** Snapshot time, ms: the sheet's "Retrieved" stamp and age lines. */
	fetchedAtMs: number;
	/** One entry per trip-chain aerodrome, in trip order. */
	entries: TripWxEntry[];
}

/** One nearest-station lookup per stop, all in parallel, in stop order,
 *  then one batched TAF pass over the picked stations. Never rejects: a
 *  failed stop degrades to status 'error', a failed TAF chunk to
 *  taf null. `onProgress` reports each settled stop (the trailing TAF
 *  pass is uncounted); numbers only, locale-free. */
export async function fetchTripWx(
	stops: readonly TripWxStop[],
	onProgress?: (done: number, total: number) => void,
): Promise<TripWxDoc> {
	let settled = 0;
	const entries = await Promise.all(
		stops.map(async (s): Promise<TripWxEntry> => {
			try {
				const metars = await fetchMetarsByBbox(nearestSearchBbox(s.lat, s.lon));
				return { icao: s.icao, status: 'ok', pick: nearestMetar(metars, s.lat, s.lon), taf: null };
			} catch {
				return { icao: s.icao, status: 'error', pick: null, taf: null };
			} finally {
				settled += 1;
				onProgress?.(settled, stops.length);
			}
		}),
	);
	const ids = [...new Set(entries.filter((e) => e.pick).map((e) => e.pick!.metar.icaoId))];
	const chunks: string[][] = [];
	for (let i = 0; i < ids.length; i += IDS_PER_REQUEST) {
		chunks.push(ids.slice(i, i + IDS_PER_REQUEST));
	}
	const tafs = (await Promise.all(chunks.map((c) => fetchTafs(c).catch(() => [])))).flat();
	const tafById = new Map(tafs.map((t) => [t.icaoId, t]));
	for (const e of entries) {
		e.taf = e.pick ? (tafById.get(e.pick.metar.icaoId) ?? null) : null;
	}
	return { fetchedAtMs: Date.now(), entries };
}

/** ~70 monospace characters fit one raw-text line on an A5 card. */
const RAW_CHARS_PER_LINE = 70;
/** Usable line budget of one A5 card (194 mm at ~16 px lines), less the
 *  per-card header. Estimates only; a mild overshoot still fits. */
const PANEL_LINES = 36;

function rawLines(text: string): number {
	return Math.max(1, Math.ceil(text.length / RAW_CHARS_PER_LINE));
}

/** Rough printed line count of one entry (head + raw METAR + age + TAF
 *  block + card chrome), for the packer only. */
function entryLines(e: TripWxEntry): number {
	let n = 3;
	if (e.pick) {
		n += rawLines(e.pick.metar.rawOb);
		if (e.taf) {
			n += 1;
			for (const line of splitRawTaf(e.taf.rawTAF)) {
				n += rawLines(line);
			}
		}
	}
	return n;
}

/** Pack the entries into A5-card panels for the kneeboard print (two
 *  panels side by side per landscape sheet): balanced by estimated height
 *  when everything fits one sheet, else sequential capacity fill. Order
 *  is preserved, so the cards read like the trip. */
export function packWxPanels(entries: readonly TripWxEntry[]): TripWxEntry[][] {
	if (entries.length <= 1) {
		return entries.length === 0 ? [] : [[entries[0]]];
	}
	const lines = entries.map(entryLines);
	const total = lines.reduce((a, b) => a + b, 0);
	if (total <= 2 * PANEL_LINES) {
		let best = 1;
		let bestMax = Infinity;
		let prefix = 0;
		for (let k = 1; k < entries.length; k++) {
			prefix += lines[k - 1];
			const m = Math.max(prefix, total - prefix);
			if (m < bestMax) {
				bestMax = m;
				best = k;
			}
		}
		return [entries.slice(0, best), entries.slice(best)];
	}
	const panels: TripWxEntry[][] = [];
	let panel: TripWxEntry[] = [];
	let sum = 0;
	for (let i = 0; i < entries.length; i++) {
		if (panel.length > 0 && sum + lines[i] > PANEL_LINES) {
			panels.push(panel);
			panel = [];
			sum = 0;
		}
		panel.push(entries[i]);
		sum += lines[i];
	}
	panels.push(panel);
	return panels;
}
