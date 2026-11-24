/* The alert banner grammar's shared pieces (docs/nav-alerts.md): the
 * phrasing (lead + action + line + the number-free announcement) and the
 * body-opens-detail action, used by the strip's banner row and the alert
 * panel alike, for both subjects of the stack (a volume, the ground ahead:
 * docs/terrain-awareness.md). Every function reads the reactive `t` at CALL
 * time (the navlogCards.ts precedent), so callers invoke them from
 * templates and deriveds and never capture the strings. */

import { whoKnows } from '$lib/data/knownFrom';
import { t } from '$lib/state/i18n.svelte';
import { periodWords, untilWords } from './zoneStateText';
import { contactLines, workableRadios, zoneLabel, type Radio } from '$lib/format/radio';
import { fmtNM } from '$lib/route/format';
import type { VolumeAlert } from '$lib/nav/airspaceAlert';
import type { BriefingMiss } from '$lib/state/airspaceAlert.svelte';
import type { SurfaceAlert } from '$lib/nav/alertSurface';
import type { TerrainAlert } from '$lib/nav/terrainAlert';
import { workableAirspaceRadios } from '$lib/data/airspaces';
import { airspaceByKey } from '$lib/state/data.svelte';
import { resolveAirspaceRadios } from '$lib/state/freqOverride.svelte';
import { notamIndexById } from '$lib/state/notam.svelte';
import { navLiveFor } from '$lib/state/navLive.svelte';
import { navRouteId } from '$lib/state/navRoute.svelte';
import { nav } from '$lib/state/navRecording.svelte';
import { selectAirspace, selectNotam, selectObstacle, selectSupaip, selectZsm } from '$lib/state/ui.svelte';
import { zsmLabel } from '$lib/data/zsm';

/** The unit and NOTAM-effective frequency to name in the banner: the
 *  airspace row's resolved radios (the freqOverride chokepoint, so a
 *  frequency-change NOTAM shows its effective value here too), else the
 *  volume's own list. Resolved at the pose's own instant, the band's: a
 *  replay names the channel the flight had, not the one a change dated
 *  since has moved it to.
 *
 *  The channel is the one the band sets: the airspace's workable list (its
 *  RAI channel, the civil VHF band, workableAirspaceRadios), then
 *  contactLines, which drops a withdrawn row and guard and names the unit by
 *  its call sign ("contact SEINE - APPROCHE 118.050", the on-air identity,
 *  where the unit column carries the AIXM administrative name). Naming the
 *  first published row instead said "contact EVREUX - APPROCHE 121.500":
 *  43 French rows list guard or UHF first. A volume whose list holds guard
 *  alone names no channel, and the banner keeps its generic wording. */
export function alarmRadio(a: VolumeAlert): { unit: string; freq: string } | null {
	const row = a.volume.source === 'airspace' ? airspaceByKey(a.key) : null;
	let radios: readonly (Radio & { closed?: boolean })[];
	if (row) {
		const tMs = nav.playheadMs;
		radios = workableAirspaceRadios(row, resolveAirspaceRadios(row, { fromMs: tMs, toMs: tMs }).radios);
	} else {
		radios = workableRadios(a.volume.radios);
	}
	// A channel naming no station is the zone's, named after it.
	const zone = row ? zoneLabel(row.type, row.name) : a.volume.name;
	const line = contactLines(radios, 'airspace', zone)[0];
	return line ? { unit: line.label, freq: line.freq } : null;
}

/** Where the threat's top stands against the projected path, to the 10 ft
 *  the terrain reference is quantised to. */
function pathHeight(a: TerrainAlert): string {
	const n = t.navigation;
	const ft = Math.round(Math.abs(a.clearanceFt) / 10) * 10;
	if (ft === 0) {
		return n.terrainAtPath;
	}
	return a.clearanceFt < 0 ? n.terrainAbovePath(String(ft)) : n.terrainBelowPath(String(ft));
}

/** A terrain row's lead: what is ahead, how high against the path and how
 *  soon. The warning names its subject in capitals, the annunciator word a
 *  panel pilot knows; nothing says "pull up" (the advisory posture). */
function terrainLead(a: TerrainAlert, ticking: boolean): string {
	const n = t.navigation;
	const warning = a.level === 'warning';
	if (!ticking) {
		if (a.kind === 'terrain') {
			return warning ? n.terrainAnnounceWarning : n.terrainAnnounceCaution;
		}
		return warning ? n.obstacleAnnounceWarning : n.obstacleAnnounceCaution;
	}
	const s = String(Math.max(1, Math.round(a.etaSec)));
	const h = pathHeight(a);
	if (a.kind === 'terrain') {
		return warning ? n.terrainWarning(h, s) : n.terrainAhead(h, s);
	}
	const type = t.data.obstacleTypes[a.obstacle?.type ?? 'other'];
	return warning ? n.obstacleWarning(type, h, s) : n.obstacleAhead(type, h, s);
}

/** The alert's lead clause: where the aircraft is relative to the volume.
 *  `ticking` false drops the distance and the countdown, which change on
 *  every fix; the announcement uses that form (see alertAnnounce). */
export function alertLead(a: SurfaceAlert, ticking: boolean): string {
	if (a.subject === 'terrain') {
		return terrainLead(a, ticking);
	}
	const n = t.navigation;
	const name = a.volume.name;
	if (a.severity === 'inside') {
		return n.alertInside(name);
	}
	if (a.verticalGap) {
		return a.gapClosing
			? a.gapSide === 'above'
				? n.alertDescendingInto(name)
				: n.alertClimbingInto(name)
			: a.gapSide === 'above'
				? n.alertJustAbove(name)
				: n.alertJustBelow(name);
	}
	if (a.severity === 'proximity') {
		return ticking ? n.alertAbeam(name, fmtNM(a.distNM ?? 0)) : n.alertNear(name);
	}
	return ticking
		? n.alertAhead(name, String(Math.max(1, Math.round((a.etaSec ?? 0) / 60))))
		: n.alertNear(name);
}

/** The alert's action clause: what the volume requires of the pilot, or
 *  the clearance the ground was graded against. It does not tick, which is
 *  what makes the announcement stable. */
export function alertAction(a: SurfaceAlert): string {
	const n = t.navigation;
	if (a.subject === 'terrain') {
		return n.terrainClearance(String(a.rtcFt));
	}
	const r = alarmRadio(a);
	if (a.coveredBy != null) {
		// Cumulative conditions: the projected entry lies inside an active
		// avoid volume, whose prohibition is the operative requirement;
		// covered outranks the planned softening in the phrasing.
		return n.alertCoveredForbidden(a.coveredBy);
	}
	if (a.planned && r) {
		return n.alertPlanned(r.unit, r.freq);
	}
	if (a.action === 'avoid') {
		return n.alertDoNotEnter;
	}
	if (a.action === 'clearance') {
		return r ? n.alertContact(r.unit, r.freq) : n.alertClearance;
	}
	if (a.action === 'radio') {
		return a.volume.type === 'TMZ-RMZ'
			? n.alertRadioXpdr
			: r
				? n.alertContact(r.unit, r.freq)
				: n.alertRadio;
	}
	if (a.action === 'transponder') {
		return n.alertTransponder;
	}
	if (a.volume.source === 'zsm' && a.volume.vUpper) {
		return n.alertZsm(zsmLabel(a.volume.vUpper.value));
	}
	return n.alertCaution;
}

/** What the assertive live region says: the same sentence as the banner
 *  with the per-fix numbers left out, so it is spoken when the alert
 *  appears or escalates and not once a second. A terrain row says its
 *  subject and level alone, the certified callout's economy. */
export function alertAnnounce(a: SurfaceAlert): string {
	if (a.subject === 'terrain') {
		return alertLead(a, false);
	}
	if (a.activityState === 'activable') {
		const action = a.action === 'caution' ? [] : [alertAction(a)];
		return [alertLead(a, false), ...action, t.navigation.alertMayBeActive].join(', ');
	}
	return `${alertLead(a, false)}, ${alertAction(a)}`;
}

/** One alert's banner / panel-row line, one sentence: "In R 174, entry
 *  prohibited, active until 23:59Z (altitude unknown)". A terrain row the
 *  demotion hold keeps states its subject without the last threat's
 *  figures, which were measured from where the aircraft was; the clearance
 *  is stated under IFR alone, the VFR one being the terrain layer's red,
 *  which the figures already make plain. */
export function alertLine(a: SurfaceAlert): string {
	if (a.subject === 'terrain') {
		const lead = alertLead(a, !a.held);
		return a.rules === 'ifr' ? `${lead}, ${alertAction(a)}` : lead;
	}
	const n = t.navigation;
	const w = a.window;
	const bounded = w && w.startMs !== 0 && w.endMs !== Infinity ? w : null;
	let parts: string[];
	if (a.activityState === 'activable') {
		// A zone that may be active says so in place of the caution its
		// tier words, beside any stronger action, and names who knows.
		const action = a.action === 'caution' ? [] : [alertAction(a)];
		const known = alertKnown(a);
		parts = [
			alertLead(a, true),
			...action,
			bounded ? alertPeriod(bounded, nav.playheadMs, true) : n.alertMayBeActive,
			...(known ? [known] : []),
		];
	} else {
		parts = [alertLead(a, true), alertAction(a)];
		if (bounded) {
			parts.push(alertPeriod(bounded, nav.playheadMs, false));
		}
	}
	const line = parts.join(', ');
	if (a.altUnknown) {
		return `${line} ${n.alertAltUnknown}`;
	}
	return a.extentUnknown ? `${line} ${n.alertExtentUnknown}` : line;
}

/** When the period behind an alert runs, at the playhead, active or one
 *  the zone may be active in (`may`): until its end once it has begun, from
 *  its start to its end before, its days named where it runs on others
 *  (zoneStateText.ts periodWords): a period of whole days ends at a
 *  midnight days away. */
function alertPeriod(w: { startMs: number; endMs: number }, nowMs: number, may: boolean): string {
	const n = t.navigation;
	if (w.startMs <= nowMs) {
		const u = untilWords(w.endMs, nowMs);
		return may ? n.alertMayUntil(u.to, u.dated) : n.alertUntil(u.to, u.dated);
	}
	const p = periodWords(w.startMs, w.endMs, nowMs);
	return may ? n.alertMayFromTo(p.from, p.to, p.on, p.dated) : n.alertFromTo(p.from, p.to, p.on, p.dated);
}

/** Who knows the zone's real activity, as the line names them: the unit
 *  data/knownFrom.ts whoKnows picks against the band's channels, the
 *  current contact's then the next's, or the telephone alone. */
function alertKnown(a: VolumeAlert): string | null {
	const contact = navLiveFor(navRouteId())?.contact ?? null;
	const k = whoKnows(a.volume.knownFrom, contact?.current?.radio ?? [], contact?.next?.radio ?? []);
	if (k === null) {
		return null;
	}
	const n = t.navigation;
	return k === 'phone' ? n.alertKnownByPhone : n.alertKnownOn(k.freq ? `${k.unit} ${k.freq}` : k.unit);
}

/** Whether the row's body opens a detail panel: every volume and an
 *  obstacle do, the ground ahead has none to open. */
export function alertOpens(a: SurfaceAlert): boolean {
	return a.subject === 'volume' || a.obstacle != null;
}

/** Open the alerted volume's detail panel: airspaces, SUP AIP zones and
 *  NOTAM areas each through their own selection, an obstacle through its
 *  own (no map fly: follow keeps the aircraft centred, and the feature is
 *  nearby by construction; the selection highlight marks it). */
export function openAlertPanel(a: SurfaceAlert): void {
	if (a.subject === 'terrain') {
		if (a.obstacle) {
			selectObstacle(a.obstacle.id);
		}
		return;
	}
	const v = a.volume;
	if (v.source === 'airspace') {
		selectAirspace(v.key);
	} else if (v.source === 'supaip') {
		const hash = v.id.lastIndexOf('#');
		selectSupaip(v.id.slice(0, hash), Number(v.id.slice(hash + 1)));
	} else if (v.source === 'zsm') {
		selectZsm(v.id);
	} else {
		const idx = notamIndexById(v.id);
		if (idx !== null) {
			selectNotam(idx);
		}
	}
}

/** The briefing caveat's line and its explanation, by what leaves the
 *  zones activated by NOTAM unknown (state/airspaceAlert.svelte.ts
 *  alertInputGaps). */
export function briefingCaveat(miss: BriefingMiss | null): { text: string; tip: string } {
	const n = t.navigation;
	switch (miss) {
		case 'position':
			return { text: n.alertBriefingPosition, tip: n.alertBriefingTip };
		case 'route':
			return { text: n.alertBriefingRoute, tip: n.alertBriefingTip };
		case 'period':
			return { text: n.alertBriefingPeriod, tip: n.alertBriefingTip };
		case 'rtba':
			return { text: n.alertBriefingRtba, tip: n.alertBriefingTip };
		default:
			return { text: n.alertNoBriefing, tip: n.alertNoBriefingTip };
	}
}
