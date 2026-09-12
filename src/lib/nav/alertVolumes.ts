/* One volume shape for the live airspace-alert evaluator, normalised from
 * the three sources it watches: the merged airspace dataset, the SUP AIP
 * zones, and the restriction / warning NOTAMs carrying published geometry.
 * Pure: takes the raw arrays, never reads state, so the evaluator stays
 * deterministic under a replay scrub. The activation model is data-first:
 * each volume states how its hotness is decided (permanent, its own parsed
 * windows, by NOTAM, or unknown), and the caller injects the NOTAM
 * activation windows separately (they live in reactive state). */

import type { Airspace, AirspaceRadio } from '$lib/data/airspaces';
import type { SupAip } from '$lib/data/supaip';
import type { Notam } from '$lib/notam/types';
import type { AirspaceCategory } from '$lib/state/layers.svelte';
import { vExtent, type VExtent, type VLimit } from '$lib/vertical/limits';
import type { Bbox } from '$lib/notam/geometry';
import type { EntryCondition, EntryConditions } from '$lib/data/airspaceEntry';
import { NO_ENTRY, permanentHours } from '$lib/data/airspaceEntry';
import { isRtba } from '$lib/map/airspaceSymbology';
import { firSubjectGroup } from '$lib/notam/qcode';
import {
	entryGeom,
	notamProfileLimits,
	profileRelevantNotam,
} from '$lib/route/notamProfile';

/** One hot interval, epoch ms UTC. */
export interface ActiveWindow {
	startMs: number;
	endMs: number;
}

/** How a volume's hotness is decided.
 *  - permanent: the volume's requirement holds whenever it exists (controlled
 *    airspace, P, H24 zones).
 *  - windows: the data carries the hot intervals (SUP AIP activations, a
 *    NOTAM's own validity).
 *  - notam: hot only through the injected NOTAM activation windows (RTBA,
 *    zones published "activable par NOTAM").
 *  - unknown: a published schedule the dataset carries only as free text
 *    (HX / HJ / timetable strings); the rules grade these as a caution. */
export type VolumeActivity =
	| { kind: 'permanent' }
	| { kind: 'windows'; windows: ActiveWindow[] }
	| { kind: 'notam' }
	| { kind: 'unknown' };

/** Re-exported so the alert modules keep one import for a volume's grading
 *  inputs; the reading itself is shared with the route profile
 *  ($lib/data/airspaceEntry). */
export type { EntryCondition, EntryConditions };

/** SUP AIP grading input: the zone-name token when one exists (ZIT / ZRT /
 *  ZDT), else the supplement's penetration-rule kind. */
export type SupKind =
	| 'zit'
	| 'zrt'
	| 'zdt'
	| 'forbidden'
	| 'conditional'
	| 'circumvent'
	| 'other'
	| '';

export interface AlertVolume {
	/** Unique per volume: the airspace row key, `<supId>#<zoneIndex>`, or the
	 *  NOTAM id. */
	key: string;
	/** Activation join key: the airspace designation `id` (shared by sibling
	 *  rows, which is what the NOTAM activation links are keyed on), the SUP
	 *  zone key, or the NOTAM id. */
	id: string;
	name: string;
	source: 'airspace' | 'supaip' | 'notam';
	rings: [number, number][][];
	circles: { lat: number; lon: number; radiusM: number }[];
	bbox: Bbox;
	vLower: VLimit | null;
	vUpper: VLimit | null;
	/** False when the source states NO vertical extent at all; the
	 *  evaluator then treats the volume as vertically overlapping. */
	knownExtent: boolean;
	/** How much of the extent the source stated. The banner's
	 *  "(vertical extent unknown)" caveat rides this, not knownExtent, so
	 *  a volume with a floor and no ceiling carries it too: the evaluator
	 *  reads that ceiling as unlimited, which the AIP never said. */
	extent: VExtent;
	/** Airspace classification inputs; empty / false for the other sources. */
	type: string;
	airClass: string;
	category: AirspaceCategory | '';
	rtba: boolean;
	/** The zone's published entry conditions per traffic category, the one
	 *  reading the route profile's forbidden-crossing tier shares
	 *  ($lib/data/airspaceEntry); NO_ENTRY for the SUP AIP and NOTAM
	 *  volumes, whose grading inputs are supKind / qSubject. */
	entry: EntryConditions;
	/** Q-code subject of a NOTAM volume ('RP', 'RT', 'WU', ...), '' elsewhere. */
	qSubject: string;
	supKind: SupKind;
	/** The supplement concerns IFR traffic only. */
	supIfrOnly: boolean;
	radios: AirspaceRadio[];
	activity: VolumeActivity;
}

/** Categories that can never alert under any profile (the information tier:
 *  FIR limits and the FIS sectors); skipped at normalisation so the spatial
 *  index stays lean. */
const SILENT_CATEGORIES = new Set<AirspaceCategory>(['fir', 'siv']);

/** Activity resolution for an airspace row. RTBA zones ride their AZBA
 *  activation NOTAMs whatever the published hours string says; restricted /
 *  transit zones follow codeWorkHr (H24 permanent, "by NOTAM" cold until a
 *  NOTAM window, anything else an unparsed schedule); every other category's
 *  requirement holds whenever the volume exists. */
function airspaceActivity(a: Airspace): VolumeActivity {
	if (isRtba(a.id)) {
		return { kind: 'notam' };
	}
	if (a.category === 'restricted' || a.category === 'transit') {
		if (permanentHours(a.workHr)) {
			return { kind: 'permanent' };
		}
		if (a.workHr.toUpperCase().includes('NOTAM')) {
			return { kind: 'notam' };
		}
		return { kind: 'unknown' };
	}
	return { kind: 'permanent' };
}

/** Types whose charted designation is "TYPE NAME" ("P 23", "TMA ROUEN"):
 *  the dataset name column is bare there, and a banner saying "In 23" is
 *  not readable at a glance. Skipped when the name already leads with the
 *  type at a word boundary ("R 1", "W-291", "CTR MELUN"). */
const NAME_PREFIX_TYPES = new Set([
	'R', 'D', 'P', 'TMA', 'CTR', 'CTA', 'ATZ', 'LTA', 'UTA',
	'TMZ', 'RMZ', 'TMZ-RMZ', 'TRA', 'TSA', 'CBA', 'MOA', 'W', 'A', 'ADIZ', 'TFR',
]);

function airspaceLabel(a: Airspace): string {
	if (!NAME_PREFIX_TYPES.has(a.type)) {
		return a.name;
	}
	const lead = new RegExp(`^${a.type.replace('-', '[-]')}\\b`, 'i');
	return lead.test(a.name) ? a.name : `${a.type} ${a.name}`;
}

export function airspaceVolumes(rows: Airspace[]): AlertVolume[] {
	const out: AlertVolume[] = [];
	for (const a of rows) {
		if (SILENT_CATEGORIES.has(a.category) || a.ring.length < 3) {
			continue;
		}
		out.push({
			key: a.key,
			id: a.id,
			name: airspaceLabel(a),
			source: 'airspace',
			rings: [a.ring],
			circles: [],
			bbox: a.bbox,
			vLower: a.vLower,
			vUpper: a.vUpper,
			// A volume with one published limit can be evaluated; the
			// caveat the banner adds is driven by `extent`, not by this.
			knownExtent: vExtent(a.vLower, a.vUpper) !== 'unknown',
			extent: vExtent(a.vLower, a.vUpper),
			type: a.type,
			airClass: a.airClass,
			category: a.category,
			rtba: isRtba(a.id),
			entry: a.entry,
			qSubject: '',
			supKind: '',
			supIfrOnly: false,
			radios: a.radio,
			activity: airspaceActivity(a),
		});
	}
	return out;
}

const DAY_MS = 86_400_000;
/** Ceiling on the per-day window expansion of one zone's activation list;
 *  supplements run weeks, not years, so this is a runaway guard. */
const MAX_WINDOWS = 400;

function dayStartMs(date: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!m) {
		return null;
	}
	return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function timeOfDayMs(t: string | undefined): number | null {
	if (!t) {
		return null;
	}
	const m = /^(\d{2}):(\d{2})$/.exec(t);
	if (!m) {
		return null;
	}
	return (Number(m[1]) * 60 + Number(m[2])) * 60_000;
}

/** Strict per-day reading of a supplement zone's activation list: a
 *  "Du 3 au 7, 0800-1200" yields one window PER DAY, unlike the display
 *  filter's deliberately widening one-block reading (supaip.svelte.ts
 *  activationOverlaps, which may only widen because it hides zones). An
 *  alarm needs the opposite bias: hot means hot now. A slot whose end reads
 *  before its start rolls past midnight, the RTBA window convention. */
export function supActivationWindows(
	activations: { date: string; dateTo?: string; from?: string; to?: string }[],
): ActiveWindow[] {
	const out: ActiveWindow[] = [];
	for (const act of activations) {
		const d0 = dayStartMs(act.date);
		if (d0 == null) {
			continue;
		}
		const d1 = act.dateTo ? (dayStartMs(act.dateTo) ?? d0) : d0;
		const from = timeOfDayMs(act.from) ?? 0;
		const to = timeOfDayMs(act.to) ?? DAY_MS;
		for (let d = d0; d <= d1 && out.length < MAX_WINDOWS; d += DAY_MS) {
			out.push({
				startMs: d + from,
				endMs: to > from ? d + to : d + to + DAY_MS,
			});
		}
	}
	return out;
}

const ZONE_TOKEN_RE = /\b(ZIT|ZRT|ZDT)\b/i;

export function supaipVolumes(sups: SupAip[]): AlertVolume[] {
	const out: AlertVolume[] = [];
	for (const sup of sups) {
		for (let i = 0; i < sup.zones.length; i++) {
			const zone = sup.zones[i];
			const g = zone.geometry;
			if (!g || !zone.bbox) {
				continue;
			}
			const rings =
				g.type === 'polygon' ? [g.ring] : g.type === 'multipolygon' ? g.rings : [];
			const circles =
				g.type === 'circle'
					? [{ lat: g.center[0], lon: g.center[1], radiusM: g.radiusM }]
					: [];
			let activity: VolumeActivity;
			if (zone.activations.length > 0) {
				activity = { kind: 'windows', windows: supActivationWindows(zone.activations) };
			} else {
				const from = sup.validFrom ? dayStartMs(sup.validFrom) : null;
				const to = sup.validTo ? dayStartMs(sup.validTo) : null;
				activity =
					from != null || to != null
						? {
								kind: 'windows',
								windows: [
									{ startMs: from ?? 0, endMs: to != null ? to + DAY_MS : Infinity },
								],
							}
						: { kind: 'unknown' };
			}
			const token = ZONE_TOKEN_RE.exec(zone.name)?.[1]?.toLowerCase() as
				| 'zit'
				| 'zrt'
				| 'zdt'
				| undefined;
			const radios: AirspaceRadio[] = sup.contacts.map((c) => ({
				freq: c.freqs[0] ?? '',
				unit: c.unit,
				call: '',
			}));
			out.push({
				key: `${sup.id}#${i}`,
				id: `${sup.id}#${i}`,
				name: zone.name,
				source: 'supaip',
				rings,
				circles,
				bbox: zone.bbox,
				vLower: zone.vLower,
				vUpper: zone.vUpper,
				knownExtent: vExtent(zone.vLower, zone.vUpper) !== 'unknown',
				extent: vExtent(zone.vLower, zone.vUpper),
				type: '',
				airClass: '',
				category: '',
				rtba: false,
				entry: NO_ENTRY,
				qSubject: '',
				supKind: token ?? sup.penetration?.kind ?? 'other',
				supIfrOnly: sup.ifr && !sup.vfr,
				radios,
				activity,
			});
		}
	}
	return out;
}

/** Restriction / warning NOTAMs with published geometry, one volume per
 *  NOTAM id (a multi-area NOTAM's entries union their geometry, the
 *  profile's merge-by-id contract). Obstacle-family NOTAMs are marks, not
 *  volumes, and the Q-line radius-of-influence circle never qualifies
 *  (profileRelevantNotam's rule; alerting on a 25 NM retrieval hint would
 *  be nuisance by construction). */
export function notamVolumes(notams: Notam[]): AlertVolume[] {
	const groups = new Map<string, Notam[]>();
	for (const n of notams) {
		if (!profileRelevantNotam(n)) {
			continue;
		}
		const family = firSubjectGroup(n.qCode).key;
		if (family !== 'restrictions' && family !== 'warnings') {
			continue;
		}
		const list = groups.get(n.id);
		if (list) {
			list.push(n);
		} else {
			groups.set(n.id, [n]);
		}
	}
	const out: AlertVolume[] = [];
	for (const [id, group] of groups) {
		const g = entryGeom(group.map((notam) => ({ notam })));
		if (g.rings.length === 0 && g.circles.length === 0) {
			continue;
		}
		const first = group[0];
		const limits = notamProfileLimits(first);
		const startMs = first.startDate?.getTime() ?? 0;
		const endMs = first.endDate ? first.endDate.getTime() : Infinity;
		out.push({
			key: id,
			id,
			name: id,
			source: 'notam',
			rings: g.rings,
			circles: g.circles,
			bbox: g.bbox,
			vLower: limits.lower,
			vUpper: limits.upper,
			knownExtent: limits.known,
			extent: limits.known ? 'known' : 'unknown',
			type: '',
			airClass: '',
			category: '',
			rtba: false,
			entry: NO_ENTRY,
			qSubject: first.qCode.length >= 3 ? first.qCode.slice(1, 3) : '',
			supKind: '',
			supIfrOnly: false,
			radios: [],
			activity: first.permanent
				? { kind: 'permanent' }
				: { kind: 'windows', windows: [{ startMs, endMs }] },
		});
	}
	return out;
}
