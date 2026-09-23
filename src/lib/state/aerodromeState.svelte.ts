/* An aerodrome closed by NOTAM, over the aerodrome the AIP publishes.
 *
 * The published side is the airports dataset, the state of the world at the
 * last AIRAC cycle. A field closes for a weekend air display, for works, for
 * a drone show, or for good, and between cycles nothing in the dataset says
 * so: eleven French fields stood closed on 2026-09-18 and the app offered
 * every one of them as a destination, a diversion and a performance
 * calculation (docs/notam-audit-2026-09.md).
 *
 * "Close when sure, else say so", the doctrine the frequency, fuel and runway
 * resolvers already keep. A field is closed only where a line closes it
 * outright; a line that closes it to visitors, or to VFR, or during a flight
 * campaign, or whose schedule cannot be read, becomes a NOTE beside the field
 * with its NOTAM. The dangerous state - a field reading open with nothing
 * beside it - therefore cannot occur, since every line naming the aerodrome
 * is either read or noted (notam/aerodromeClosure.ts).
 *
 * What this deliberately does NOT touch is `contactRadios`. That gate exists
 * for a field the AIP itself has closed, whose published channels are dead
 * (EDCK still carries Langen Information and nobody answers on it); a field
 * closed by NOTAM for three days has a tower that answers perfectly well, and
 * often the NOTAM's own text tells you to call it.
 *
 * Judged, by default, at drawnStateAt(), the instant the map draws its cross:
 * the panel's CLOSED BY NOTAM tag then says what the map says, and a field
 * shut 2100-0400 for works does not read as closed at noon. The phone's
 * diversion list passes the pose's instant (the band's), re-read every
 * minute. Never the briefing window, whose look-ahead is unbounded by
 * default and would mark a field shut today for a closure next month. The
 * performance page passes plannedFlightAt() (state/timeWindow.svelte.ts), the
 * planned flight's own span.
 *
 * Reactive by construction: the sources come through notamsByIdent(), built
 * off filteredNotams(), so the data filters propagate and notamState.tick
 * carries the day boundaries. Call inside a $derived. */

import { dedupeById } from '$lib/data/dedup';
import { isAerodromeQCode } from '$lib/notam/qcode';
import { parseAerodromeClosure } from '$lib/notam/aerodromeClosure';
import { notamEText } from '$lib/notam/sections';
import type { Airport } from '$lib/data/airports';
import { drawnStateAt, filteredNotams, notamsByIdent } from './notam.svelte';
import type { IndexedNotam } from './notam.svelte';
import { activeIn, validIn } from './notamActive';
import { t } from './i18n.svelte';
import type { ResolveAt } from './freqOverride.svelte';

/** Why a line about the aerodrome did not close it, said beside the field.
 *
 *  `partial`  the line restricts the field without closing it outright.
 *  `schedule` it closes it, but its D) item is outside the parsed subset. */
export type AerodromeNoteKind = 'partial' | 'schedule';

export interface AerodromeNote {
	kind: AerodromeNoteKind;
	/** The line itself, folded, so the panel can print what was refused. */
	line: string;
	notam: IndexedNotam;
}

export interface AerodromeResolution {
	/** The NOTAM closing the field, or null when none does. */
	closed: IndexedNotam | null;
	notes: AerodromeNote[];
}

/** The shared empty answer, so a caller's memo holds when nothing applies. */
const NONE: AerodromeResolution = { closed: null, notes: [] };

/** The aerodromes any loaded aerodrome-scope NOTAM speaks about.
 *
 *  The cheap gate every consumer reads before resolving: the Airports tab and
 *  the nearest-aerodrome scan ask about fields by the hundred, and all but a
 *  handful have no QFA NOTAM at all. Rebuilt on read, like freqChangeIdents,
 *  fuelNotamIdents and runwayNotamIdents. */
export function aerodromeNotamIdents(): Set<string> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local index, rebuilt on read
	const out = new Set<string>();
	for (const it of filteredNotams()) {
		if (isAerodromeQCode(it.notam.qCode)) {
			for (const code of it.notam.icaoCodes) {
				out.add(code.toUpperCase());
			}
		}
	}
	return out;
}

function defaultAt(): ResolveAt {
	return drawnStateAt();
}

/**
 * An aerodrome's operational state as it stands today: the NOTAM that closed
 * it, and what the lines that closed it say without closing it.
 *
 * Returns the shared empty answer when no NOTAM touched the field. That
 * identity is load-bearing: the Airports tab runs this per row on every
 * keystroke, and a fresh object per call would defeat every memo below it.
 */
export function resolveAerodromeState(
	airport: Airport,
	at: ResolveAt = defaultAt(),
): AerodromeResolution {
	const sources = dedupeById(notamsByIdent().get(airport.ident.toUpperCase()) ?? []);
	if (sources.length === 0) {
		return NONE;
	}
	let closed: IndexedNotam | null = null;
	const notes: AerodromeNote[] = [];
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local dedup
	const seen = new Set<string>();
	// One note per NOTAM per kind, not per LINE: the wording a note renders
	// says what the NOTAM does, not which sentence it did it in, so M2599/26's
	// two aerodrome lines would print the same sentence twice.
	const note = (kind: AerodromeNoteKind, line: string, src: IndexedNotam): void => {
		const key = `${src.notam.id}|${kind}`;
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		notes.push({ kind, line, notam: src });
	};
	for (const src of sources) {
		const n = src.notam;
		if (!isAerodromeQCode(n.qCode) || !validIn(n, at)) {
			continue;
		}
		// The field's own published name is what lets "TERRAIN NANCY-OCHEY
		// FERME" close it; without it the proper noun reads as a qualifier.
		const statements = parseAerodromeClosure(notamEText(n), airport.name);
		if (statements.length === 0) {
			continue;
		}
		// Asked once per NOTAM: the schedule belongs to the NOTAM, not to its
		// lines, and reading it per line would walk the calendar per line.
		let active: boolean | null | undefined;
		for (const s of statements) {
			if (s.kind === 'note') {
				note('partial', s.line, src);
				continue;
			}
			active ??= activeIn(n, at);
			if (active === null) {
				note('schedule', s.line, src);
				continue;
			}
			if (active === false) {
				continue;
			}
			// The FIRST closure in force wins, so the panel names one NOTAM
			// rather than the last one the index happened to hand back; the
			// others are already listed under "Affecting NOTAMs".
			closed ??= src;
		}
	}
	return closed === null && notes.length === 0 ? NONE : { closed, notes };
}

/** Is this field closed by NOTAM at the drawn instant (right now, unless the
 *  period says otherwise), or at `at`? The one-line form the scans read (the
 *  map's cross; the nearest-aerodrome diversion list, at the pose's instant),
 *  gated by the caller on `aerodromeNotamIdents()` so it costs nothing per
 *  row. */
export function aerodromeClosedByNotam(airport: Airport, at?: ResolveAt): boolean {
	return resolveAerodromeState(airport, at).closed !== null;
}

/** A stable key for a note, so an {#each} keeps its identity across ticks. */
export function aerodromeNoteKey(n: AerodromeNote): string {
	return `${n.notam.notam.id}|${n.kind}|${n.line}`;
}

/** The wording of a note, read at call time so an open panel follows a locale
 *  switch (docs/i18n.md rule 7). */
export function aerodromeNoteText(n: AerodromeNote): string {
	return n.kind === 'partial' ? t.detail.adNotePartial : t.detail.adNoteSchedule;
}
