/* Frequency-change NOTAM -> radio overrides.
 *
 * A frequency-change NOTAM (isFrequencyChangeQCode) reassigns a published
 * COM frequency. This module overlays those changes onto the loaded radio rows
 * so the detail panels AND the nav-log show, and use, the NOTAM'd value with
 * its provenance. The pure value extraction lives in $lib/notam/freqChange.ts;
 * here each assignment is tied to a known radio row, reusing the SAME
 * NOTAM<->feature associations the panels already list under "Affecting
 * NOTAMs": airports by their A) ident (notamsByIdent), airspaces / SIV by name
 * (notamNamesAirspace).
 *
 * "Override when sure, else flag": a value is applied only where the NOTAM
 * says precisely which row it lands on, and there are two ways it can say so.
 * The OLD value it replaces names the CHANNEL, so every row still publishing
 * that value moves, the printed service label notwithstanding (several
 * services share one channel: a field converting to 8.33 kHz lists its A/A,
 * VDF, AFIS and TWR against a single pair). Failing that, the service label
 * must resolve to exactly one row. Anything ambiguous, unmatched, value-less
 * or conflicting is surfaced as a flag with a link to the NOTAM, never
 * silently applied (a NOTAM viewer must not show a frequency it isn't sure
 * of), and a flag is only ever raised by something that says a frequency
 * MOVED: an "installed" notice describing a new facility earns overrides
 * where its values land, and silence where they do not.
 *
 * SERVICE CLOSURES ride the same associations the other way: a NOTAM whose
 * FIS-subject Q-code states an unserviceability (QSEAU: "BEAUVAIS INFO
 * 119.800 NOT AVBL, FIS AREA 2 CLOSED, CONTACT PARIS INFO 125.700") does not
 * reassign a frequency, it WITHDRAWS one, so the rows publishing the stated
 * value are marked `closed` (kept for display, struck; unusable as a contact,
 * so the route ladder falls back to the published unit underneath, which IS
 * the NOTAM's designated substitute). The pure grammar and ladder live in
 * $lib/notam/serviceClosure.ts; the D) day schedule in $lib/notam/schedule.ts
 * (unparseable D) never closes, it flags). Contract:
 * docs/notam-relationships.md.
 *
 * Every application is gated on the NOTAM's OWN validity (and D) schedule)
 * over the caller's evaluation range `at`: planning surfaces pass nothing and
 * get activeEvalWindow(); the live selector passes its display instant so a
 * replay reads the truth the flight had. Reactive by construction: reads
 * filteredNotams() through notamsByIdent / notamsForAirspace, so the data
 * filters propagate, and the default window's 'now' branch rides
 * notamState.tick, so day boundaries do too. Call inside $derived.
 */

import type { Airport, AirportRadio } from '$lib/data/airports';
import { narrowToRai, raiRadioIndex, type Airspace, type AirspaceRadio } from '$lib/data/airspaces';
import type { RouteAirspaceEvent } from '$lib/route/airspaces';
import { formatFreqMHz } from '$lib/format/radio';
import {
	allReplacements,
	parseFreqAssignments,
	singleFreq,
	type FreqAssignment,
	type FreqReplacement,
} from '$lib/notam/freqChange';
import { notamEText, notamSections } from '$lib/notam/sections';
import {
	isFlightInfoServiceQCode,
	isFrequencyChangeCondition,
	isFrequencyChangeQCode,
	isUnserviceableCondition,
} from '$lib/notam/qcode';
import { parseItemD, scheduleActiveIn } from '$lib/notam/schedule';
import { parseSectorHours, sectorActiveIn, type SectorHours } from '$lib/route/airspaceHours';
import {
	applyClosures,
	parseServiceClosure,
	type ClosureCandidate,
} from '$lib/notam/serviceClosure';
import type { Notam } from '$lib/notam/types';
import { t } from './i18n.svelte';
import {
	activeEvalWindow,
	notamsByIdent,
	notamSpanMs,
	filteredNotams,
	notamState,
	type IndexedNotam,
} from './notam.svelte';
import { dossierFlightDate } from './flightPrep.svelte';
import { plannedFlightWindow } from './timeWindow.svelte';
import {
	airspacesNamedByNotam,
	notamNamesAirspace,
	notamsForAirspace,
} from './notamLinks.svelte';

/** Provenance for a radio row whose frequency a NOTAM currently overrides. */
export interface RadioOverride {
	/** The NOTAM that changed the frequency, with its index for navigateToNotam. */
	source: IndexedNotam;
	/** The frequency (3-dp) this row was publishing before the NOTAM moved it,
	 *  which is what the panel strikes through. Equal to the value the NOTAM
	 *  states it replaces wherever that value is what placed the row. */
	was: string;
}

export interface EffectiveAirportRadio extends AirportRadio {
	override?: RadioOverride;
}

export interface EffectiveAirspaceRadio extends AirspaceRadio {
	override?: RadioOverride;
	/** Set with `closed` when a service-closure NOTAM withdraws this row's
	 *  frequency over the evaluation range: the NOTAM, and the substitutes its
	 *  text designates (display provenance only, never resolved into a row;
	 *  the working substitute is whatever published unit the contact ladder
	 *  falls back to). */
	closedBy?: { source: IndexedNotam; substitutes: { label: string; freq: string }[] };
}

/** The evaluation range an application is judged against: the NOTAM's B)/C)
 *  validity (and a closure's D) schedule) must reach into it. Planning
 *  surfaces default to activeEvalWindow(); the live selector passes its
 *  display instant as a zero-length range. */
export interface ResolveAt {
	fromMs: number;
	toMs: number;
}

function defaultAt(): ResolveAt {
	const w = activeEvalWindow();
	return { fromMs: w.from, toMs: w.to };
}

/** The range a SECTOR'S OWN HOURS are judged against, which is deliberately
 *  not the viewing period: activeEvalWindow is a briefing filter whose default
 *  horizon is unbounded, and "is this unit open at some point between now and
 *  forever" is true of every schedule ever published. Which frequency to set is
 *  a question about the flight, so it is the planned flight's own span (its ETD
 *  to its last arrival, or the whole day of the flight date when no ETD is
 *  stated), and the current minute when no plan resolves one. */
function defaultFlightAt(): ResolveAt {
	const w = plannedFlightWindow();
	if (w) {
		return { fromMs: w.from, toMs: w.to };
	}
	// The span did not resolve, which a plan reaches by stating a departure
	// time with no cruise speed to fly it at. The flight is still somewhere in
	// its own DAY, which is exactly what computeFlightSpan falls back to when
	// no ETD is stated, so read that rather than the wall clock: judging a
	// Saturday plan by today's Monday would withdraw a frequency the flight
	// will need, and withdrawing one a unit is working is the failure this
	// whole path exists to avoid.
	const dayMs = Date.parse(`${dossierFlightDate()}T00:00:00Z`);
	if (Number.isFinite(dayMs)) {
		return { fromMs: dayMs, toMs: dayMs + 24 * 3600_000 };
	}
	// Only a malformed stored date reaches here. Floored to the minute for the
	// reason activeEvalWindow floors: two surfaces resolving in one render pass
	// must not straddle a window boundary and disagree.
	void notamState.tick; // re-resolve on the shared minute heartbeat
	const now = Math.floor(Date.now() / 60_000) * 60_000;
	return { fromMs: now, toMs: now };
}

/** Does either season's closing time need a position to resolve? Only the
 *  CHEVREUSE sub-sectors do (three rows nationally, on "SS+30"), and asking
 *  first is what keeps every other sector off the ring walk below. */
function needsSunPosition(hours: SectorHours): boolean {
	return hours.winter.to.kind === 'sunset' || hours.summer.to.kind === 'sunset';
}

/** The position a sunset-relative closing time is resolved at: the sector's
 *  own ring centre. A sector is small enough that its centre and the crossing
 *  point differ by about a minute of sunset. Null when the row is not to hand
 *  or carries no ring, which leaves the schedule unresolved and so leaves the
 *  frequency alone. */
function ringCentre(a: Airspace | undefined): { lat: number; lon: number } | null {
	if (!a || a.ring.length === 0) {
		return null;
	}
	let lat = 0;
	let lon = 0;
	for (const [y, x] of a.ring) {
		lat += y;
		lon += x;
	}
	return { lat: lat / a.ring.length, lon: lon / a.ring.length };
}

/** Does the NOTAM's own validity reach into the evaluation range? The
 *  frequency overrides are gated on this too: a future-dated change must not
 *  move a frequency today (this module used to apply them date-blind). */
function validIn(n: Notam, at: ResolveAt): boolean {
	const { start, end } = notamSpanMs(n);
	return start <= at.toMs && end >= at.fromMs;
}

/** What a non-applied frequency-change flag can say. Data only (kind +
 *  params); the wording is derived at render through t.detail.freqFlag*
 *  (docs/i18n.md rule 7), so an open panel re-renders on a locale switch.
 *  `label` is verbatim NOTAM text, `freq` is preformatted (3-dp MHz). */
export type FreqFlagInfo =
	| { kind: 'change' }
	| { kind: 'label'; label: string; freq: string }
	| { kind: 'value'; freq: string }
	/** A service closure that could NOT be applied (hedged wording, no stated
	 *  frequency, an unparseable D) schedule, or a stated value no loaded row
	 *  publishes): the outage may be real, so it is surfaced, but no frequency
	 *  is silenced on it. */
	| { kind: 'closure'; freq: string | null };

/** A detected frequency change that was NOT applied to a row: an unmatched /
 *  ambiguous service label, a conflicting second change, or a bare "frequency
 *  changed" notice with no usable value. Shown beside the radios with a link to
 *  the NOTAM, never applied. */
export interface FreqChangeFlag {
	source: IndexedNotam;
	/** Best-effort description: a labelled "<label>: <freq>" pair, a bare new
	 *  value, or a value-less change notice. */
	info: FreqFlagInfo;
}

/** Locale-independent identity for a flag (list keys; the rendered wording is
 *  locale-bound and must not key the rows). */
export function freqFlagKey(f: FreqChangeFlag): string {
	const i = f.info;
	const label = i.kind === 'label' ? i.label : '';
	const freq = i.kind === 'change' ? '' : (i.freq ?? '');
	return `${f.source.notam.id}|${i.kind}|${label}|${freq}`;
}

/** Wording for a non-applied flag; reads t at call time (call from a template
 *  or $derived), so an open panel follows the locale (docs/i18n.md rule 7). */
export function flagText(info: FreqFlagInfo): string {
	if (info.kind === 'label') {
		return t.detail.freqFlagLabelled({ label: info.label, freq: info.freq });
	}
	if (info.kind === 'value') {
		return t.detail.freqFlagValue(info.freq);
	}
	if (info.kind === 'closure') {
		return info.freq != null
			? t.detail.freqFlagClosureValue(info.freq)
			: t.detail.freqFlagClosure;
	}
	return t.detail.freqFlagChange;
}

export interface FreqResolution<R> {
	radios: R[];
	flags: FreqChangeFlag[];
}

/** Idents (A) codes) of the currently visible frequency-change NOTAMs. Callers
 *  use it as a cheap gate, resolving overrides only for the few affected
 *  features instead of running the resolver for every airport / airspace. Reads
 *  filteredNotams(), so it is reactive; call inside a $derived. */
export function freqChangeIdents(): Set<string> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local index, rebuilt on read
	const s = new Set<string>();
	for (const it of filteredNotams()) {
		if (isFrequencyChangeQCode(it.notam.qCode)) {
			for (const c of it.notam.icaoCodes) {
				s.add(c.toUpperCase());
			}
		}
	}
	return s;
}

/** True when this NOTAM asserts an FIS outage: the closure family's source
 *  gate. serviceStatus is the parser's condition-plus-text classification
 *  (notam/serviceStatus.ts): a condition-stated outage (QSEAU) is
 *  authoritative and may CLOSE rows; a text-only one ("POTENTIALLY NOT AVBL"
 *  under QSELT) can only flag, which applyClosures enforces through the
 *  `authoritative` bit. */
function isFisOutage(n: Notam): boolean {
	return isFlightInfoServiceQCode(n.qCode) && n.serviceStatus === 'unserviceable';
}

/** Idents of the currently visible FIS service-closure NOTAMs, the cheap gate
 *  beside freqChangeIdents. Reads filteredNotams(); call inside a $derived. */
export function closureIdents(): Set<string> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local index, rebuilt on read
	const s = new Set<string>();
	for (const it of filteredNotams()) {
		if (isFisOutage(it.notam)) {
			for (const c of it.notam.icaoCodes) {
				s.add(c.toUpperCase());
			}
		}
	}
	return s;
}

/** A route's airspace schedule (from computeAirspaceSchedule) with frequency-change
 *  NOTAMs applied to each crossed airspace's radio, so the radio reads its current
 *  value (a SIV frequency NOTAM moves SEINE 4/5 here too), and with the radio of a
 *  sector outside its published hours withdrawn. Call inside a $derived.
 *
 *  Returns the schedule ARRAY ITSELF when nothing moved, not a fresh copy of it.
 *  navLive's span memo keys on that identity (`spanEntry.schedule !== resolved`)
 *  to keep buildContactSpans off the 1 Hz path, so a per-call allocation would
 *  rebuild the spans, the closed spans and the event index on EVERY fix. The
 *  common case is nothing moving: a visible frequency NOTAM elsewhere in France,
 *  or a route merely crossing a sector that publishes hours, must not cost that.
 *  A real change still hands back a fresh array, which is what makes the memo
 *  notice it. */
export function resolveScheduleRadios(
	schedule: RouteAirspaceEvent[],
	airspaces: Airspace[],
	at: ResolveAt = defaultAt(),
	hoursAt: ResolveAt = defaultFlightAt(),
): RouteAirspaceEvent[] {
	const hasNotams = freqChangeIdents().size > 0 || closureIdents().size > 0;
	// The FIS sectors that publish a schedule this can read, which is 12 of the
	// 110 French rows (the other 46 non-permanent ones state no text and stay
	// unknown, i.e. assumed open). parseSectorHours is memoised on its two
	// strings, so this costs a map lookup per event rather than a parse.
	const hours = schedule.map((ev) =>
		ev.category === 'siv' ? parseSectorHours(ev.workHr, ev.rmkWorkHr) : null,
	);
	const hasHours = hours.some((h) => h != null && h !== 'always');
	if (!hasNotams && !hasHours) {
		return schedule;
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local lookup index, not reactive
	const byKey = new Map(airspaces.map((a) => [a.key, a]));
	let moved = false;
	const out = schedule.map((ev, i) => {
		// A sector off watch over the flight publishes no frequency to set, so
		// it yields no contact and does not suppress the FIR-level blanket
		// underneath: over Pontoise on a Monday, LE BOURGET Information is shut
		// (SAT-SUN) and PARIS Information is the FIS. Emptying the radio is all
		// it takes; every gate downstream already skips an event with none, and
		// 18 rows carried none at all until the <Activite> path filled them.
		// Unknown never withdraws anything (sectorActiveIn returns null).
		//
		// Judged on the EVENT's own published hours, so it stands whether or not
		// the airspace is still in the array; only a sunset-relative closing
		// time needs the row itself, for a position to resolve it at.
		const h = hours[i];
		if (h != null && h !== 'always') {
			const pos = needsSunPosition(h) ? ringCentre(byKey.get(ev.key)) : null;
			if (sectorActiveIn(h, hoursAt, pos) === false) {
				moved = true;
				return { ...ev, radio: [] };
			}
		}
		const a = byKey.get(ev.key);
		if (!hasNotams || !a) {
			return ev;
		}
		// Narrow to the RAI entry by its original index (resolveAirspaceRadios
		// preserves order), so an override on the RAI shows here while a change to
		// a non-RAI lumped frequency is ignored. ev.radio is already RAI-narrowed
		// by makeEvent, so the untouched branch returns it unchanged.
		const radios = narrowToRai(resolveAirspaceRadios(a, at).radios, raiRadioIndex(a));
		if (!radios.some((r) => r.override || r.closed)) {
			return ev;
		}
		moved = true;
		return { ...ev, radio: radios };
	});
	return moved ? out : schedule;
}

/** The E) section of a NOTAM (whitespace-normalised by the parser), or ''. */
function eTextOf(notam: Notam): string {
	return notamEText(notam);
}

/** The D) item's text, or null when the NOTAM has none (the validity alone
 *  then schedules it). */
function dTextOf(notam: Notam): string | null {
	const d = notamSections(notam).D;
	return d != null && d.trim() !== '' ? d : null;
}

/** Whether a closure NOTAM is in force over `at`: its B)/C) validity AND its
 *  D) schedule. null = unknown (a D) item outside the parsed subset), which
 *  the application ladder turns into a flag, never a closure. */
function closureActiveIn(notam: Notam, at: ResolveAt): boolean | null {
	const d = dTextOf(notam);
	return scheduleActiveIn(notamSpanMs(notam), d == null ? undefined : parseItemD(d), {
		fromMs: at.fromMs,
		toMs: at.toMs,
	});
}

/** One entry per source NOTAM, keep-first: a multi-area NOTAM parses into
 *  several entries sharing an id (the notamsByIdent gotcha), and running its
 *  assignments once per entry would hit the already-overridden row on the
 *  second pass and push a contradictory duplicate-key flag. */
function dedupeById(sources: readonly IndexedNotam[]): IndexedNotam[] {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient dedup probe, not state
	const seen = new Set<string>();
	const out: IndexedNotam[] = [];
	for (const src of sources) {
		if (!seen.has(src.notam.id)) {
			seen.add(src.notam.id);
			out.push(src);
		}
	}
	return out;
}

/** Map a printed service label ("MELUN TWR", "AFIS MELUN INFORMATION",
 *  "ABSENCE ATS A/A") to the canonical radio unit used in the datasets, or null
 *  when it is not a recognised COM service (e.g. "STAP ABSENCE ATS"). Both the
 *  NOTAM label and the row's `unit` pass through this, so "TOUR"/"TWR" and the
 *  bilingual variants line up. Checked most-specific first (ATIS / AFIS before
 *  TWR; INFO last) so "AFIS ... INFORMATION" resolves to AFIS, not INFO. */
function canonicalUnit(label: string): string | null {
	const u = label.toUpperCase();
	if (/\bATIS\b/.test(u)) return 'ATIS';
	if (/\bAFIS\b/.test(u)) return 'AFIS';
	if (/\bA\s*\/\s*A\b/.test(u) || /\bAIR\s*\/\s*AIR\b/.test(u) || /AUTO-?INFO/.test(u)) {
		return 'A/A';
	}
	if (/\bTWR\b|\bTOUR\b|\bTOWER\b/.test(u)) return 'TWR';
	if (/\bGND\b|\bSOL\b|\bGROUND\b/.test(u)) return 'GND';
	if (/\bDEL\b|DELIVERY|PRE-?VOL|\bCLNC\b|\bCLR\b/.test(u)) return 'DEL';
	if (/\bDEP\b|DEPARTURE|DEPART\b/.test(u)) return 'DEP';
	if (/\bARR\b|ARRIVAL|ARRIVEE/.test(u)) return 'ARR';
	if (/\bAPP\b|APPROACH|APPROCHE/.test(u)) return 'APP';
	if (/\bGONIO\b|\bVDF\b/.test(u)) return 'GONIO';
	if (/\bACS\b/.test(u)) return 'ACS';
	if (/\bFIS\b/.test(u)) return 'FIS';
	if (/\bINFO\b|INFORMATION/.test(u)) return 'INFO';
	return null;
}

/** The rows publishing `freq` that no NOTAM has moved yet. A stated old value
 *  names the CHANNEL, not one service, and several services legitimately share
 *  one: a French field converting to 8.33 kHz lists its A/A, VDF, AFIS and TWR
 *  against a single pair (B0367/26 LFOK), and they all move together. Rows an
 *  earlier NOTAM already overrode are left out, so the "never double-apply"
 *  rule survives. */
function rowsOn(radios: readonly EffectiveAirportRadio[], freq: string): number[] {
	const want = formatFreqMHz(freq);
	const hits: number[] = [];
	radios.forEach((r, i) => {
		if (!r.override && formatFreqMHz(r.freq) === want) {
			hits.push(i);
		}
	});
	return hits;
}

/** The single row whose service unit the label names, or null when the label
 *  names no known service or several rows answer to it (caller flags it). */
function unitIndex(radios: readonly AirportRadio[], label: string): number | null {
	const cu = canonicalUnit(label);
	if (!cu) {
		return null;
	}
	const hits: number[] = [];
	radios.forEach((r, i) => {
		if (canonicalUnit(r.unit) === cu) {
			hits.push(i);
		}
	});
	return hits.length === 1 ? hits[0] : null;
}

/** The rows assignment `a` moves, [] when it names none (caller flags it).
 *
 *  The stated old value is the precise selector, so it decides first, and it
 *  decides for EVERY row still publishing it, the printed service label
 *  notwithstanding. Two rows of one aerodrome on one frequency are one
 *  transmitter under two service names, never two services that happen to
 *  coincide: all 569 such groups across the eleven airports datasets are one
 *  station (APP with TWR, APP with DEP, DEL with GND, A/A with AFIS, and down
 *  to Munich radar filed as both APP and ACS), so a channel moves whole.
 *  Narrowing to the labelled row would leave its sibling on a frequency
 *  nobody answers, which is the very failure the SIA writes "A/A, VDF ET
 *  TWR ... LIRE 129.405MHZ AU LIEU DE 129.400MHZ" to prevent.
 *
 *  With no old value stated, or none that any row still publishes (a stale
 *  baseline), the label's canonical unit decides and must match exactly one
 *  row. */
function concernedRows(radios: readonly EffectiveAirportRadio[], a: FreqAssignment): number[] {
	if (a.was) {
		const hits = rowsOn(radios, a.was);
		if (hits.length > 0) {
			return hits;
		}
	}
	const idx = unitIndex(radios, a.label);
	return idx === null || radios[idx].override ? [] : [idx];
}

/** Apply the frequency-change NOTAMs filed under this aerodrome (A) ident) to
 *  its radios. NOTAMs that name an airspace / SIV are deferred to
 *  resolveAirspaceRadios even when their A) is this airport (e.g. a SEINE SIV
 *  change filed under LFPM), so the two never double-apply. */
export function resolveAirportRadios(
	airport: Airport,
	at: ResolveAt = defaultAt(),
): FreqResolution<EffectiveAirportRadio> {
	const radios: EffectiveAirportRadio[] = airport.radios.map((r) => ({ ...r }));
	const flags: FreqChangeFlag[] = [];
	const sources = dedupeById(notamsByIdent().get(airport.ident.toUpperCase()) ?? []);
	for (const src of sources) {
		if (!isFrequencyChangeQCode(src.notam.qCode) || !validIn(src.notam, at)) {
			continue;
		}
		// strictOnly: a typed (type-word-adjacent, any-subject) name link must
		// never re-route a frequency change off the airport path.
		if (airspacesNamedByNotam(src.notam, true).length > 0) {
			continue;
		}
		const e = eTextOf(src.notam);
		const assignments = parseFreqAssignments(e);
		const replacements = allReplacements(e);
		if (assignments.length > 0) {
			applyAssignments(radios, flags, src, assignments);
		} else if (replacements.length > 0) {
			applyReplacements(radios, flags, src, replacements);
		} else if (isFrequencyChangeCondition(src.notam.qCode) && isComFacility(src.notam)) {
			// The NOTAM states no value this module can read, and the CONDITION
			// itself says a frequency moved: say so with no value, so the pilot
			// knows to open it. Gated on the condition, so an "installed" notice
			// (QCACS) that states no move stays silent: a State announcing a new
			// standby channel has changed no published row.
			flags.push({ source: src, info: { kind: 'change' } });
		}
	}
	return { radios, flags };
}

/** Is this NOTAM about a communications facility (Q-code subject letter 'C')?
 *  What an unplaceable value may be flagged against, so a navaid or lighting
 *  change filed under the same aerodrome never reads as an aerodrome-radio
 *  notice: a DME moving from 114.300 to 114.500 states two well-formed MHz
 *  values and concerns none of these rows. */
function isComFacility(n: Notam): boolean {
	return n.qCode[1] === 'C';
}

/** Can this NOTAM claim a frequency MOVED, when no row of ours took its value?
 *  A flag says "something here changed and I could not place it", and that
 *  claim needs a source: either the text states the value being replaced
 *  (`statesPrior`), or the Q-code condition itself reads "frequency changed".
 *  An air/ground facility INSTALLED (the QCACS admission) has neither, and its
 *  text is routinely a description of a NEW facility rather than a change to a
 *  published one ("NEW ATS COMMUNICATION FACILITIES INSTALLED ... FREQUENCY:
 *  121.500 MHZ, RMK: EMERGENCY", A2113/23 OITK, whose value is guard). Such a
 *  NOTAM still earns an override wherever its value lands on a row, which is
 *  a move we can SEE; what it does not earn is a notice about one we cannot.
 *  Read by BOTH resolvers, so the aerodrome radios and the FIS sectors cannot
 *  come to differ on what is worth saying. */
function claimsAMove(notam: Notam, statesPrior: boolean): boolean {
	return statesPrior || isFrequencyChangeCondition(notam.qCode);
}

/** Does this aerodrome already publish `freq`? Then the AIP has caught up with
 *  the NOTAM: the value it assigns is on the panel already, so there is
 *  nothing to move and nothing to warn about. Only ever asked once an
 *  assignment has failed to place, so it cannot pre-empt a real move; the
 *  NOTAM's own card still lists every service it names, verbatim. */
function alreadyInForce(radios: readonly EffectiveAirportRadio[], freq: string): boolean {
	const want = formatFreqMHz(freq);
	return radios.some((r) => formatFreqMHz(r.freq) === want);
}

/** Apply one NOTAM's LABELLED assignments: each moves the rows
 *  `concernedRows` names, and one that lands nowhere becomes a flag carrying
 *  the label and the value, provided it claims a move at all (claimsAMove).
 *
 *  Pairs already moved by this same NOTAM are skipped rather than flagged: one
 *  channel change is commonly restated under each service sharing the channel
 *  ("- PONTOISE TWR : 121.205MHZ AU LIEU DE 121.200MHZ" then the same values
 *  for PONTOISE GONIO, E3291/26), and the first statement has by then moved
 *  the row off the old value, so the second would otherwise read as a change
 *  the app failed to place. */
function applyAssignments(
	radios: EffectiveAirportRadio[],
	flags: FreqChangeFlag[],
	src: IndexedNotam,
	assignments: readonly FreqAssignment[],
): void {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local dedup probe, not state
	const moved = new Set<string>();
	for (const a of assignments) {
		const pair = a.was ? `${formatFreqMHz(a.was)}>${formatFreqMHz(a.freq)}` : '';
		const to = formatFreqMHz(a.freq);
		// A row already on the assigned value has nothing to change, so it is
		// dropped rather than stamped with an override reading "120.755 replaces
		// 120.755" (E1861/26 names a Toussus frequency the AIP already carries).
		const rows = concernedRows(radios, a).filter((i) => formatFreqMHz(radios[i].freq) !== to);
		if (rows.length === 0) {
			// Nothing left for this row to move. Silent when the value is already
			// what the aerodrome publishes, and silent when this NOTAM has just
			// made that same move under another service's name; otherwise the
			// value is surfaced with the label the NOTAM printed. The restatement
			// test is a FALLBACK, deliberately after the placement attempt: a
			// service published on a channel of its own is still its own row to
			// move, not a repeat of the previous line.
			if (
				claimsAMove(src.notam, a.was !== null) &&
				!alreadyInForce(radios, a.freq) &&
				!(pair !== '' && moved.has(pair))
			) {
				flags.push({ source: src, info: { kind: 'label', label: a.label, freq: to } });
			}
			continue;
		}
		for (const i of rows) {
			// The struck value is the one this row was PUBLISHING, not the one the
			// NOTAM names: they are the same wherever the stated old value placed
			// the row, and where the label placed it instead (a stale baseline)
			// the row's own value is what the panel was showing.
			radios[i] = {
				...radios[i],
				freq: a.freq,
				override: { source: src, was: formatFreqMHz(radios[i].freq) },
			};
		}
		if (pair !== '') {
			moved.add(pair);
		}
	}
}

/** Apply one NOTAM's bare new->old pairs, the shape whose values carry no
 *  per-row label.
 *
 *  What precedes such a value is a header naming every service concerned
 *  ("A/A, VDF, AFIS AND TWR VATRY MODIFIED : READ 129.405MHZ INSTEAD OF
 *  129.400MHZ", B0367/26 LFOK), so the OLD value places it and every row
 *  publishing that value moves, which is exactly the set the header lists. A
 *  pair no row publishes is flagged with its value rather than guessed at. */
function applyReplacements(
	radios: EffectiveAirportRadio[],
	flags: FreqChangeFlag[],
	src: IndexedNotam,
	replacements: readonly FreqReplacement[],
): void {
	for (const repl of replacements) {
		const rows = rowsOn(radios, repl.was);
		if (rows.length === 0) {
			// The subject gate is asked HERE and not of the labelled flag above,
			// deliberately: this value reaches the panel naked, so only the
			// Q-code can say it is about a radio at all, while a labelled one
			// carries the NOTAM's own service word and describes itself.
			if (!alreadyInForce(radios, repl.freq) && isComFacility(src.notam)) {
				flags.push({ source: src, info: { kind: 'value', freq: formatFreqMHz(repl.freq) } });
			}
			continue;
		}
		const was = formatFreqMHz(repl.was);
		for (const i of rows) {
			radios[i] = { ...radios[i], freq: repl.freq, override: { source: src, was } };
		}
	}
}

/** Apply the frequency-change NOTAMs that name this airspace / SIV sector to its
 *  radio rows. Scoped to the by-name link (notamNamesAirspace), the same one
 *  that lists the NOTAM under the airspace's "Affecting NOTAMs", so a mere
 *  geometric overlap of an unrelated QCACF never moves a frequency.
 *
 *  Two forms:
 *  - "READ <new> (INSTEAD OF <old>)" / "<new> REPLACES <old>": the old value is
 *    the precise selector. Only the rows currently on it move; a sector not on
 *    that frequency is simply not concerned (no flag, no change), so a NOTAM
 *    naming the whole SEINE base still moves only the 120.325 sector. Every
 *    pair the text states is applied, so a NOTAM moving two sectors at once
 *    does not leave the second stale.
 *  - a bare single value (no stated old): applied to the sector's sole radio; a
 *    change with several rows or a non-single value is flagged, not guessed. */
export function resolveAirspaceRadios(
	airspace: Airspace,
	at: ResolveAt = defaultAt(),
): FreqResolution<EffectiveAirspaceRadio> {
	let radios: EffectiveAirspaceRadio[] = airspace.radio.map((r) => ({ ...r }));
	const flags: FreqChangeFlag[] = [];
	// strictOnly: only the subject-gated name link moves a frequency; the
	// widened any-subject (typed) match lists the NOTAM but never applies it.
	const sources = dedupeById(
		notamsForAirspace(airspace.id).filter(
			(src) =>
				isFrequencyChangeQCode(src.notam.qCode) &&
				validIn(src.notam, at) &&
				notamNamesAirspace(src.notam, airspace, true),
		),
	);
	for (const src of sources) {
		const e = eTextOf(src.notam);
		const repls = allReplacements(e);
		if (repls.length > 0) {
			// Every pair the text states, and a row a pair has already moved is
			// out of reach of the next one. That guard is what makes a SWAP come
			// out right: C0438/26 exchanges the two Warsaw FIS sectors
			// (123.975 instead of 118.775, then 118.775 instead of 123.975), and
			// without it the second pair would put the first sector back.
			for (const repl of repls) {
				const was = formatFreqMHz(repl.was);
				radios.forEach((r, i) => {
					if (!r.override && formatFreqMHz(r.freq) === was) {
						radios[i] = { ...r, freq: repl.freq, override: { source: src, was } };
					}
				});
			}
			continue;
		}
		// Neither branch below has a prior value to point at, so both speak only
		// under a condition that says a frequency moved (claimsAMove): the
		// aerodrome side is silent for an "installed" notice it cannot place and
		// this side must be too.
		const freq = singleFreq(e);
		if (freq === null) {
			if (claimsAMove(src.notam, false)) {
				flags.push({ source: src, info: { kind: 'change' } });
			}
			continue;
		}
		if (radios.length === 1 && !radios[0].override) {
			radios[0] = {
				...radios[0],
				freq,
				override: { source: src, was: formatFreqMHz(radios[0].freq) },
			};
		} else if (claimsAMove(src.notam, false)) {
			flags.push({ source: src, info: { kind: 'value', freq: formatFreqMHz(freq) } });
		}
	}

	// SERVICE CLOSURES, the same strict name link the other way round: mark
	// the rows whose published frequency the NOTAM withdraws. Runs after the
	// overrides so a closure judges the row's EFFECTIVE value. The ladder
	// (authoritative condition, stated frequency, parsed schedule; anything
	// less flags) is pure in notam/serviceClosure.ts.
	const closureSources = dedupeById(
		notamsForAirspace(airspace.id).filter(
			(src) => isFisOutage(src.notam) && notamNamesAirspace(src.notam, airspace, true),
		),
	);
	if (closureSources.length > 0) {
		const candidates: ClosureCandidate<IndexedNotam>[] = closureSources
			.filter((src) => validIn(src.notam, at))
			.map((src) => ({
				source: src,
				closure: parseServiceClosure(eTextOf(src.notam)),
				active: closureActiveIn(src.notam, at),
				authoritative: isUnserviceableCondition(src.notam.qCode),
			}));
		const applied = applyClosures(radios, candidates);
		radios = applied.radios;
		for (const f of applied.flags) {
			flags.push({
				source: f.source,
				info: { kind: 'closure', freq: f.freq != null ? formatFreqMHz(f.freq) : null },
			});
		}
	}
	return { radios, flags };
}
