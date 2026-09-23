/* The alert PRESENTATION fold: from one evaluation's alerts plus the
 * surface context (suspension, input gaps, the auto-stop countdown, the
 * position-quality note) to what the strip renders. Pure and clockless;
 * the only cross-eval memory is `prevOrder`, the previous model's row
 * order, fed back by the caller exactly like the evaluator's prev state.
 *
 * The model is the certified annunciator / record / status split
 * (docs/nav-alerts.md "Presentation"): ONE banner row carries the dominant
 * unacknowledged alert, the chip carries the channel's state while
 * anything alerts or evaluation is suspended, and everything else lives
 * in the alert panel. Acknowledged alerts leave the banner and the badge;
 * when every alert is acknowledged the banner collapses and the muted
 * chip alone remains; when nothing alerts the strip rests clean.
 *
 * TWO SUBJECTS share the one stack, each graded by its own evaluator: the
 * volumes (nav/airspaceAlert.ts) and the ground ahead (nav/terrainAlert.ts,
 * docs/terrain-awareness.md), ranked here on one scale. A terrain WARNING
 * outranks every row, a prohibited volume the aircraft is inside included:
 * it is the one alert about the aircraft meeting something. A terrain
 * CAUTION sits in the avoid tier as an approaching entry, behind a
 * prohibited volume the aircraft is inside or about to enter and ahead of
 * every contact, equipment and caution row. The ink, the solid form and the
 * planned form are decided here for both, so the banner and the panel stop
 * re-deriving them in class expressions.
 *
 * Ordering is STABLE on purpose: the evaluator breaks ties on etaSec,
 * which ticks with every fix and made rows jump while being read. Here
 * ties break on the previous order instead, so a row moves only on a
 * real change (ack, severity, action). The map layer keeps reading the
 * evaluator's own `dominant`; the two can differ only on an eta tie. */

import { ACTION_RANK } from './alertRules';
import {
	SEVERITY_RANK,
	dominanceRank,
	type AlertSeverity,
	type VolumeAlert,
} from './airspaceAlert';
import type { TerrainAlert } from './terrainAlert';

/** One row of the alert stack. */
export type SurfaceAlert = VolumeAlert | TerrainAlert;

/** Why evaluation is suspended: the position was lost mid-recording, or a
 *  recording has no fix yet (the boot / fresh-start posture). Only a live
 *  recording can be suspended; replay evaluates recorded facts. */
export type SuspendReason = 'lost' | 'noFix';

export type ChipKind = 'alerts' | 'acked' | 'suspended';
/** Ink family, resolved to theme tokens by the component: `danger` =
 *  --danger, `alert` = --nav-orange, `caution` = --workbook-orange. */
export type ChipInk = 'danger' | 'alert' | 'caution' | 'muted';

/** Strip regions in render order. `suspended` and `banner` are mutually
 *  exclusive (suspension implies an empty evaluation); `gapLine` (the
 *  airspaces gap, the no-evaluation caveat) renders beside either, since
 *  NOTAM / SUP volumes can alert without the airspace dataset and neither
 *  fact may hide the other. `quality` is subsumed by `suspended` (both
 *  would state the lost position). */
export type RegionKind = 'suspended' | 'banner' | 'gapLine' | 'stopSoon' | 'quality';

export interface AlertSurfaceChip {
	kind: ChipKind;
	ink: ChipInk;
	/** Solid form (page-background text on the ink): the dominant unacked
	 *  alert is INSIDE its volume now, the banner's own escalation. */
	solid: boolean;
}

/** A standing fact about what the evaluation cannot see, listed in the
 *  panel: the airspace dataset or the briefing missing, part of the terrain
 *  ahead not read, the obstacle dataset not loaded, the terrain alerts
 *  inhibited by the pilot. */
export type AlertCaveat = 'airspaces' | 'briefing' | 'terrain' | 'obstacles' | 'inhibited';

export interface AlertSurfaceInput {
	/** Both evaluations' alerts, [] when neither returned any. */
	alerts: readonly SurfaceAlert[];
	suspended: SuspendReason | null;
	gaps: { airspaces: boolean; briefing: boolean } | null;
	/** The terrain evaluation's own gaps (state/terrainAlert.svelte.ts). */
	terrainGaps: { unread: boolean; obstacles: boolean } | null;
	/** The pilot inhibited the terrain alerts (Garmin's TER INHB). */
	terrainInhibited: boolean;
	/** The auto-stop countdown is pending (its region is owned here only
	 *  for ORDER; the component keeps its own timer rendering). */
	stopPending: boolean;
	/** positionQuality() !== 'good': the strip's quality note. */
	stale: boolean;
	/** The previous model's `order`; [] on the first call or after a
	 *  backward playhead jump. */
	prevOrder: readonly string[];
}

export interface AlertSurfaceModel {
	/** The dominant UNACKNOWLEDGED alert; null when none, all are
	 *  acknowledged, or evaluation is suspended. */
	banner: SurfaceAlert | null;
	/** The hidden-strip escape predicate on `banner`: an unacknowledged
	 *  non-planned alert that is avoid-tier (any severity) or at least
	 *  imminent renders bare even while the strip is dismissed, and so does
	 *  every terrain row. */
	bannerEscapes: boolean;
	suspended: SuspendReason | null;
	badge: { unacked: number; acked: number };
	/** The channel-health chip; null when nothing alerts and nothing is
	 *  suspended, so the strip rests clean. A bare data gap raises no
	 *  chip: the airspaces gap has its inline line, and the briefing gap
	 *  lives in the Navigation tab and in the panel whenever an alert
	 *  puts the chip up (its consequence self-surfaces as the caution
	 *  alerts near NOTAM-activated zones). */
	chip: AlertSurfaceChip | null;
	panel: {
		active: SurfaceAlert[];
		acked: SurfaceAlert[];
		caveats: AlertCaveat[];
	};
	regions: RegionKind[];
	/** Feed back as the next call's `prevOrder`. */
	order: string[];
}

/** The ink family a row wears: the prohibited tier and a terrain warning in
 *  the danger ink, a caution in the workbook amber (a terrain caution is
 *  Garmin's yellow, the caution colour), the contact and equipment tiers in
 *  the family's alert orange. A planned traversal steps back to the alert
 *  ink whatever its tier. */
export function alertInk(a: SurfaceAlert): Exclude<ChipInk, 'muted'> {
	if (a.subject === 'terrain') {
		return a.level === 'warning' ? 'danger' : 'caution';
	}
	if (a.action === 'avoid' && !a.planned) {
		return 'danger';
	}
	if (a.action === 'caution') {
		return 'caution';
	}
	return 'alert';
}

/** The solid form (page-surface text on the ink): a volume the aircraft is
 *  inside, unplanned, and a terrain warning (the GTN's white on red). */
export function alertSolid(a: SurfaceAlert): boolean {
	if (a.subject === 'terrain') {
		return a.level === 'warning';
	}
	return a.severity === 'inside' && !a.planned;
}

/** The stepped-back planned form: a briefed traversal of the flown route. */
export function alertPlanned(a: SurfaceAlert): boolean {
	return a.subject === 'volume' && a.planned;
}

/** The row's place on the one dominance scale (see the header). */
export function rankOf(a: SurfaceAlert): number {
	if (a.subject === 'terrain') {
		return a.level === 'warning' ? ACTION_RANK.avoid + 1 : ACTION_RANK.avoid;
	}
	return dominanceRank(a);
}

/** The severity breaking a tie inside a rank. */
function sevOf(a: SurfaceAlert): number {
	if (a.subject === 'terrain') {
		return a.level === 'warning' ? SEVERITY_RANK.inside : SEVERITY_RANK.approaching;
	}
	return SEVERITY_RANK[a.severity];
}

const IMMINENT_RANK: number = SEVERITY_RANK['imminent' satisfies AlertSeverity];

function escapes(a: SurfaceAlert): boolean {
	if (a.subject === 'terrain') {
		return true;
	}
	return !a.planned && (a.action === 'avoid' || SEVERITY_RANK[a.severity] >= IMMINENT_RANK);
}

export function alertSurface(i: AlertSurfaceInput): AlertSurfaceModel {
	// Stable order: the evaluator's dominance without its eta tiebreaker.
	const prevIdx = new Map<string, number>();
	i.prevOrder.forEach((k, idx) => prevIdx.set(k, idx));
	const sorted = [...i.alerts].sort((a, b) => {
		if (a.acked !== b.acked) {
			return a.acked ? 1 : -1;
		}
		const rank = rankOf(b) - rankOf(a);
		if (rank !== 0) {
			return rank;
		}
		const sev = sevOf(b) - sevOf(a);
		if (sev !== 0) {
			return sev;
		}
		const pa = prevIdx.get(a.key) ?? Infinity;
		const pb = prevIdx.get(b.key) ?? Infinity;
		if (pa !== pb) {
			return pa - pb;
		}
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});

	const active = sorted.filter((a) => !a.acked);
	const acked = sorted.filter((a) => a.acked);
	const banner = i.suspended == null ? (active[0] ?? null) : null;

	const caveats: AlertCaveat[] = [];
	if (i.gaps?.airspaces) {
		caveats.push('airspaces');
	}
	if (i.gaps?.briefing) {
		caveats.push('briefing');
	}
	if (i.terrainInhibited) {
		caveats.push('inhibited');
	} else if (i.terrainGaps?.unread) {
		caveats.push('terrain');
	}
	if (i.terrainGaps?.obstacles) {
		caveats.push('obstacles');
	}

	let chip: AlertSurfaceChip | null = null;
	if (i.suspended != null) {
		// lost = a live position stopped, the danger ink; noFix = a recording
		// waiting for its first fix, normal start-up in the calm alert ink.
		chip = { kind: 'suspended', ink: i.suspended === 'lost' ? 'danger' : 'alert', solid: false };
	} else if (banner != null) {
		chip = { kind: 'alerts', ink: alertInk(banner), solid: alertSolid(banner) };
	} else if (acked.length > 0) {
		chip = { kind: 'acked', ink: 'muted', solid: false };
	}

	const regions: RegionKind[] = [];
	if (i.suspended != null) {
		regions.push('suspended');
	} else if (banner != null) {
		regions.push('banner');
	}
	if (i.gaps?.airspaces) {
		regions.push('gapLine');
	}
	if (i.stopPending) {
		regions.push('stopSoon');
	}
	if (i.stale && i.suspended == null) {
		regions.push('quality');
	}

	return {
		banner,
		bannerEscapes: banner != null && escapes(banner),
		suspended: i.suspended,
		badge: { unacked: active.length, acked: acked.length },
		chip,
		panel: { active, acked, caveats },
		regions,
		order: sorted.map((a) => a.key),
	};
}
