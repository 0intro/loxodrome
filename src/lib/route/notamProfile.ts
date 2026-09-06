/* NOTAM bands for the route vertical profile: where a NOTAM's own lateral
 * geometry crosses the route TRACK (zero width, the airspace-band convention;
 * the corridor width stays the relevance filter's job, so a NOTAM the
 * corridor filter keeps can legitimately show no band here), a band between
 * its parsed F)/G) limits (OPADD precedence, Q-line fallback) is drawn on the
 * chart, and airspace bands activated by NOTAM get a hatch. Pure and
 * Svelte-free: the reactive halves (visibleNotams(), the
 * activation-representation test, activation links) are $deriveds in
 * RouteProfileModal / the flight-dossier PrintDoc, kept OUT of
 * buildRouteProfileDoc so a NOTAM filter keystroke or the minute tick never
 * re-runs the heavy airspace walks.
 *
 * Accepted trade-offs (docs/route-profile.md): an activation NOTAM whose
 * zones aren't loaded or crossed shows nowhere on the profile (its own
 * geometry is the coarse Q circle, which would paint a misleading
 * full-width band); a grazing tangency can slip between two 1 NM samples,
 * the same class of miss as the documented airspace-sliver caveat. */

import { sampleRoute, type AirspaceSpan } from '$lib/route/airspaces';
import { NO_ENTRY } from '$lib/data/airspaceEntry';
import { spanEdge, type PlacedBand, type PlacedSpan, type TerrainSample } from '$lib/route/routeProfile';
import { firSubjectGroup } from '$lib/notam/qcode';
import { extractObstacleHeights } from '$lib/notam/obstacleHeights';
import { projectPointToRoute } from '$lib/route/minAltitude';
import { radiusToNM } from '$lib/notam/radius';
import {
	bboxesOverlap,
	equirectangularDistanceM,
	M_PER_DEG,
	type Bbox,
} from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import { pointInRing } from '$lib/data/airspaces';
import { exactFt, formatVLimit, type VLimit } from '$lib/vertical/limits';
import { formatActivationWindow, formatZulu } from '$lib/format/datetime';
import { rtbaActiveDuring } from '$lib/notam/rtba';
import type { Notam } from '$lib/notam/types';
import type { Waypoint } from '$lib/state/route.svelte';
import type { IndexedNotam } from '$lib/state/notam.svelte';

/** Q-subject families that belong on a vertical profile: the en-route
 *  hazards a PIB cross-section shows (airspace restrictions QR·, warnings
 *  QW·, obstacles QOB/QOL). Navcom, services, procedures and organisation
 *  are vertical noise here; they stay in the lists and panels. */
const PROFILE_FAMILIES = new Set(['restrictions', 'warnings', 'obstacles']);

/** Surface sentinel for a missing lower limit: F) absent (or Q 000) means
 *  the restriction starts at the surface, and an AGL-datum zero keeps the
 *  drawn lower edge ON the terrain (spanEdge follows the samples). */
const SFC_LIMIT: VLimit = { ft: 0, ref: 'AGL', value: 0, unit: 'ft', sfc: true };

/** The map notamLayer's area orange; the profile band hatch echoes it. */
export const NOTAM_PROFILE_COLOR = '#ff7800';

/** Static half of the inclusion rule (the activation half arrives as a
 *  callback, see computeNotamProfileBands): a profile-relevant NOTAM entry
 *  carries PUBLISHED geometry (a polygon, or a psn circle: the French RAYON
 *  forms and their English siblings) and sits in a profile family. Q-line
 *  circles do NOT qualify: the Q) radius is a radius of influence (OPADD),
 *  a briefing-retrieval hint, not a charted boundary, and a profile band's
 *  enter/leave edges would assert a precision the publication never had
 *  (the map keeps drawing them, in their own distinct dashed style). This
 *  also excludes FIR-wide entries (Q radius 999 / absent), which are
 *  Q-line-only by construction. A radius-less position has no lateral
 *  extent a zero-width track can cross: skipped here (obstacle-family
 *  positions come back as temporary obstacle MARKS instead, see
 *  notamObstacleMarks). */
export function profileRelevantNotam(n: Notam): boolean {
	return PROFILE_FAMILIES.has(firSubjectGroup(n.qCode).key) && hasPublishedGeometry(n);
}

/** Published lateral geometry: a polygon ring or a psn circle. The Q-line
 *  circle deliberately doesn't count (see profileRelevantNotam). */
function hasPublishedGeometry(n: Notam): boolean {
	if (n.isPolygon && n.coordinates.length >= 3) {
		return true;
	}
	return n.coordinates.some(
		(c) => c.type === 'psn' && c.radius != null && c.radiusUnit != null,
	);
}

/** Vertical extent of a NOTAM band, OPADD precedence (mirrors notamBandFt
 *  but keeps datum-aware VLimits so an AGL F)/G) edge can follow the
 *  terrain): the parsed F)/G) pair when either side exists (a missing lower
 *  reads SFC, a missing upper open-topped); else the coarse Q-line FL band
 *  when it carries any finite information (lower > 000 or upper < 999;
 *  000 -> SFC, 999 -> UNL); else unknown extent (the OPADD 000/999 defaults
 *  alone state nothing, so the band draws as the dashed full-height box). */
export function notamProfileLimits(n: Notam): {
	lower: VLimit | null;
	upper: VLimit | null;
	known: boolean;
} {
	if (n.fgLower || n.fgUpper) {
		return { lower: n.fgLower, upper: n.fgUpper, known: true };
	}
	const q = n.qualifier;
	if (q && (q.lower > 0 || q.upper < 999)) {
		const lower: VLimit =
			q.lower > 0
				? { ft: q.lower * 100, ref: 'STD', value: q.lower, unit: 'FL' }
				: SFC_LIMIT;
		const upper: VLimit =
			q.upper < 999
				? { ft: q.upper * 100, ref: 'STD', value: q.upper, unit: 'FL' }
				: { ft: Infinity, ref: 'STD', value: 999, unit: 'FL', unl: true };
		return { lower, upper, known: true };
	}
	return { lower: null, upper: null, known: false };
}

/** One NOTAM reduced to profile-band form; a multi-area NOTAM's entries
 *  (same id) merge into one band whose spans come from the union of their
 *  geometries. */
export interface NotamCorridorBand {
	/** NOTAM id, shared by every merged entry. */
	id: string;
	/** Source index of the FIRST merged entry (the detail-panel target). */
	index: number;
	vLower: VLimit | null;
	vUpper: VLimit | null;
	/** False when neither F)/G) nor a finite Q-line band exists. */
	knownExtent: boolean;
	permanent: boolean;
	estimated: boolean;
	startDate: Date | null;
	endDate: Date | null;
	qCode: string;
	spans: AirspaceSpan[];
}

/** One merged NOTAM's lateral geometry, precompiled for the sample walk
 *  (and reused by the live airspace-alert volume normalisation). */
export interface GroupGeom {
	rings: [number, number][][];
	circles: { lat: number; lon: number; radiusM: number }[];
	bbox: Bbox;
}

export function entryGeom(entries: { notam: Notam }[]): GroupGeom {
	const rings: [number, number][][] = [];
	const circles: { lat: number; lon: number; radiusM: number }[] = [];
	let minLat = Infinity;
	let minLon = Infinity;
	let maxLat = -Infinity;
	let maxLon = -Infinity;
	const grow = (lat: number, lon: number, padM: number): void => {
		const padLat = padM / M_PER_DEG;
		const padLon = padLat / (Math.cos((lat * Math.PI) / 180) || 1);
		if (lat - padLat < minLat) minLat = lat - padLat;
		if (lat + padLat > maxLat) maxLat = lat + padLat;
		if (lon - padLon < minLon) minLon = lon - padLon;
		if (lon + padLon > maxLon) maxLon = lon + padLon;
	};
	for (const { notam } of entries) {
		if (notam.isPolygon && notam.coordinates.length >= 3) {
			// One ring per entry in the data; a multi-area NOTAM can carry
			// several polygon entries, and the union of ALL of them is the
			// band's containment set (the merge-by-id contract).
			rings.push(notam.coordinates.map((c) => [c.lat, c.lon] as [number, number]));
			for (const c of notam.coordinates) {
				grow(c.lat, c.lon, 0);
			}
			continue;
		}
		for (const c of notam.coordinates) {
			// Published psn circles only; the Q-line circle is a radius of
			// influence, not a boundary (profileRelevantNotam's rule).
			if (c.type !== 'psn' || c.radius == null || !c.radiusUnit) {
				continue;
			}
			const radiusM = radiusToNM(c.radius, c.radiusUnit) * NM_TO_METERS;
			circles.push({ lat: c.lat, lon: c.lon, radiusM });
			grow(c.lat, c.lon, radiusM);
		}
	}
	return { rings, circles, bbox: { minLat, minLon, maxLat, maxLon } };
}

export function geomContains(g: GroupGeom, lat: number, lon: number): boolean {
	for (const ring of g.rings) {
		if (pointInRing(lat, lon, ring)) {
			return true;
		}
	}
	for (const c of g.circles) {
		if (equirectangularDistanceM(lat, lon, c.lat, c.lon) <= c.radiusM) {
			return true;
		}
	}
	return false;
}

/** Zero-width track walk of the visible NOTAMs: entries pass the static
 *  relevance rule and the caller's `isActivationRepresented` test (true =
 *  the NOTAM's effect already shows as an activated-airspace hatch, so its
 *  own coarse circle is dropped; injected as a callback to keep this module
 *  Svelte-free), group by id, then one open/close span walk over the shared
 *  route sampler, containment by ANY of the group's geometries. Same span
 *  semantics as computeAirspaceCorridorSpans: lateral re-entry yields
 *  multiple spans, a NOTAM still containing the track at the destination
 *  closes at totalNM. */
export function computeNotamProfileBands(
	waypoints: Waypoint[],
	notams: IndexedNotam[],
	isActivationRepresented: (n: Notam) => boolean,
): NotamCorridorBand[] {
	const samples = sampleRoute(waypoints, 0);
	if (samples.length === 0) {
		return [];
	}
	const totalNM = samples[samples.length - 1].cumNM;

	// Group the qualifying entries by NOTAM id (multi-area = one band).
	const groups = new Map<string, IndexedNotam[]>();
	for (const entry of notams) {
		const n = entry.notam;
		if (!profileRelevantNotam(n) || isActivationRepresented(n)) {
			continue;
		}
		const g = groups.get(n.id);
		if (g) {
			g.push(entry);
		} else {
			groups.set(n.id, [entry]);
		}
	}
	if (groups.size === 0) {
		return [];
	}

	// Route bbox for the pre-cull (plain waypoint extent; the group bbox is
	// already padded by its own radii).
	let minLat = Infinity;
	let minLon = Infinity;
	let maxLat = -Infinity;
	let maxLon = -Infinity;
	for (const w of waypoints) {
		if (w.lat < minLat) minLat = w.lat;
		if (w.lat > maxLat) maxLat = w.lat;
		if (w.lon < minLon) minLon = w.lon;
		if (w.lon > maxLon) maxLon = w.lon;
	}
	const routeBox: Bbox = { minLat, minLon, maxLat, maxLon };

	interface Walker {
		band: NotamCorridorBand;
		geom: GroupGeom;
		openNM: number | null;
	}
	const walkers: Walker[] = [];
	for (const [id, entries] of groups) {
		const geom = entryGeom(entries);
		if (geom.rings.length === 0 && geom.circles.length === 0) {
			continue;
		}
		if (!bboxesOverlap(routeBox, geom.bbox)) {
			continue;
		}
		const first = entries[0].notam;
		const limits = notamProfileLimits(first);
		walkers.push({
			band: {
				id,
				index: entries[0].index,
				vLower: limits.lower,
				vUpper: limits.upper,
				knownExtent: limits.known,
				permanent: first.permanent,
				estimated: first.estimated,
				startDate: first.startDate,
				endDate: first.endDate,
				qCode: first.qCode,
				spans: [],
			},
			geom,
			openNM: null,
		});
	}

	for (const s of samples) {
		for (const w of walkers) {
			const inside = geomContains(w.geom, s.lat, s.lon);
			if (inside && w.openNM == null) {
				w.openNM = s.cumNM;
			} else if (!inside && w.openNM != null) {
				w.band.spans.push({ enterNM: w.openNM, leaveNM: s.cumNM });
				w.openNM = null;
			}
		}
	}
	const out: NotamCorridorBand[] = [];
	for (const w of walkers) {
		if (w.openNM != null) {
			w.band.spans.push({ enterNM: w.openNM, leaveNM: totalNM });
		}
		if (w.band.spans.length > 0) {
			out.push(w.band);
		}
	}
	return out;
}

/** A draw-ready NOTAM band: PlacedBand-compatible (RouteProfile reuses
 *  bandPathD, the label stacking and computeCeilingFt), plus the click
 *  target. Keys carry the `notam:` prefix so the shared highlight
 *  namespace can never collide with an airspace band key. */
export interface PlacedNotamBand extends PlacedBand {
	notamId: string;
	notamIndex: number;
}

/** Map NOTAM corridor bands to draw-ready bands, lowest-floor first. AGL
 *  F)/G) edges follow the terrain via the shared spanEdge; a missing lower
 *  reads SFC (terrain-hugging), a missing / UNL upper draws open-topped;
 *  unknown extents keep the dashed full-height convention. The tooltip is
 *  locale-invariant by decision: the NOTAM id, formatVLimit's SIA
 *  vocabulary and the ICAO validity abbreviations (PERM / EST). */
export function placeNotamBands(
	bands: NotamCorridorBand[],
	terrain: TerrainSample[],
): PlacedNotamBand[] {
	return bands
		.map((b): PlacedNotamBand => {
			const lower = b.knownExtent ? (b.vLower ?? SFC_LIMIT) : null;
			const topOpen = b.knownExtent && (b.vUpper == null || b.vUpper.unl === true);
			let minFt = Infinity;
			let maxFt = topOpen ? Infinity : -Infinity;
			const spans: PlacedSpan[] = b.spans.map((span) => {
				const lowerPts = spanEdge(lower, span, terrain, 0, 'floor');
				const upperPts =
					topOpen || !b.knownExtent ? [] : spanEdge(b.vUpper, span, terrain, 0, 'ceiling');
				let botFt = Infinity;
				for (const p of lowerPts) {
					if (p.altFt < botFt) botFt = p.altFt;
				}
				let topFt = topOpen ? Infinity : -Infinity;
				for (const p of upperPts) {
					if (p.altFt > topFt) topFt = p.altFt;
				}
				if (botFt < minFt) minFt = botFt;
				if (topFt > maxFt) maxFt = topFt;
				return { enterNM: span.enterNM, leaveNM: span.leaveNM, lowerPts, upperPts, botFt, topFt };
			});
			// i18n-ignore-start: NOTAM id + formatVLimit + ICAO abbreviations (PERM, EST), locale-invariant
			const lo = b.knownExtent ? formatVLimit(lower) || 'SFC' : '?';
			const hi = b.knownExtent ? (topOpen ? 'UNL' : formatVLimit(b.vUpper) || '?') : '?';
			const validity = `${formatZulu(b.startDate)} – ${
				b.permanent ? 'PERM' : formatZulu(b.endDate) + (b.estimated ? ' EST' : '')
			}`;
			const tooltip = `NOTAM ${b.id}\n${lo} – ${hi}\n${validity}`;
			// i18n-ignore-end
			return {
				key: `notam:${b.id}`,
				color: NOTAM_PROFILE_COLOR,
				category: 'restricted',
				airClass: '',
				type: '',
				entry: NO_ENTRY,
				// Q subject RP = prohibited area: crossing one is forbidden
				// regardless of flight rules (the forbidden-crossing tier).
				prohibited: b.qCode.slice(1, 3) === 'RP',
				rtba: false,
				lowerFt: lower?.ft ?? 0,
				knownExtent: b.knownExtent,
				extent: b.knownExtent ? 'known' : 'unknown',
				topOpen,
				minFt,
				maxFt,
				label: b.id,
				badge: null,
				badgeKind: null,
				limitsText: `${lo} – ${hi}`,
				tooltip,
				spans,
				notamId: b.id,
				notamIndex: b.index,
			};
		})
		.sort((a, b) => a.lowerFt - b.lowerFt);
}

/** One temporary obstacle from an obstacle NOTAM, placed on the profile
 *  like the permanent dataset marks. */
export interface NotamObstacleMark {
	notamId: string;
	/** Source index of the entry (the detail-panel click target). */
	index: number;
	distNM: number;
	offsetNM: number;
	/** Resolved obstacle top, ft AMSL. */
	topFt: number;
	/** Stem base (top - stated height), null when no height was stated. */
	baseFt: number | null;
	/** Stated height (ft AGL), null when the text gives none. */
	hgtFt: number | null;
}

/** Obstacle NOTAMs (QOB/QOL) that carry only bare positions render as
 *  temporary obstacle MARKS, not bands: a crane or new turbine is a point
 *  feature, and the commit's obstacle glyph is its honest shape (entries
 *  with published polygons / circles keep banding like any family). Each
 *  psn coordinate within the corridor half-width (the min-alt width, the
 *  permanent marks' convention) projects onto the route; the top resolves
 *  by precedence: an explicit stated top elevation ("ALT AU SOMMET",
 *  "TOP ELEV"), else the G) item against the local ground (obstacle
 *  NOTAMs' G is the rounded-up top), else ground + stated height
 *  ("HAUTEUR", "HEIGHT", "... FT AGL"); nothing resolvable is skipped, the
 *  honest degradation (the NOTAM stays in every list). `groundFtAt` is the
 *  caller's profile-terrain lookup; heights apply the NOTAM's tallest
 *  stated figures to every position (conservative for multi-machine wind
 *  farms). Pure. */
export function notamObstacleMarks(
	pts: { lat: number; lon: number }[],
	cumNM: number[],
	notams: IndexedNotam[],
	halfWidthNM: number,
	groundFtAt: (distNM: number) => number,
): NotamObstacleMark[] {
	const out: NotamObstacleMark[] = [];
	for (const { notam: n, index } of notams) {
		if (firSubjectGroup(n.qCode).key !== 'obstacles' || hasPublishedGeometry(n)) {
			continue;
		}
		const psns = n.coordinates.filter((c) => c.type === 'psn');
		if (psns.length === 0) {
			continue;
		}
		const heights = extractObstacleHeights(n.fullContent);
		for (const c of psns) {
			const proj = projectPointToRoute(pts, cumNM, c.lat, c.lon, halfWidthNM);
			if (!proj) {
				continue;
			}
			const ground = groundFtAt(proj.distNM);
			const topFt =
				heights.topFt ??
				(n.fgUpper ? exactFt(n.fgUpper, ground) : null) ??
				(heights.hgtFt != null ? ground + heights.hgtFt : null);
			if (topFt == null) {
				continue;
			}
			out.push({
				notamId: n.id,
				index,
				distNM: proj.distNM,
				offsetNM: proj.offsetNM,
				topFt,
				baseFt: heights.hgtFt != null ? topFt - heights.hgtFt : null,
				hgtFt: heights.hgtFt,
			});
		}
	}
	out.sort((a, b) => a.distNM - b.distNM);
	return out;
}

/** Activation-hatch tooltip data for ONE activated airspace band: the
 *  activating NOTAM ids plus, for RTBA activations, the zone's own windows
 *  inside the evaluation window (formatActivationWindow strings, the
 *  AirspaceDetail convention). The caller (modal / PrintDoc) supplies the
 *  links map entry and the activeEvalWindow bounds and words the sentence. */
export function bandActivationInfo(
	airspaceId: string,
	links: IndexedNotam[],
	fromMs: number,
	toMs: number,
): { notamIds: string[]; windows: string[] } {
	const notamIds: string[] = [];
	const windows: string[] = [];
	for (const { notam } of links) {
		if (!notamIds.includes(notam.id)) {
			notamIds.push(notam.id);
		}
		for (const z of rtbaActiveDuring(notam, fromMs, toMs)) {
			if (z.airspaceId === airspaceId) {
				windows.push(formatActivationWindow(z.start, z.end));
			}
		}
	}
	return { notamIds, windows };
}
