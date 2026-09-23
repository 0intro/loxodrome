/* The alert banner grammar's shared pieces (docs/nav-alerts.md): the
 * phrasing (lead + action + line + the number-free announcement) and the
 * body-opens-detail action, used by the strip's banner row and the alert
 * panel alike, for both subjects of the stack (a volume, the ground ahead:
 * docs/terrain-awareness.md). Every function reads the reactive `t` at CALL
 * time (the navlogCards.ts precedent), so callers invoke them from
 * templates and deriveds and never capture the strings. */

import { t } from '$lib/state/i18n.svelte';
import { formatFreqMHz } from '$lib/format/radio';
import { fmtClockUtc, fmtNM } from '$lib/route/format';
import type { VolumeAlert } from '$lib/nav/airspaceAlert';
import type { SurfaceAlert } from '$lib/nav/alertSurface';
import type { TerrainAlert } from '$lib/nav/terrainAlert';
import { airspaceByKey } from '$lib/state/data.svelte';
import { resolveAirspaceRadios } from '$lib/state/freqOverride.svelte';
import { notamState } from '$lib/state/notam.svelte';
import { nav } from '$lib/state/navRecording.svelte';
import { selectAirspace, selectNotam, selectObstacle, selectSupaip } from '$lib/state/ui.svelte';

/** The unit and NOTAM-effective frequency to name in the banner: the
 *  airspace row's resolved radios (the freqOverride chokepoint, so a
 *  frequency-change NOTAM shows its effective value here too), else the
 *  volume's own list. Resolved at the pose's own instant, the band's: a
 *  replay names the channel the flight had, not the one a change dated
 *  since has moved it to. */
export function alarmRadio(a: VolumeAlert): { unit: string; freq: string } | null {
	let radios = a.volume.radios;
	if (a.volume.source === 'airspace') {
		const row = airspaceByKey(a.key);
		if (row) {
			const tMs = nav.playheadMs;
			radios = resolveAirspaceRadios(row, { fromMs: tMs, toMs: tMs }).radios;
		}
	}
	for (const r of radios) {
		const f = formatFreqMHz(r.freq);
		if (f !== '') {
			// Callsign first, the contactLines airspace rule: "contact
			// SEINE - APPROCHE 118.050" is the on-air identity a pilot
			// calls; the unit column carries the administrative name
			// ("LFPM MELUN SEINE", the AIXM Uni record).
			return { unit: r.call || r.unit, freq: f };
		}
	}
	return null;
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
	return `${alertLead(a, false)} ${alertAction(a)}`;
}

/** One alert's banner / panel-row line. A terrain row the demotion hold
 *  keeps states its subject without the last threat's figures, which were
 *  measured from where the aircraft was; the clearance is stated under IFR
 *  alone, the VFR one being the terrain layer's red, which the figures
 *  already make plain. */
export function alertLine(a: SurfaceAlert): string {
	if (a.subject === 'terrain') {
		const lead = alertLead(a, !a.held);
		return a.rules === 'ifr' ? `${lead}, ${alertAction(a)}` : lead;
	}
	const n = t.navigation;
	const parts = [alertLead(a, true), alertAction(a)];
	const w = a.window;
	if (w && w.startMs !== 0 && w.endMs !== Infinity) {
		parts.push(n.alertWindow(fmtClockUtc(w.startMs), fmtClockUtc(w.endMs)));
	}
	if (a.altUnknown) {
		parts.push(n.alertAltUnknown);
	} else if (a.extentUnknown) {
		parts.push(n.alertExtentUnknown);
	}
	return parts.join(' · ');
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
	} else {
		const idx = notamState.notams.findIndex((n) => n.id === v.id);
		if (idx >= 0) {
			selectNotam(idx);
		}
	}
}
