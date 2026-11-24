/* The supplements' zones on the route profile: each zone a band keyed
 * `sup:<supId>#<zone>`, crossing the route where its lateral limits hold
 * it, between its own vertical limits, drawn in the supplement's magenta.
 * The volumes are the alerts' (nav/alertVolumes.ts supaipVolumes), so a
 * zone's geometry, limits and published rule read once for both. A zone an
 * exclusion sector cuts draws whole: the sectors cut it in the alerts.
 *
 * Its entry reads as the alerts grade it (nav/alertRules.ts
 * classifySupaip): a ZIT or a rule of avoidance or prohibition forbids
 * entry while the zone is active, a ZRT or a rule on conditions asks for
 * the clearance, a ZDT informs, and a supplement for IFR traffic alone
 * exempts a VFR flight. Pure. */

import { NO_ENTRY, type EntryConditions } from '$lib/data/airspaceEntry';
import type { AlertVolume } from '$lib/nav/alertVolumes';
import { equirectangularDistanceM } from '$lib/notam/geometry';
import { pointInRing } from '$lib/data/airspaces';
import { formatVLimit, vExtent, type VLimit } from '$lib/vertical/limits';
import { sampleCeilingFt, type TerrainSample } from '$lib/map/terrain';
import type { Waypoint } from '$lib/state/route.svelte';
import { routeLegs, sampleRoute, stretchesBetweenSamples, type AirspaceSpan } from './airspaces';
import { spanEdge, spanGroundRead, type PlacedBand, type PlacedSpan } from './routeProfile';

/** The supplement's magenta: mirrors `--supaip` (theme.css) and the map's
 *  overlay (map/supaipLayer.ts). */
export const SUP_PROFILE_COLOR = '#c2185b';

const SFC_LIMIT: VLimit = { ft: 0, ref: 'AGL', value: 0, unit: 'ft', sfc: true };

/** One supplement zone the route crosses. */
export interface SupCorridorBand {
	key: string;
	supId: string;
	zoneIndex: number;
	name: string;
	vLower: VLimit | null;
	vUpper: VLimit | null;
	knownExtent: boolean;
	volume: AlertVolume;
	spans: AirspaceSpan[];
}

function contains(v: AlertVolume, lat: number, lon: number): boolean {
	return (
		v.rings.some((r) => pointInRing(lat, lon, r)) ||
		v.circles.some((c) => equirectangularDistanceM(lat, lon, c.lat, c.lon) <= c.radiusM)
	);
}

/** The volumes the route crosses, each with the spans it crosses it over:
 *  lateral re-entry yields several, and a volume still holding the route at
 *  the destination closes there. The supplements' zones and the raptor
 *  zones (route/zsmProfile.ts) walk alike. */
export function volumeSpans(
	waypoints: Waypoint[],
	volumes: readonly AlertVolume[],
): { volume: AlertVolume; spans: AirspaceSpan[] }[] {
	const samples = sampleRoute(waypoints, 0);
	if (samples.length === 0 || volumes.length === 0) {
		return [];
	}
	const totalNM = samples[samples.length - 1].cumNM;
	let minLat = Infinity;
	let minLon = Infinity;
	let maxLat = -Infinity;
	let maxLon = -Infinity;
	for (const w of waypoints) {
		minLat = Math.min(minLat, w.lat);
		maxLat = Math.max(maxLat, w.lat);
		minLon = Math.min(minLon, w.lon);
		maxLon = Math.max(maxLon, w.lon);
	}
	const walkers = volumes
		.filter((v) => v.bbox.maxLat >= minLat && v.bbox.minLat <= maxLat && v.bbox.maxLon >= minLon && v.bbox.minLon <= maxLon)
		.map((volume) => ({ volume, spans: [] as AirspaceSpan[], openNM: null as number | null }));
	for (const s of samples) {
		for (const w of walkers) {
			const inside = contains(w.volume, s.lat, s.lon);
			if (inside && w.openNM === null) {
				w.openNM = s.cumNM;
			} else if (!inside && w.openNM !== null) {
				w.spans.push({ enterNM: w.openNM, leaveNM: s.cumNM });
				w.openNM = null;
			}
		}
	}
	const legs = routeLegs(waypoints);
	const out: { volume: AlertVolume; spans: AirspaceSpan[] }[] = [];
	for (const w of walkers) {
		if (w.openNM !== null) {
			w.spans.push({ enterNM: w.openNM, leaveNM: totalNM });
		}
		const v = w.volume;
		for (const st of stretchesBetweenSamples(legs, samples, v, (lat, lon) => contains(v, lat, lon))) {
			w.spans.push({ enterNM: st.enterNM, leaveNM: st.leaveNM });
		}
		if (w.spans.length > 0) {
			w.spans.sort((x, y) => x.enterNM - y.enterNM);
			out.push({ volume: v, spans: w.spans });
		}
	}
	return out;
}

/** The zones of `volumes` (supaipVolumes) the route crosses, with the
 *  spans it crosses them over (volumeSpans). */
export function computeSupProfileBands(waypoints: Waypoint[], volumes: AlertVolume[]): SupCorridorBand[] {
	return volumeSpans(waypoints, volumes).map(({ volume: v, spans }) => {
		const hash = v.id.lastIndexOf('#');
		return {
			key: `sup:${v.id}`,
			supId: v.id.slice(0, hash),
			zoneIndex: Number(v.id.slice(hash + 1)),
			name: v.name,
			vLower: v.vLower,
			vUpper: v.vUpper,
			knownExtent: v.knownExtent,
			volume: v,
			spans,
		};
	});
}

/** The supplement zone a band key names (`sup:<supId>#<zone>`), or null. */
export function supBandRef(key: string): { supId: string; zoneIndex: number } | null {
	if (!key.startsWith('sup:')) {
		return null;
	}
	const ref = key.slice('sup:'.length);
	const hash = ref.lastIndexOf('#');
	return hash > 0 ? { supId: ref.slice(0, hash), zoneIndex: Number(ref.slice(hash + 1)) } : null;
}

/** A draw-ready supplement band: a PlacedBand, its panel's target, and
 *  its limits, which the profile's level band reads. */
export interface PlacedSupBand extends PlacedBand {
	supId: string;
	zoneIndex: number;
	vLower: VLimit | null;
	vUpper: VLimit | null;
}

/** The type a zone grades as and the entry its rule states. */
function grading(v: AlertVolume): { type: string; entry: EntryConditions } {
	const both = (c: 'forbidden' | 'clearance'): EntryConditions => ({
		vfr: v.supIfrOnly ? 'exempt' : c,
		ifr: c,
		permanent: false,
	});
	if (v.supKind === 'zdt') {
		return { type: 'D', entry: NO_ENTRY };
	}
	if (v.supKind === 'zit' || v.supRule === 'forbidden' || v.supRule === 'circumvent') {
		return { type: 'R', entry: both('forbidden') };
	}
	if (v.supKind === 'zrt' || v.supRule === 'conditional') {
		return { type: 'R', entry: both('clearance') };
	}
	return { type: 'D', entry: NO_ENTRY };
}

/** A volume's spans placed on the terrain between its limits, as a NOTAM
 *  band's are (notamProfile.ts placeNotamBands): an AGL limit follows the
 *  terrain, a missing floor draws from the surface, a missing or UNL top
 *  draws open. Its floor's face value and its drawn bounds come with them. */
export function placeVolumeSpans(
	b: { vLower: VLimit | null; vUpper: VLimit | null; knownExtent: boolean; spans: readonly AirspaceSpan[] },
	terrain: TerrainSample[],
): { spans: PlacedSpan[]; lowerFt: number; topOpen: boolean; minFt: number; maxFt: number } {
	const lower = b.knownExtent ? (b.vLower ?? SFC_LIMIT) : null;
	const topOpen = b.knownExtent && (b.vUpper == null || b.vUpper.unl === true);
	const aglTop = b.knownExtent && !topOpen && b.vUpper?.ref === 'AGL';
	let minFt = Infinity;
	let maxFt = topOpen ? Infinity : -Infinity;
	const spans: PlacedSpan[] = b.spans.map((span) => {
		const lowerPts = spanEdge(lower, span, terrain, 0, 'floor');
		const upperPts = topOpen || !b.knownExtent ? [] : spanEdge(b.vUpper, span, terrain, 0, 'ceiling');
		let botFt = Infinity;
		for (const p of lowerPts) {
			botFt = Math.min(botFt, p.altFt);
		}
		let topFt = topOpen ? Infinity : -Infinity;
		for (const p of upperPts) {
			topFt = Math.max(topFt, p.altFt);
		}
		minFt = Math.min(minFt, botFt);
		maxFt = Math.max(maxFt, topFt);
		const ceilingUnknown = aglTop && !spanGroundRead(span, terrain, sampleCeilingFt);
		return { enterNM: span.enterNM, leaveNM: span.leaveNM, lowerPts, upperPts, botFt, topFt, ceilingUnknown };
	});
	return { spans, lowerFt: lower?.ft ?? 0, topOpen, minFt, maxFt };
}

/** Supplement bands as draw-ready bands, lowest floor first, their edges
 *  placed by placeVolumeSpans. The tooltip is locale-invariant: the
 *  supplement's number, the zone's name and formatVLimit's vocabulary. */
export function placeSupBands(bands: SupCorridorBand[], terrain: TerrainSample[], titles: ReadonlyMap<string, string>): PlacedSupBand[] {
	return bands
		.map((b): PlacedSupBand => {
			const placed = placeVolumeSpans(b, terrain);
			const { type, entry } = grading(b.volume);
			// i18n-ignore-start: the supplement's number, the zone's name and formatVLimit, locale-invariant
			const lo = formatVLimit(b.vLower) || '?';
			const hi = formatVLimit(b.vUpper) || '?';
			const title = titles.get(b.supId) ?? '';
			const tooltip = `SUP AIP ${title}\n${b.name}\n${lo} – ${hi}`;
			// i18n-ignore-end
			return {
				key: b.key,
				color: SUP_PROFILE_COLOR,
				category: 'restricted',
				airClass: '',
				type,
				entry,
				prohibited: false,
				rtba: false,
				activity: 'activable',
				lowerFt: placed.lowerFt,
				knownExtent: b.knownExtent,
				extent: vExtent(b.vLower, b.vUpper),
				topOpen: placed.topOpen,
				minFt: placed.minFt,
				maxFt: placed.maxFt,
				// The zone's own name carries its kind ("ZRT 'BLOIS'"), which
				// a badge would repeat.
				label: b.name,
				badge: null,
				badgeKind: null,
				limitsText: `${lo} – ${hi}`,
				tooltip,
				spans: placed.spans,
				supId: b.supId,
				zoneIndex: b.zoneIndex,
				vLower: b.vLower,
				vUpper: b.vUpper,
			};
		})
		.sort((a, b) => a.lowerFt - b.lowerFt);
}
