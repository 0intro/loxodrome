/* The states the map draws its zones in (docs/zone-activity.md, "The map"):
 * a verdict, read from the RAW briefing as the alerts and the panels read it
 * (state/activity.svelte.ts), at the viewed time (drawnStateAt), a zone
 * activated later in the viewing period (activeEvalWindow) told apart from
 * one active now.
 *
 * The airspaces' activation hatch marks a zone active over the viewed time
 * on a NOTAM, the RTBA programme, a firm published timetable or the pilot's
 * note, a zone in force at all times keeping its chart symbol, and a dashed
 * outline marks one a NOTAM or the RTBA programme activates later in the
 * period. A zone inactive over the viewed time draws faint: the resolver
 * answers inactive only on an authority (hours read whole, a briefing that
 * speaks within the notice, the RTBA programme, the pilot's note).
 *
 * A supplement's zone takes the hatch when active, a band inside its
 * boundary when it may be active, a dashed outline when it becomes either
 * later in the period, and is hidden when inactive (supStates; the level
 * band and the layer's toggle are state/supaip.svelte.ts's). Activated by
 * a NOTAM or the pilot's note, its hatch draws whatever the toggle, as the
 * activation hatch always did; active on its own published period, the
 * layer hatches it. */

import { nextConfirmedStart, nextRuleStart, resolveActivity, type ConfirmedPeriod } from '$lib/data/activity';
import type { Airspace } from '$lib/data/airspaces';
import type { SupAip } from '$lib/data/supaip';
import { airspaceVolumes, notamVolumes, supaipVolumes, type AlertVolume } from '$lib/nav/alertVolumes';
import type { Notam } from '$lib/notam/types';
import { activationPeriods, amendedPeriods, zoneInput } from './activity.svelte';
import { zoneNotamState } from './zoneNotams.svelte';
import { dataState, getAirspaces, getSupaips } from './data.svelte';
import { activeEvalWindow, briefingRtbaDays, drawnStateAt, joinNotams, notamState } from './notam.svelte';
import { planScope } from './planScope.svelte';
import { supZoneActivationsRaw } from './supaipLinks.svelte';
import type { ZoneNote } from './zoneNotes.svelte';

/** The zones a hatch draws, by airspace id or supplement zone key. */
export interface DrawnActivations {
	/** Active over the viewed time: the hatch. */
	active: ReadonlySet<string>;
	/** Activated by a NOTAM or the RTBA programme later in the viewing
	 *  period, and not active now: a dashed outline. */
	later: ReadonlySet<string>;
}


/** The restricted and transit rows' volumes, by dataset: the zones whose
 *  activity the map reads. */
let volumeCache: { airspaces: Airspace[]; volumes: AlertVolume[] } | null = null;

function zoneVolumes(airspaces: Airspace[]): AlertVolume[] {
	if (volumeCache?.airspaces !== airspaces) {
		const rows = airspaces.filter((a) => a.category === 'restricted' || a.category === 'transit');
		volumeCache = { airspaces, volumes: airspaceVolumes(rows) };
	}
	return volumeCache.volumes;
}

/** `next`, or `prev` where both hold the same members: a consumer keyed on
 *  the reference stays put across a tick that changes nothing. */
function steady(prev: DrawnActivations | null, next: DrawnActivations): DrawnActivations {
	const same = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
		a.size === b.size && [...a].every((k) => b.has(k));
	return prev && same(prev.active, next.active) && same(prev.later, next.later) ? prev : next;
}

/** The airspaces' states the map draws, by airspace id: the hatch's
 *  active and later sets, the faint set, and the zones that may be active
 *  that a NOTAM or the RTBA programme activates later. */
interface AirspaceStates extends DrawnActivations {
	faint: ReadonlySet<string>;
	may: ReadonlySet<string>;
}

const NO_STATES: AirspaceStates = { active: new Set(), later: new Set(), faint: new Set(), may: new Set() };

let airspaceMemo: {
	airspaces: Airspace[];
	confirmed: Map<string, ConfirmedPeriod[]>;
	amended: unknown;
	briefing: readonly unknown[];
	notes: Readonly<Record<string, ZoneNote>> | null;
	fromMs: number;
	toMs: number;
	untilMs: number;
	out: AirspaceStates;
} | null = null;

/** Every restricted and transit zone read once over the viewed time, as its
 *  panel reads it (zoneInput), memoised on what the reading reads. */
function airspaceStates(): AirspaceStates {
	void dataState.revision.airspaces;
	const airspaces = dataState.airspacesLoaded ? getAirspaces() : null;
	if (!airspaces) {
		return NO_STATES;
	}
	const notams = joinNotams();
	const confirmed = activationPeriods(notams, supZoneActivationsRaw(), airspaces);
	const amended = amendedPeriods(notams, airspaces);
	const briefing = [notamState.lastFetch, notamState.byHand, briefingRtbaDays(), zoneNotamState.at];
	const notes = planScope.zoneNotes?.all() ?? null;
	const at = drawnStateAt();
	const untilMs = activeEvalWindow().to;
	const m = airspaceMemo;
	if (
		m &&
		m.airspaces === airspaces &&
		m.confirmed === confirmed &&
		m.amended === amended &&
		m.briefing.every((x, i) => x === briefing[i]) &&
		m.notes === notes &&
		m.fromMs === at.fromMs &&
		m.toMs === at.toMs &&
		m.untilMs === untilMs
	) {
		return m.out;
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a memo's output, rebuilt whole
	const active = new Set<string>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a memo's output, rebuilt whole
	const later = new Set<string>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a memo's output, rebuilt whole
	const faint = new Set<string>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a memo's output, rebuilt whole
	const may = new Set<string>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- build-local dedup
	const seen = new Set<string>();
	for (const v of zoneVolumes(airspaces)) {
		if (seen.has(v.id)) {
			continue;
		}
		seen.add(v.id);
		const answer = resolveActivity(zoneInput(v, at), at.fromMs, at.toMs);
		if (answer.state === 'active' && answer.reason !== 'permanent') {
			active.add(v.id);
			continue;
		}
		const comes = nextConfirmedStart(confirmed.get(v.id), at.toMs, untilMs) !== null;
		if (answer.state === 'inactive') {
			faint.add(v.id);
			if (comes) {
				later.add(v.id);
			}
		} else if (answer.state === 'activable' && comes) {
			may.add(v.id);
		}
	}
	const kept = steady(m?.out ?? null, { active, later });
	const held = (prev: ReadonlySet<string> | undefined, next: ReadonlySet<string>): ReadonlySet<string> =>
		prev && prev.size === next.size && [...next].every((k) => prev.has(k)) ? prev : next;
	const out: AirspaceStates = {
		active: kept.active,
		later: kept.later,
		faint: held(m?.out.faint, faint),
		may: held(m?.out.may, may),
	};
	airspaceMemo = {
		airspaces,
		confirmed,
		amended,
		briefing,
		notes,
		fromMs: at.fromMs,
		toMs: at.toMs,
		untilMs,
		out: m && out.active === m.out.active && out.later === m.out.later && out.faint === m.out.faint && out.may === m.out.may ? m.out : out,
	};
	return airspaceMemo.out;
}

/** The airspaces the activation hatch draws: active over the viewed time on
 *  a NOTAM, the RTBA programme, a firm published timetable or the pilot's
 *  note, and later in the period on a NOTAM or the RTBA programme. */
export function airspaceActivations(): DrawnActivations {
	return airspaceStates();
}

/** The airspaces inactive over the viewed time, on an authority: the
 *  painting draws them faint, a highlighted or linked one too. */
export function airspaceFaint(): ReadonlySet<string> {
	return airspaceStates().faint;
}

/** The airspaces that may be active over the viewed time and that a NOTAM
 *  or the RTBA programme activates later in the viewing period: the
 *  painting draws them whatever their category's toggle, in their chart
 *  look, which is the look of a zone that may be active. */
export function airspaceMay(): ReadonlySet<string> {
	return airspaceStates().may;
}

/** A temporary zone's state as the map draws it: the hatch when active, the
 *  band inside its boundary when it may be active, a dashed outline when a
 *  period of it or a NOTAM begins later in the viewing period, hidden when
 *  inactive. */
export type ZoneDrawState = 'active' | 'may' | 'later' | 'inactive';

/** A supplement zone's, 'activated' on a NOTAM or the pilot's note, 'active'
 *  on its own published period. */
export type SupDrawState = 'activated' | ZoneDrawState;

/** A temporary zone read over the viewed time, `answer` its resolver's: the
 *  later state where a period of its own or a NOTAM begins in the rest of
 *  the viewing period, else inactive. */
function drawState(v: AlertVolume, at: { fromMs: number; toMs: number }, untilMs: number): {
	state: ZoneDrawState;
	confirmed: boolean;
	/** A NOTAM activates it later in the viewing period. */
	comes: boolean;
} {
	const input = zoneInput(v, at);
	const answer = resolveActivity(input, at.fromMs, at.toMs);
	if (answer.state === 'active') {
		const confirmed = answer.reason === 'notam' || answer.reason === 'notam-unread' || answer.reason === 'noted';
		return { state: 'active', confirmed, comes: false };
	}
	const comes = nextConfirmedStart(input.confirmed, at.toMs, untilMs) !== null;
	if (answer.state === 'activable') {
		return { state: 'may', confirmed: false, comes };
	}
	const later = comes || nextRuleStart(v.activity, at.toMs, untilMs) !== null;
	return { state: later ? 'later' : 'inactive', confirmed: false, comes };
}

/** Is `next` the same states as `prev`, key for key? */
function sameStates<S>(prev: ReadonlyMap<string, S> | undefined, next: ReadonlyMap<string, S>): boolean {
	return prev !== undefined && prev.size === next.size && [...next].every(([k, s]) => prev.get(k) === s);
}

const NO_SUP_STATES: ReadonlyMap<string, SupDrawState> = new Map();

/** The supplements' zone volumes, by dataset. */
let supVolumeCache: { sups: readonly SupAip[]; volumes: AlertVolume[] } | null = null;

let supMemo: {
	volumes: AlertVolume[];
	confirmed: Map<string, ConfirmedPeriod[]>;
	briefing: readonly unknown[];
	notes: Readonly<Record<string, ZoneNote>> | null;
	fromMs: number;
	toMs: number;
	untilMs: number;
	out: ReadonlyMap<string, SupDrawState>;
	coming: ReadonlySet<string>;
} | null = null;

/** Every supplement zone's state over the viewed time, by zone key, read
 *  as its panel reads it (zoneInput), whatever the level band and the
 *  layer's toggle (state/supaip.svelte.ts applies them). */
export function supStates(): ReadonlyMap<string, SupDrawState> {
	void dataState.supaipLoaded;
	const sups = getSupaips();
	if (!sups) {
		return NO_SUP_STATES;
	}
	if (supVolumeCache?.sups !== sups) {
		supVolumeCache = { sups, volumes: supaipVolumes([...sups]) };
	}
	const volumes = supVolumeCache.volumes;
	const airspaces = dataState.airspacesLoaded ? getAirspaces() : null;
	const confirmed = activationPeriods(joinNotams(), supZoneActivationsRaw(), airspaces);
	const briefing = [notamState.lastFetch, notamState.byHand, zoneNotamState.at];
	const notes = planScope.zoneNotes?.all() ?? null;
	const at = drawnStateAt();
	const untilMs = activeEvalWindow().to;
	const m = supMemo;
	if (
		m &&
		m.volumes === volumes &&
		m.confirmed === confirmed &&
		m.briefing.every((x, i) => x === briefing[i]) &&
		m.notes === notes &&
		m.fromMs === at.fromMs &&
		m.toMs === at.toMs &&
		m.untilMs === untilMs
	) {
		return m.out;
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a memo's output, rebuilt whole
	const out = new Map<string, SupDrawState>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a memo's output, rebuilt whole
	const coming = new Set<string>();
	for (const v of volumes) {
		const d = drawState(v, at, untilMs);
		out.set(v.id, d.state === 'active' && d.confirmed ? 'activated' : d.state);
		if (d.comes && (d.state === 'may' || d.state === 'later')) {
			coming.add(v.id);
		}
	}
	const held = m?.coming;
	supMemo = {
		volumes,
		confirmed,
		briefing,
		notes,
		fromMs: at.fromMs,
		toMs: at.toMs,
		untilMs,
		out: m && sameStates(m.out, out) ? m.out : out,
		coming: held && held.size === coming.size && [...coming].every((k) => held.has(k)) ? held : coming,
	};
	return supMemo.out;
}

/** The supplements' zones that may be active or are inactive over the
 *  viewed time and that a NOTAM activates later in the viewing period:
 *  the layer draws them whatever its toggle, as the map draws the
 *  airspaces a NOTAM of the period concerns (airspaceMay, the later
 *  outline), beside the NOTAM's marker. */
export function supNotamComing(): ReadonlySet<string> {
	supStates();
	return supMemo?.coming ?? NO_KEYS;
}

const NO_KEYS: ReadonlySet<string> = new Set();

const NO_NOTAM_STATES: ReadonlyMap<string, ZoneDrawState> = new Map();

let notamVolumeCache: { notams: readonly Notam[]; volumes: AlertVolume[] } | null = null;

let notamMemo: {
	volumes: AlertVolume[];
	briefing: readonly unknown[];
	notes: Readonly<Record<string, ZoneNote>> | null;
	fromMs: number;
	toMs: number;
	untilMs: number;
	out: ReadonlyMap<string, ZoneDrawState>;
} | null = null;

/** The state of every zone a loaded NOTAM creates (its restricted or
 *  warning area, nav/alertVolumes.ts notamVolumes), by NOTAM id, read as its
 *  panel reads it (zoneInput) over the viewed time. A NOTAM that creates
 *  none has no entry: the NOTAM layer draws it as an area. */
export function notamStates(): ReadonlyMap<string, ZoneDrawState> {
	const notams = joinNotams();
	if (notams.length === 0) {
		return NO_NOTAM_STATES;
	}
	if (notamVolumeCache?.notams !== notams) {
		notamVolumeCache = { notams, volumes: notamVolumes(notams) };
	}
	const volumes = notamVolumeCache.volumes;
	const briefing = [notamState.lastFetch, notamState.byHand, zoneNotamState.at];
	const notes = planScope.zoneNotes?.all() ?? null;
	const at = drawnStateAt();
	const untilMs = activeEvalWindow().to;
	const m = notamMemo;
	if (
		m &&
		m.volumes === volumes &&
		m.briefing.every((x, i) => x === briefing[i]) &&
		m.notes === notes &&
		m.fromMs === at.fromMs &&
		m.toMs === at.toMs &&
		m.untilMs === untilMs
	) {
		return m.out;
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a memo's output, rebuilt whole
	const out = new Map<string, ZoneDrawState>();
	for (const v of volumes) {
		out.set(v.id, drawState(v, at, untilMs).state);
	}
	notamMemo = {
		volumes,
		briefing,
		notes,
		fromMs: at.fromMs,
		toMs: at.toMs,
		untilMs,
		out: m && sameStates(m.out, out) ? m.out : out,
	};
	return notamMemo.out;
}
