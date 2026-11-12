/* Fixes from the native Android recorder (NavRecorderService via the
 * NavRecorder plugin; docs/android.md). The service journals and emits each
 * android.location.Location verbatim, in raw units, and this module is the
 * ONE place such a fix becomes a TrackPoint, so the native path and the web
 * watchPosition path stay on the same units and datum: Location.getAltitude()
 * is metres above the WGS84 ellipsoid, exactly what the WebView's
 * coords.altitude carries on Android, so the recorder's existing datum
 * pipeline (traceDatum + ingestFix conversion) applies unchanged.
 *
 * Tolerant on purpose: a fix arrives as parsed JSON from a journal file that
 * survives process kills, so a malformed line must drop, never corrupt the
 * trace. Pure, no Svelte, no I/O (tests/navNativeFix.spec.ts). */

import { MS_PER_KT, type TrackPoint } from './trace';

/** Metres in one foot (Location altitude is metres). */
const M_PER_FT = 0.3048;

/** One raw fix as the native service journals and emits it. */
export interface NativeFix {
	/** Fix time, epoch milliseconds UTC (Location.getTime()). */
	tMs: number;
	lat: number;
	lon: number;
	/** WGS84-ellipsoid altitude, metres; absent when the device omits it. */
	altM?: number;
	/** Reported horizontal accuracy, metres. */
	accM?: number;
	/** Ground speed, m/s. */
	spdMps?: number;
	/** Track over the ground, degrees true. */
	brgDeg?: number;
}

function num(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The TrackPoint of one native fix; null when the essentials are missing or
 *  non-finite. Optional fields map absent -> null, mirroring what the web
 *  path records when the device reports no altitude / speed / heading. */
export function toTrackPoint(raw: unknown): TrackPoint | null {
	if (raw == null || typeof raw !== 'object') {
		return null;
	}
	const f = raw as Record<string, unknown>;
	const tMs = num(f.tMs);
	const lat = num(f.lat);
	const lon = num(f.lon);
	if (tMs == null || lat == null || lon == null) {
		return null;
	}
	const altM = num(f.altM);
	const spdMps = num(f.spdMps);
	return {
		lat,
		lon,
		timeMs: tMs,
		altFt: altM == null ? null : altM / M_PER_FT,
		speedKt: spdMps == null ? null : spdMps / MS_PER_KT,
		trackDeg: num(f.brgDeg),
		accuracyM: num(f.accM),
	};
}

/** The strictly-newer points: timeMs > lastMs, itself strictly ascending.
 *  Live events and journal drains overlap by design (the journal is the
 *  source of truth, the events the low-latency path), so every append goes
 *  through this take, which makes duplicate and out-of-order delivery
 *  harmless. */
export function takeNewer(lastMs: number | null, pts: TrackPoint[]): TrackPoint[] {
	const out: TrackPoint[] = [];
	let floor = lastMs ?? -Infinity;
	for (const p of pts) {
		if (p.timeMs > floor) {
			out.push(p);
			floor = p.timeMs;
		}
	}
	return out;
}
