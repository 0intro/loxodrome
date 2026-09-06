/* Frequency-change NOTAM -> radio overrides.
 *
 * A frequency-change NOTAM (isFrequencyChangeCondition) reassigns a published
 * COM frequency. This module overlays those changes onto the loaded radio rows
 * so the detail panels AND the nav-log show, and use, the NOTAM'd value with
 * its provenance. The pure value extraction lives in $lib/notam/freqChange.ts;
 * here each assignment is tied to a known radio row, reusing the SAME
 * NOTAM<->feature associations the panels already list under "Affecting
 * NOTAMs": airports by their A) ident (notamsByIdent), airspaces / SIV by name
 * (notamNamesAirspace).
 *
 * "Override when sure, else flag": an assignment is applied only when it
 * matches exactly one row (by the prior frequency it REPLACES, or by service
 * unit). Anything ambiguous, unmatched, value-less or conflicting is surfaced
 * as a flag with a link to the NOTAM, never silently applied (a NOTAM viewer
 * must not show a frequency it isn't sure of).
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
	freqReplacement,
	parseFreqAssignments,
	singleFreq,
	type FreqAssignment,
} from '$lib/notam/freqChange';
import { notamEText, notamSections } from '$lib/notam/sections';
import { isFlightInfoServiceQCode, isFrequencyChangeCondition, isUnserviceableCondition } from '$lib/notam/qcode';
import { parseItemD, scheduleActiveIn } from '$lib/notam/schedule';
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
	type IndexedNotam,
} from './notam.svelte';
import {
	airspacesNamedByNotam,
	notamNamesAirspace,
	notamsForAirspace,
} from './notamLinks.svelte';

/** Provenance for a radio row whose frequency a NOTAM currently overrides. */
export interface RadioOverride {
	/** The NOTAM that changed the frequency, with its index for navigateToNotam. */
	source: IndexedNotam;
	/** The prior frequency (3-dp) this replaces. The REPLACES form states it; the
	 *  others fall back to the row's own published value, so this is always set. */
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

/** Does the NOTAM's own validity reach into the evaluation range? The CF/ME
 *  overrides are gated on this too: a future-dated change must not move a
 *  frequency today (this module used to apply them date-blind). */
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
		if (isFrequencyChangeCondition(it.notam.qCode)) {
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
 *  value (a SIV frequency NOTAM moves SEINE 4/5 here too). Returned untouched when
 *  no such NOTAM is visible. Call inside a $derived. */
export function resolveScheduleRadios(
	schedule: RouteAirspaceEvent[],
	airspaces: Airspace[],
	at: ResolveAt = defaultAt(),
): RouteAirspaceEvent[] {
	if (freqChangeIdents().size === 0 && closureIdents().size === 0) {
		return schedule;
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local lookup index, not reactive
	const byKey = new Map(airspaces.map((a) => [a.key, a]));
	return schedule.map((ev) => {
		const a = byKey.get(ev.key);
		if (!a) {
			return ev;
		}
		// Narrow to the RAI entry by its original index (resolveAirspaceRadios
		// preserves order), so an override on the RAI shows here while a change to
		// a non-RAI lumped frequency is ignored. ev.radio is already RAI-narrowed
		// by makeEvent, so the untouched branch returns it unchanged.
		const radios = narrowToRai(resolveAirspaceRadios(a, at).radios, raiRadioIndex(a));
		return radios.some((r) => r.override || r.closed) ? { ...ev, radio: radios } : ev;
	});
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

/** Index in `radios` that assignment `a` applies to, or null when it matches
 *  zero or several rows (caller flags it). Prefers the exact prior-frequency
 *  match ("... REPLACES <old>"); falls back to the canonical service unit. */
function matchIndex(radios: readonly AirportRadio[], a: FreqAssignment): number | null {
	if (a.was) {
		const was = formatFreqMHz(a.was);
		const hits: number[] = [];
		radios.forEach((r, i) => {
			if (formatFreqMHz(r.freq) === was) {
				hits.push(i);
			}
		});
		if (hits.length === 1) {
			return hits[0];
		}
		if (hits.length > 1) {
			return null;
		}
		// `was` matched no row (stale baseline): fall through to the unit match.
	}
	const cu = canonicalUnit(a.label);
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
		if (!isFrequencyChangeCondition(src.notam.qCode) || !validIn(src.notam, at)) {
			continue;
		}
		// strictOnly: a typed (type-word-adjacent, any-subject) name link must
		// never re-route a frequency change off the airport path.
		if (airspacesNamedByNotam(src.notam, true).length > 0) {
			continue;
		}
		const assignments = parseFreqAssignments(eTextOf(src.notam));
		if (assignments.length === 0) {
			// No labelled value. Flag it only for a communications facility (Q-code
			// subject letter 'C'), so a navaid / lighting change filed under this
			// airport doesn't read as an aerodrome-radio notice.
			if (src.notam.qCode[1] === 'C') {
				flags.push({ source: src, info: { kind: 'change' } });
			}
			continue;
		}
		for (const a of assignments) {
			const idx = matchIndex(radios, a);
			if (idx === null || radios[idx].override) {
				flags.push({
					source: src,
					info: { kind: 'label', label: a.label, freq: formatFreqMHz(a.freq) },
				});
				continue;
			}
			radios[idx] = {
				...radios[idx],
				freq: a.freq,
				override: { source: src, was: formatFreqMHz(a.was ?? radios[idx].freq) },
			};
		}
	}
	return { radios, flags };
}

/** Apply the frequency-change NOTAMs that name this airspace / SIV sector to its
 *  radio rows. Scoped to the by-name link (notamNamesAirspace), the same one
 *  that lists the NOTAM under the airspace's "Affecting NOTAMs", so a mere
 *  geometric overlap of an unrelated QCACF never moves a frequency.
 *
 *  Two forms:
 *  - "READ <new> (INSTEAD OF <old>)" / "<new> REPLACES <old>": the old value is
 *    the precise selector. Only the row currently on it moves; a sector not on
 *    that frequency is simply not concerned (no flag, no change), so a NOTAM
 *    naming the whole SEINE base still moves only the 120.325 sector.
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
				isFrequencyChangeCondition(src.notam.qCode) &&
				validIn(src.notam, at) &&
				notamNamesAirspace(src.notam, airspace, true),
		),
	);
	for (const src of sources) {
		const e = eTextOf(src.notam);
		const repl = freqReplacement(e);
		if (repl) {
			const was = formatFreqMHz(repl.was);
			radios.forEach((r, i) => {
				if (!r.override && formatFreqMHz(r.freq) === was) {
					radios[i] = { ...r, freq: repl.freq, override: { source: src, was } };
				}
			});
			continue;
		}
		const freq = singleFreq(e);
		if (freq === null) {
			flags.push({ source: src, info: { kind: 'change' } });
			continue;
		}
		if (radios.length === 1 && !radios[0].override) {
			radios[0] = {
				...radios[0],
				freq,
				override: { source: src, was: formatFreqMHz(radios[0].freq) },
			};
		} else {
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
