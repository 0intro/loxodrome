/* The alert banner grammar's shared pieces (docs/nav-alerts.md): the
 * phrasing (lead + action + line + the number-free announcement) and the
 * body-opens-detail action, used by the strip's banner row and the alert
 * panel alike. Every function reads the reactive `t` at CALL time (the
 * navlogCards.ts precedent), so callers invoke them from templates and
 * deriveds and never capture the strings. */

import { t } from '$lib/state/i18n.svelte';
import { formatFreqMHz } from '$lib/format/radio';
import { fmtClockUtc, fmtNM } from '$lib/route/format';
import type { VolumeAlert } from '$lib/nav/airspaceAlert';
import { airspaceByKey } from '$lib/state/data.svelte';
import { resolveAirspaceRadios } from '$lib/state/freqOverride.svelte';
import { notamState } from '$lib/state/notam.svelte';
import { selectAirspace, selectNotam, selectSupaip } from '$lib/state/ui.svelte';

/** The unit and NOTAM-effective frequency to name in the banner: the
 *  airspace row's resolved radios (the freqOverride chokepoint, so a
 *  frequency-change NOTAM shows its effective value here too), else the
 *  volume's own list. */
export function alarmRadio(a: VolumeAlert): { unit: string; freq: string } | null {
	let radios = a.volume.radios;
	if (a.volume.source === 'airspace') {
		const row = airspaceByKey(a.key);
		if (row) {
			radios = resolveAirspaceRadios(row).radios;
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

/** The alert's lead clause: where the aircraft is relative to the volume.
 *  `ticking` false drops the distance and the countdown, which change on
 *  every fix; the announcement uses that form (see alertAnnounce). */
export function alertLead(a: VolumeAlert, ticking: boolean): string {
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

/** The alert's action clause: what the volume requires of the pilot. It
 *  does not tick, which is what makes the announcement stable. */
export function alertAction(a: VolumeAlert): string {
	const n = t.navigation;
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
 *  appears or escalates and not once a second. */
export function alertAnnounce(a: VolumeAlert): string {
	return `${alertLead(a, false)} ${alertAction(a)}`;
}

/** One alert's banner / panel-row line. */
export function alertLine(a: VolumeAlert): string {
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

/** Open the alerted volume's detail panel: airspaces, SUP AIP zones and
 *  NOTAM areas each through their own selection (no map fly: follow
 *  keeps the aircraft centred, and the zone is nearby by construction;
 *  the selection highlight marks it). */
export function openAlertPanel(a: VolumeAlert): void {
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
