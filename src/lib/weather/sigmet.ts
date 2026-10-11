/* SIGMET normalisation and presentation helpers (pure; contract notes in
 * docs/sigmets.md). Two AWC feeds, one shape: the international isigmet
 * records and the US airsigmet records both become `Sigmet`, so the map
 * layer, the Weather tab and the detail panel never branch on the source.
 * Altitudes arrive in FEET (the raw bulletins speak FL, x 100); validity
 * in epoch seconds. Unknown hazard values are styled neutral and NEVER
 * dropped: this is a safety layer, an unrecognised advisory still shows. */

import type { AwcAirsigmet, AwcIsigmet } from './awc';

/** The hazard families with a dedicated style; anything else is 'OTHER'. */
export type SigmetHazard = 'TS' | 'TURB' | 'ICE' | 'MTW' | 'VA' | 'TC' | 'OTHER';

export interface Sigmet {
	/** Stable per record: issuing office | series | validity start | a
	 *  geometry suffix. AWC emits a multi-area bulletin (geom 'AREAS') as
	 *  SEVERAL records sharing office + series + validity (the multi-area
	 *  NOTAM precedent), so the suffix comes from the ring itself rather
	 *  than the array position (stable across refetches and reorders). */
	id: string;
	source: 'intl' | 'us';
	/** FIR indicator (LFFF, FAJA); null for the US feed. */
	fir: string | null;
	firName: string | null;
	hazard: SigmetHazard;
	/** The hazard exactly as served, for display ("CONVECTIVE", "TS"). */
	hazardRaw: string;
	/** SEV / EMBD / FRQ / ISOL / OBSC, a volcano or cyclone name, or null. */
	qualifier: string | null;
	/** Feet (FL x 100); null = surface (base) / unbounded (top). */
	baseFt: number | null;
	topFt: number | null;
	validFromMs: number;
	validToMs: number;
	/** [lat, lon] ring; null when the advisory carries no geometry (a
	 *  FIR-wide SIGMET falls back to the loaded FIR rings downstream). */
	ring: [number, number][] | null;
	/** Movement, degrees true / kt; null when stationary or unstated. */
	dirDeg: number | null;
	spdKt: number | null;
	raw: string;
}

const HAZARDS: readonly SigmetHazard[] = ['TS', 'TURB', 'ICE', 'MTW', 'VA', 'TC'];

/** Live feeds have carried non-numeric values in numeric fields (a
 *  stationary advisory serves its movement as "STNR"); anything not a
 *  finite number becomes null. */
function num(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function hazardFamily(raw: string | null | undefined): SigmetHazard {
	const h = (raw ?? '').toUpperCase();
	// The US feed says CONVECTIVE for its thunderstorm SIGMETs.
	if (h === 'CONVECTIVE') {
		return 'TS';
	}
	return HAZARDS.includes(h as SigmetHazard) ? (h as SigmetHazard) : 'OTHER';
}

function ringOf(coords: { lat: number; lon: number }[] | null | undefined): [number, number][] | null {
	if (!coords) {
		return null;
	}
	// Live feeds have carried non-finite vertices; a single bad point must
	// not crash the polygon draw (Leaflet projects eagerly).
	const pts = coords.filter(
		(c) => Number.isFinite(c?.lat) && Number.isFinite(c?.lon),
	);
	if (pts.length < 3) {
		return null;
	}
	return pts.map((c) => [c.lat, c.lon]);
}

/** The per-record id suffix: the ring's first vertex + size, so the areas
 *  of one bulletin get distinct, refetch-stable ids. */
function ringSuffix(ring: [number, number][] | null): string {
	if (!ring) {
		return 'fir';
	}
	return `${ring[0][0]},${ring[0][1]},${ring.length}`;
}

/** Normalise one international SIGMET. */
export function fromIsigmet(s: AwcIsigmet): Sigmet {
	const ring = ringOf(s.coords);
	return {
		id: `${s.icaoId}|${s.seriesId ?? ''}|${s.validTimeFrom}|${ringSuffix(ring)}`,
		source: 'intl',
		fir: s.firId ? s.firId.toUpperCase().slice(0, 4) : null,
		firName: s.firName ?? null,
		hazard: hazardFamily(s.hazard),
		hazardRaw: (s.hazard ?? 'SIGMET').toUpperCase(),
		qualifier: s.qualifier ? s.qualifier.toUpperCase() : null,
		baseFt: num(s.base),
		topFt: num(s.top),
		validFromMs: s.validTimeFrom * 1000,
		validToMs: s.validTimeTo * 1000,
		ring,
		dirDeg: num(s.dir),
		spdKt: num(s.spd),
		raw: s.rawSigmet ?? '',
	};
}

/** Normalise one US SIGMET (nulls in the altitude pairs = SFC / unbounded). */
export function fromAirsigmet(s: AwcAirsigmet): Sigmet {
	const ring = ringOf(s.coords);
	return {
		id: `${s.icaoId}|${s.seriesId ?? ''}|${s.validTimeFrom}|${ringSuffix(ring)}`,
		source: 'us',
		fir: null,
		firName: null,
		hazard: hazardFamily(s.hazard),
		hazardRaw: (s.hazard ?? 'SIGMET').toUpperCase(),
		qualifier: null,
		baseFt: num(s.altitudeLow1) ?? num(s.altitudeLow2),
		topFt: num(s.altitudeHi1) ?? num(s.altitudeHi2),
		validFromMs: s.validTimeFrom * 1000,
		validToMs: s.validTimeTo * 1000,
		ring,
		dirDeg: num(s.movementDir),
		spdKt: num(s.movementSpd),
		raw: s.rawAirSigmet ?? '',
	};
}

/** Guarantee unique ids across the merged feed list. The ring suffix keeps
 *  one bulletin's areas apart, but the live feed has served TWO records
 *  colliding on office | series | validity | first vertex + size (WIII,
 *  2026-07-05), and a duplicate id crashes every keyed each downstream, so
 *  uniqueness must hold by construction whatever AWC emits. Later
 *  duplicates get #2, #3... in feed order; the first keeps the bare id
 *  (refetch-stable while the feed order holds). */
export function uniqueSigmetIds(list: Sigmet[]): Sigmet[] {
	const seen = new Map<string, number>();
	return list.map((s) => {
		const n = (seen.get(s.id) ?? 0) + 1;
		seen.set(s.id, n);
		return n === 1 ? s : { ...s, id: `${s.id}#${n}` };
	});
}

/** Map stroke / fill hex per hazard family. Fixed hex on purpose: Leaflet
 *  paths cannot read CSS variables (the supaipLayer convention). The
 *  palette is the app's own choice (no official chart standard exists for
 *  web SIGMET polygons); provenance note in docs/sigmets.md. */
// i18n-ignore-start: canonical English labels, FR mirror in $lib/i18n/fr/weather.ts
export const HAZARD_STYLES: Record<SigmetHazard, { color: string; label: string }> = {
	TS: { color: '#D32F2F', label: 'Thunderstorm' },
	TURB: { color: '#EF7D00', label: 'Turbulence' },
	ICE: { color: '#1565C0', label: 'Icing' },
	MTW: { color: '#00695C', label: 'Mountain wave' },
	VA: { color: '#8E24AA', label: 'Volcanic ash' },
	TC: { color: '#AD1457', label: 'Tropical cyclone' },
	OTHER: { color: '#546E7A', label: 'Other' },
};
// i18n-ignore-end

/** "SFC" / "FL240"; the feeds serve feet, the bulletins speak FL. */
function fmtLevel(ft: number | null, missing: string): string {
	if (ft == null) {
		return missing;
	}
	return `FL${String(Math.round(ft / 100)).padStart(3, '0')}`;
}

/** The level-phrase words (t.weather.sigmet); locale-free module
 *  (docs/i18n.md rule 6). */
export interface SigmetWords {
	above: (level: string) => string;
	below: (level: string) => string;
}

/** "SFC-FL480", "FL240-FL300", "below FL280", "above FL240". */
export function fmtSigmetLevels(
	s: Pick<Sigmet, 'baseFt' | 'topFt'>,
	words: SigmetWords,
): string {
	if (s.baseFt == null && s.topFt == null) {
		return '';
	}
	if (s.baseFt == null) {
		return words.below(fmtLevel(s.topFt, ''));
	}
	if (s.topFt == null) {
		return words.above(fmtLevel(s.baseFt, ''));
	}
	return `${fmtLevel(s.baseFt, 'SFC')}-${fmtLevel(s.topFt, '')}`;
}

/** "SEV TURB FL240-FL300", "EMBD TS", "VA ERUPTION SEMERU". */
export function sigmetLabel(s: Sigmet, words: SigmetWords): string {
	const parts: string[] = [];
	if (s.qualifier && s.hazard !== 'VA' && s.hazard !== 'TC') {
		parts.push(s.qualifier);
	}
	parts.push(s.hazardRaw);
	if ((s.hazard === 'VA' || s.hazard === 'TC') && s.qualifier) {
		parts.push(s.qualifier);
	}
	const levels = fmtSigmetLevels(s, words);
	if (levels) {
		parts.push(levels);
	}
	return parts.join(' ');
}

/** Validity overlap with a window (the supaip activation shape). */
export function sigmetActiveDuring(s: Sigmet, from: number, to: number): boolean {
	return s.validFromMs <= to && s.validToMs >= from;
}

/** Vertical overlap with the altitude filter band (ft, the
 *  activeAltitudeBand shape), conservative: a missing base reaches the
 *  surface, a missing top is unbounded. */
export function sigmetInBand(
	s: Sigmet,
	band: { floor: number; ceiling: number } | null,
): boolean {
	if (!band) {
		return true;
	}
	return (s.baseFt ?? 0) <= band.ceiling && (s.topFt ?? Infinity) >= band.floor;
}

/** Approximate ring area in degrees squared (draw-order sorting only). */
export function ringAreaDeg2(ring: [number, number][]): number {
	let sum = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		sum += (ring[j][1] + ring[i][1]) * (ring[j][0] - ring[i][0]);
	}
	return Math.abs(sum / 2);
}
