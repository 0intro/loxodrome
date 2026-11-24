/* One volume shape for the live airspace-alert evaluator, normalised from
 * the three sources it watches: the merged airspace dataset, the SUP AIP
 * zones, and the restriction / warning NOTAMs carrying published geometry.
 * Pure: takes the raw arrays, never reads state, so the evaluator stays
 * deterministic under a replay scrub. The activation model is data-first:
 * each volume states its activity as rules (data/activity.ts: at all times,
 * its own parsed periods, by NOTAM, or unread), and the caller injects the
 * NOTAM activation periods separately (they live in reactive state). */

import { isFlightPlanBuffer, type Airspace, type AirspaceRadio } from '$lib/data/airspaces';
import { linksActivations, type Publisher } from '$lib/data/publishers';
import { designatorKey, usSuaCitable } from '$lib/notam/airspaceIds';
import { rulePeriods, type ActivePeriod, type ActivityRule, type ZoneActivity } from '$lib/data/activity';
import {
	boxSun,
	supZoneSun,
	validityEmpty,
	zoneSchedule,
	type SupAip,
	type SupAipActivation,
	type SupAipExclusion,
	type SupAipGeometry,
	type SupAipPenetration,
	type SupAipZone,
} from '$lib/data/supaip';
import { notamItemD, type SunLookup } from '$lib/notam/schedule';
import type { Notam } from '$lib/notam/types';
import type { AirspaceCategory } from '$lib/state/layers.svelte';
import { fromTriple, vExtent, type VExtent, type VLimit } from '$lib/vertical/limits';
import { zsmRules, type Zsm } from '$lib/data/zsm';
import type { Bbox } from '$lib/notam/geometry';
import type { EntryCondition, EntryConditions } from '$lib/data/airspaceEntry';
import { airspaceActivityKind, NO_ENTRY, type AirspaceActivityKind } from '$lib/data/airspaceEntry';
import { aixmActivityRules } from '$lib/data/aixmActivity';
import { zoneHoursRules } from '$lib/data/zoneHours';
import { isRtba } from '$lib/map/airspaceSymbology';
import { knownFrom, type KnownUnit } from '$lib/data/knownFrom';
import { formatFreqMHz } from '$lib/format/radio';
import { areaMode } from '$lib/notam/areaActivity';
import { notamEText } from '$lib/notam/sections';
import { firSubjectGroup } from '$lib/notam/qcode';
import {
	entryGeom,
	notamProfileLimits,
	profileRelevantNotam,
} from '$lib/route/notamProfile';

/** Re-exported so the alert modules keep one import for a volume's grading
 *  inputs; the reading itself is shared with the route profile
 *  ($lib/data/airspaceEntry). */
export type { EntryCondition, EntryConditions };

/** SUP AIP grading input: the zone-name token (ZIT / ZRT / ZDT), '' when
 *  the name carries none. */
export type SupKind = 'zit' | 'zrt' | 'zdt' | '';

/** SUP AIP grading input: the supplement's penetration rule kind, '' when
 *  none was read. */
export type SupRule = SupAipPenetration['kind'] | '';

export interface AlertVolume {
	/** Unique per volume: the airspace row key, `<supId>#<zoneIndex>`, or the
	 *  NOTAM id. */
	key: string;
	/** Activation join key: the airspace designation `id` (shared by sibling
	 *  rows, which is what the NOTAM activation links are keyed on), the SUP
	 *  zone key, or the NOTAM id. */
	id: string;
	name: string;
	source: 'airspace' | 'supaip' | 'notam' | 'zsm';
	/** Who published the zone, null for a NOTAM's own area: whether a
	 *  briefing silent on it is silent for a reason (volumeLinksActivations). */
	publisher: Publisher | null;
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
	 *  volumes, whose grading inputs are supKind / supRule / qSubject. */
	entry: EntryConditions;
	/** Q-code subject of a NOTAM volume ('RP', 'RT', 'WU', ...), '' elsewhere. */
	qSubject: string;
	supKind: SupKind;
	supRule: SupRule;
	/** The supplement concerns IFR traffic only. */
	supIfrOnly: boolean;
	radios: AirspaceRadio[];
	/** Who its publication names as knowing its real activity
	 *  (data/knownFrom.ts): an airspace's remark and hours, a supplement's
	 *  contacts, a NOTAM's E) item. */
	knownFrom: KnownUnit[];
	/** How its activity is decided: a rule holding at all times (controlled
	 *  airspace, P, H24 zones), the periods the data carries (SUP AIP
	 *  activations, a NOTAM's own validity), activation by NOTAM alone (the
	 *  RTBA, zones published "activable par NOTAM"), or a schedule the
	 *  dataset carries only as free text, unread. */
	activity: ZoneActivity;
	/** The pieces the volume alerts by where sectors cut it (a SUP zone's
	 *  exclusions, supaipVolumes): the volume alerts as its most severe
	 *  piece. Absent for a whole volume. */
	pieces?: AlertVolume[] | undefined;
	/** A piece's cuts: the sectors taken out of its footprint while they
	 *  hold, and the sector it is confined to. */
	holes?: VolumeCut[] | undefined;
	within?: VolumeCut | undefined;
	/** A piece's band where a sector cuts it: from the higher of vLower and
	 *  cutFloor (the sector's top) to the lower of vUpper and cutCeiling
	 *  (the sector's floor). */
	cutFloor?: VLimit | undefined;
	cutCeiling?: VLimit | undefined;
}

/** A sector cutting a volume piece: its footprint, and the periods it holds
 *  in, null for always. */
export interface VolumeCut {
	rings: [number, number][][];
	circles: { lat: number; lon: number; radiusM: number }[];
	windows: ActivePeriod[] | null;
}

/** Categories that can never alert under any profile (the information tier:
 *  FIR limits and the FIS sectors); skipped at normalisation so the spatial
 *  index stays lean. */
const SILENT_CATEGORIES = new Set<AirspaceCategory>(['fir', 'siv']);

/** The rules of each way an airspace row's activity is known. */
const KIND_RULES: Record<AirspaceActivityKind, readonly ActivityRule[]> = {
	permanent: [{ mode: 'firm' }],
	activable: [{ mode: 'activable' }],
	notam: [{ mode: 'notam' }],
	unknown: [{ mode: 'unread' }],
};

/** A standing rule: may be active at all times, how being unread. */
const MAY_BE_ACTIVE: ActivityRule = { mode: 'unread' };

/** Activity resolution for an airspace row: a French restricted or transit
 *  zone's published hours (data/zoneHours.ts), a UK restricted zone's and a
 *  German R or D zone's AIXM status lines (data/aixmActivity.ts), each with
 *  the sun at its box for their sun ends; any other row's way its activity
 *  is known (data/airspaceEntry.ts airspaceActivityKind, which the route
 *  profile reads too). A "by NOTAM" zone is inactive until a NOTAM confirms
 *  it. AIP Germany ENR 5.1 is unread here, so a German zone is active in the
 *  timetable the DFS states and may be active outside it, never inactive. */
function airspaceActivity(a: Airspace): ZoneActivity {
	if (a.source === 'fr' && (a.category === 'restricted' || a.category === 'transit')) {
		return { rules: zoneHoursRules(a.workHr, a.rmkWorkHr, isRtba(a.id)), sun: boxSun(a.bbox) };
	}
	const german = a.source === 'de' && (a.type === 'R' || a.type === 'D');
	const aixm = a.category === 'restricted' && (a.source === 'uk' || german) ? aixmActivityRules(a.rmkWorkHr) : null;
	if (aixm) {
		return { rules: german ? [...aixm, MAY_BE_ACTIVE] : aixm, sun: boxSun(a.bbox) };
	}
	return { rules: KIND_RULES[airspaceActivityKind(a)] };
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

/** Whether a briefing silent on this zone is silent for a reason: the app
 *  links its publisher's activation NOTAMs (data/publishers.ts
 *  linksActivations) and can reach this zone from them. France's grammar
 *  reads its own designators, sub-zones and RTBA, the FAA's its special-use
 *  designators and MOAs (usSuaCitable). Elsewhere the join reads numbered
 *  designators (state/notamLinks.svelte.ts), so a zone named otherwise
 *  ("EDRPEENEMU", the UK's "MTA EAST ANGLIAN" filed as EGVMIL001) may be
 *  active under any briefing. */
export function volumeLinksActivations(v: Pick<AlertVolume, 'publisher' | 'id'>): boolean {
	if (v.publisher === null || !linksActivations(v.publisher)) {
		return false;
	}
	if (v.publisher === 'faa') {
		return usSuaCitable(v.id);
	}
	return v.publisher === 'fr' || designatorKey(v.id) !== null;
}

/** The raptor zones (data/zsm.ts) as volumes: from the surface to the
 *  height to overfly each at, active by the file's flag through its
 *  species' season. AIP France ENR 5.6-1 recommends, so the rules grade one
 *  a caution at most (alertRules.ts). */
export function zsmVolumes(zones: readonly Zsm[]): AlertVolume[] {
	const vLower = fromTriple(['SFC', '', '']);
	return zones.map((z) => {
		const vUpper = fromTriple(['ALT', String(z.overflyM), 'M']);
		return {
			key: z.id,
			id: z.id,
			// i18n-ignore: ZSM is the zone's abbreviation in both languages, as a designator
			name: `ZSM ${z.name}`,
			source: 'zsm',
			publisher: 'fr',
			rings: [z.ring],
			circles: [],
			bbox: z.bbox,
			vLower,
			vUpper,
			knownExtent: true,
			extent: vExtent(vLower, vUpper),
			type: 'ZSM',
			airClass: '',
			category: '',
			rtba: false,
			entry: NO_ENTRY,
			qSubject: '',
			supKind: '',
			supRule: '',
			supIfrOnly: false,
			radios: [],
			knownFrom: [],
			activity: { rules: zsmRules(z) },
		};
	});
}

export function airspaceVolumes(rows: Airspace[]): AlertVolume[] {
	const out: AlertVolume[] = [];
	for (const a of rows) {
		if (SILENT_CATEGORIES.has(a.category) || isFlightPlanBuffer(a) || a.ring.length < 3) {
			continue;
		}
		out.push({
			key: a.key,
			id: a.id,
			name: airspaceLabel(a),
			source: 'airspace',
			publisher: a.source,
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
			supRule: '',
			supIfrOnly: false,
			radios: a.radio,
			knownFrom: knownFrom(`${a.rmk}\n${a.rmkWorkHr}`),
			activity: airspaceActivity(a),
		});
	}
	return out;
}

const DAY_MS = 86_400_000;

function dayStartMs(date: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!m) {
		return null;
	}
	return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Strict per-day reading of a supplement zone's activation list
 *  (data/activity.ts rulePeriods): a "Du 3 au 7, 0800-1200" yields one
 *  window PER DAY, unlike the display filter's deliberately widening
 *  one-block reading (supaip.svelte.ts activationOverlaps, which may only
 *  widen because it hides zones). An alarm needs the opposite bias: hot
 *  means hot now. A range with no hours is hot from its first day's start
 *  to its last day's end, one window however long it runs: 055/2026 holds
 *  96 zones hot from 16 April 2026 to 12 April 2028. */
export function supActivationWindows(activations: SupAipActivation[], sun?: SunLookup): ActivePeriod[] {
	return activations.flatMap((a) => rulePeriods({ ...a, mode: 'firm' }, -Infinity, Infinity, sun));
}

/** A zone's standing rules, each held over the days of its supplement's
 *  validity, whole as a schedule's are (zoneSchedule): 191/2025's "ZRT
 *  activable par NOTAM avec un préavis minimum de 48 heures : 2030-0530"
 *  holds each night from 20 November 2025 to the morning of 1 January
 *  2027. A validity ending before it begins holds none. */
export function zoneStanding(sup: SupAip, zone: SupAipZone): ActivityRule[] {
	if (zone.standing.length === 0 || validityEmpty(sup)) {
		return [];
	}
	const { validFrom, validTo } = sup;
	return zone.standing.map((st): ActivityRule => {
		const r: ActivityRule = { ...st, mode: st.mode ?? 'firm' };
		if (validFrom && validTo) {
			r.date = validFrom;
			r.dateTo = validTo;
		} else if (validTo) {
			r.dateTo = validTo;
		} else if (validFrom) {
			r.startMs = dayStartMs(validFrom) ?? undefined;
		}
		return r;
	});
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
			const { rings, circles } = shapeOf(g);
			const schedule = zoneSchedule(sup, zone);
			const standing = zoneStanding(sup, zone);
			let activity: ZoneActivity;
			if (schedule || standing.length > 0) {
				activity = {
					rules: [...(schedule ?? []).map((a): ActivityRule => ({ ...a, mode: a.mode ?? 'firm' })), ...standing],
					sun: supZoneSun(sup, zone),
				};
			} else if (validityEmpty(sup)) {
				activity = { rules: [] };
			} else {
				const from = sup.validFrom ? dayStartMs(sup.validFrom) : null;
				const to = sup.validTo ? dayStartMs(sup.validTo) : null;
				activity =
					from != null || to != null
						? {
								rules: [
									{ mode: 'firm', startMs: from ?? 0, endMs: to != null ? to + DAY_MS : Infinity },
								],
							}
						: { rules: [{ mode: 'unread' }] };
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
			const vol: AlertVolume = {
				key: `${sup.id}#${i}`,
				id: `${sup.id}#${i}`,
				name: zone.name,
				source: 'supaip',
				publisher: sup.region === 'es' ? 'es' : sup.region === 'be' ? 'be' : 'fr',
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
				supKind: token ?? '',
				supRule: sup.penetration?.kind ?? '',
				supIfrOnly: sup.ifr && !sup.vfr,
				radios,
				knownFrom: supKnownFrom(sup),
				activity,
			};
			if (zone.exclusions.length > 0) {
				vol.pieces = exclusionPieces(vol, zone);
			}
			out.push(vol);
		}
	}
	return out;
}

function shapeOf(g: SupAipGeometry): Pick<VolumeCut, 'rings' | 'circles'> {
	return {
		rings: g.type === 'polygon' ? [g.ring] : g.type === 'multipolygon' ? g.rings : [],
		circles: g.type === 'circle' ? [{ lat: g.center[0], lon: g.center[1], radiusM: g.radiusM }] : [],
	};
}

/** The pieces of a SUP zone its exclusion sectors cut: the zone with its
 *  sectors taken out while they hold, and each sector's footprint with the
 *  band the zone keeps there, above the sector, and below it where the
 *  sector's floor is above the surface. Where two sectors overlap, each
 *  piece keeps its own band, the side that alerts. */
function exclusionPieces(v: AlertVolume, zone: SupAipZone): AlertVolume[] {
	const cuts = zone.exclusions.map((e) => exclusionCut(e, v.activity, zone));
	const pieces: AlertVolume[] = [{ ...v, holes: cuts }];
	zone.exclusions.forEach((e, k) => {
		pieces.push({ ...v, within: cuts[k], cutFloor: e.vUpper ?? undefined });
		if (e.vLower && !e.vLower.sfc) {
			pieces.push({ ...v, within: cuts[k], cutCeiling: e.vLower });
		}
	});
	return pieces;
}

/** A sector as a cut: its footprint, and its daily hours set on each day of
 *  the zone's activity, the sun at the sector's centre. A sector with hours
 *  on a zone whose days are unbounded or unknown stays in the zone. */
function exclusionCut(e: SupAipExclusion, activity: ZoneActivity, zone: SupAipZone): VolumeCut {
	const shape = shapeOf(e.geometry);
	if (e.hours.length === 0) {
		return { ...shape, windows: null };
	}
	const periods = activity.rules.flatMap((r) => rulePeriods(r, -Infinity, Infinity, activity.sun));
	if (periods.length === 0) {
		return { ...shape, windows: [] };
	}
	const first = Math.min(...periods.map((w) => w.startMs));
	const last = Math.max(...periods.map((w) => w.endMs));
	if (!Number.isFinite(first) || !Number.isFinite(last) || last - first > MAX_CUT_DAYS * DAY_MS) {
		return { ...shape, windows: [] };
	}
	const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
	const days = { date: iso(first), dateTo: iso(last) };
	const acts = e.hours.map((h) => ({ ...days, ...h }));
	return { ...shape, windows: supActivationWindows(acts, boxSun(e.bbox ?? zone.bbox)) };
}

/** The most days a sector's hours are set on. */
const MAX_CUT_DAYS = 1000;

/** Who a supplement names as knowing its zones' real activity: the units
 *  under "Activité réelle connue de", then those named for users'
 *  information. */
function supKnownFrom(sup: SupAip): KnownUnit[] {
	const units = [...sup.contacts.filter((c) => !c.users), ...sup.contacts.filter((c) => c.users)];
	return units.map((c) => ({ unit: c.unit, freq: c.freqs[0] ? formatFreqMHz(c.freqs[0]) : null, phone: null }));
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
		const endMs = first.endDate && !first.permanent ? first.endDate.getTime() : Infinity;
		out.push({
			key: id,
			id,
			name: id,
			source: 'notam',
			publisher: null,
			rings: g.rings,
			circles: g.circles,
			bbox: g.bbox,
			vLower: limits.lower,
			vUpper: limits.upper,
			knownExtent: limits.known,
			extent: vExtent(limits.lower, limits.upper),
			type: '',
			airClass: '',
			category: '',
			rtba: false,
			entry: NO_ENTRY,
			qSubject: first.qCode.length >= 3 ? first.qCode.slice(1, 3) : '',
			supKind: '',
			supRule: '',
			supIfrOnly: false,
			radios: [],
			knownFrom: knownFrom(notamEText(first)),
			// From its B) to its C), or for good from its B), in the windows
			// of its D) item, in force or activable as its text says.
			activity: {
				rules: [{ mode: areaMode(first), startMs, endMs, schedule: notamItemD(first) }],
				sun: boxSun(g.bbox),
			},
		});
	}
	return out;
}
