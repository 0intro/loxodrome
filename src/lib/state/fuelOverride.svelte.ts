/* Fuel a NOTAM has withdrawn, over the fuel the AIP publishes.
 *
 * The published side is `fr-fuel.json` (docs/fr-fuel.md), which is the state
 * of the world at the last AIRAC cycle. A NOTAM is how the state of the world
 * changes between cycles, and a fuel one that says a grade is out has to
 * reach the panel, or the chip goes on saying an aerodrome sells something it
 * has not sold for a month.
 *
 * "Withdraw when sure, else say so", which is the frequency resolver's
 * doctrine in this feature's terms. A grade is struck only where the NOTAM
 * says plainly that it is out; a statement that is qualified, that names a
 * grade the aerodrome does not publish, or whose schedule cannot be read
 * becomes a NOTE beside the chips, linked to its NOTAM. The dangerous state -
 * a chip reading "available" with nothing beside it - therefore never occurs,
 * which is why the grammar can afford to refuse (notam/fuelChange.ts).
 *
 * Reactive by construction: the sources come through notamsByIdent(), built
 * off filteredNotams(), so the data filters propagate and notamState.tick
 * carries the day boundaries. Call inside a $derived.
 */

import { dedupeById } from '$lib/data/dedup';
import {
	applyFuelChange,
	parseFuelChange,
	type FuelNote,
	type FuelNoteKind,
} from '$lib/notam/fuelChange';
import { isFuelQCode } from '$lib/notam/qcode';
import { parseItemD, scheduleActiveIn } from '$lib/notam/schedule';
import { notamSections } from '$lib/notam/sections';
import type { Notam } from '$lib/notam/types';
import {
	gradeCovers,
	gradeLabel,
	isFuelGrade,
	type AerodromeFuel,
	type FuelGrade,
	type FuelOffer,
} from '$lib/data/fuel';
import { fuelForIdent } from './aerodromeFuel.svelte';
import { activeEvalWindow, filteredNotams, notamsByIdent, notamSpanMs } from './notam.svelte';
import type { IndexedNotam } from './notam.svelte';
import { t } from './i18n.svelte';
import type { ResolveAt } from './freqOverride.svelte';

/** One published grade, with the NOTAM that withdrew it where one did. */
export type EffectiveFuelOffer = FuelOffer & { withdrawn?: IndexedNotam };

/** An aerodrome's fuel as it stands today: the AIP row, with the grades a
 *  NOTAM has withdrawn marked.
 *
 *  `avail` is NOT rewritten when every grade is withdrawn. That field means
 *  "the AIP states this field is dry", which is what the panel's own wording
 *  says and what the fuel plan branches on, and a dated NOTAM saying
 *  otherwise is a different fact with a different lifetime and a link.
 *  `withdrawnAll` carries that instead. */
export interface EffectiveAerodromeFuel extends Omit<AerodromeFuel, 'grades'> {
	grades: EffectiveFuelOffer[];
	/** The NOTAM that withdrew the whole supply, if one did. */
	withdrawnAll?: IndexedNotam;
}

export type { FuelNoteKind };
export type AerodromeFuelNote = FuelNote<IndexedNotam>;

export interface FuelResolution {
	fuel: EffectiveAerodromeFuel | null;
	notes: AerodromeFuelNote[];
}

const NONE: FuelResolution = { fuel: null, notes: [] };

/** The aerodromes any loaded fuel NOTAM speaks about.
 *
 *  The cheap gate every consumer reads before resolving: the Airports tab and
 *  the fuel plan ask about aerodromes by the hundred, and all but a handful
 *  have no fuel NOTAM at all. Rebuilt on read, like freqChangeIdents. */
export function fuelNotamIdents(): Set<string> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local index, rebuilt on read
	const out = new Set<string>();
	for (const it of filteredNotams()) {
		if (isFuelQCode(it.notam.qCode) && it.notam.serviceStatus === 'unserviceable') {
			for (const code of it.notam.icaoCodes) {
				out.add(code.toUpperCase());
			}
		}
	}
	return out;
}

function defaultAt(): ResolveAt {
	const w = activeEvalWindow();
	return { fromMs: w.from, toMs: w.to };
}

/** The NOTAM's own B)/C) validity must reach into the range being asked
 *  about: a withdrawal that ended last week does not strike a chip today. */
function validIn(n: Notam, at: ResolveAt): boolean {
	const { start, end } = notamSpanMs(n);
	return start <= at.toMs && end >= at.fromMs;
}

/** Whether the NOTAM is in force over `at`: its validity AND its D) day
 *  schedule. null = unknown (a D) item outside the parsed subset), which the
 *  ladder turns into a note and never into a withdrawal. */
function activeIn(n: Notam, at: ResolveAt): boolean | null {
	const d = notamSections(n).D;
	const item = d != null && d.trim() !== '' ? parseItemD(d) : undefined;
	return scheduleActiveIn(notamSpanMs(n), item, { fromMs: at.fromMs, toMs: at.toMs });
}

/**
 * An aerodrome's published fuel, narrowed by the NOTAMs in force.
 *
 * Returns the published row ITSELF when no NOTAM touched it. That identity is
 * load-bearing: the Airports tab runs this per row on every keystroke, and a
 * fresh object per call would defeat every memo downstream of it.
 */
export function resolveAerodromeFuel(
	ident: string,
	source: string | null | undefined,
	at: ResolveAt = defaultAt(),
): FuelResolution {
	const published = fuelForIdent(ident, source);
	if (!published) {
		return NONE;
	}
	const sources = dedupeById(notamsByIdent().get(ident.toUpperCase()) ?? []);
	const candidates = [];
	for (const src of sources) {
		const n = src.notam;
		if (!isFuelQCode(n.qCode) || n.serviceStatus !== 'unserviceable' || !validIn(n, at)) {
			continue;
		}
		const statements = parseFuelChange(notamSections(n).E ?? '');
		if (statements.length > 0) {
			candidates.push({ source: src, statements, active: activeIn(n, at) });
		}
	}
	if (candidates.length === 0) {
		return { fuel: published, notes: [] };
	}

	// The extractor speaks bare strings; a code this build's vocabulary does
	// not carry is ignored rather than coerced into it.
	const covers = (published: FuelGrade, stated: string): boolean =>
		isFuelGrade(stated) && gradeCovers(published, stated);
	const applied = applyFuelChange(published.grades, candidates, covers);
	if (applied.notes.length === 0 && !applied.offers.some((o) => o.withdrawn)) {
		return { fuel: published, notes: [] };
	}
	const fuel: EffectiveAerodromeFuel = { ...published, grades: applied.offers };
	if (applied.withdrawnAll) {
		fuel.withdrawnAll = applied.withdrawnAll;
	}
	return { fuel, notes: applied.notes };
}

/** A stable list key for a note. Locale-independent: the rendered wording is
 *  locale-bound and must not key the rows. */
export function fuelNoteKey(n: AerodromeFuelNote): string {
	return `${n.source.notam.id}|${n.kind}|${n.grades.join(',')}`;
}

/** The wording of a note, read at call time so an open panel follows a
 *  locale switch (docs/i18n.md rule 7). */
export function fuelNoteText(n: AerodromeFuelNote): string {
	// The label the chips wear, not the vocabulary code: one grade must not
	// read two ways in one panel.
	const grades = n.grades.map((g) => (isFuelGrade(g) ? gradeLabel(g) : g)).join(', ');
	switch (n.kind) {
		case 'partial':
			return grades ? t.detail.fuelNotePartialGrades(grades) : t.detail.fuelNotePartial;
		case 'unmatched':
			return t.detail.fuelNoteUnmatched(grades);
		case 'schedule':
			return t.detail.fuelNoteSchedule;
	}
}
