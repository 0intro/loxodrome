/* One aerodrome's NOTAMs, fetched fresh, put into a loaded briefing.
 *
 * The airport panel fetches the NOTAMs FILED UNDER one aerodrome (Item A)
 * and the briefing already holds some of them, from an older fetch, another
 * source or a paste. Appending would be wrong twice over: a NOTAM cancelled
 * since stays, and one whose text differs between the two copies (SOFIA's
 * French E) against autorouter's English one) shows twice, the parser keeping
 * a body it has not seen under its id and relabelling it `LFPN-A1234/26`. So
 * the answer REPLACES what it speaks for, and nothing else:
 *
 *  - a loaded NOTAM the answer carries is replaced IN PLACE by its fresh copy,
 *    so a refresh whose answer is unchanged leaves the parse identical, ids
 *    included (the parser labels a number two States share by which comes
 *    first, and moving a NOTAM would move the label);
 *  - one the answer's NOTAMR supersedes is withdrawn;
 *  - one missing from the answer is withdrawn only when the answer would have
 *    carried it: the source's own selection covers it (`covers`), it came from
 *    that same source (`sameSource`), and the answer is not empty. Absence
 *    from ANOTHER source proves nothing: EAD has been measured short of the
 *    French AIS at aerodromes asked for by name (E3285 LFPL, F1341 / F1645
 *    LFPN; docs/notam-source-comparison.md), and an empty answer is likelier a
 *    hole in coverage than every NOTAM cancelled at once. Such a NOTAM is
 *    kept and listed as unconfirmed; one the selection does not cover (outside
 *    its window, its schedule off) is kept and listed as such;
 *  - a NOTAM new to the briefing goes at the end, so no NOTAM already there
 *    changes label.
 *
 * Everything filed elsewhere is left byte for byte, and a block's own text is
 * cut whole (notamBlocks: from its header to the next), which leaves every
 * other block parsing exactly as before. Pure: the rules come in as
 * predicates, so this module knows no source, no window and no state.
 */

import { icaoCodesFromA, notamBlocks, parseNotams, parseSections } from './parser';
import type { Notam, ParseOptions } from './types';

/** A NOTAM id without the location a briefing may write before it: a pasted
 *  SOFIA bulletin says `LFFA-A1234/25` where the app's reconstructions say
 *  `A1234/25`, and the parser qualifies a collision as `LFPN-A1234/25`. */
export function bareNotamId(id: string): string {
	return id
		.trim()
		.replace(/^(?:[A-Z]{4}[\s-]+)+/i, '')
		.toUpperCase();
}

export interface SpliceRules {
	/** Would the answer have carried this loaded NOTAM, were it still in
	 *  force? true: its selection covers it; false: it does not (outside the
	 *  window, a schedule off for all of it); null: no telling (an unreadable
	 *  schedule, a scope the source selects some other way). */
	covers: (n: Notam) => boolean | null;
	/** Did this loaded NOTAM come from the source that answered? Only then
	 *  does its absence from the answer say it is gone. */
	sameSource: (n: Notam) => boolean;
	parse?: ParseOptions;
}

export interface AerodromeSplice {
	/** The briefing with the answer in. */
	text: string;
	/** NOTAMs filed under the ident in the answer that yield an entry: the
	 *  number the airport panel can list. */
	count: number;
	/** The answer's NOTAMs as `IDENT|bare id`, the briefing's origin key. */
	freshKeys: string[];
	/** Loaded NOTAMs the answer removed: missing from it while covered, or
	 *  superseded by one of its NOTAMR. Ids as the briefing wrote them. */
	withdrawn: string[];
	/** Loaded NOTAMs kept although the answer lacks them: another source's,
	 *  a pasted one, one whose coverage cannot be told, or any at all when the
	 *  answer is empty. */
	unconfirmed: string[];
	/** Loaded NOTAMs kept because the answer does not speak for them. */
	kept: string[];
	/** Answer records refused: not exactly one NOTAM filed under the ident (a
	 *  record reconstructed without an id line has no header, and the parser
	 *  would glue it onto whichever NOTAM precedes it). */
	refused: number;
}

type Fate = 'replace' | 'withdraw' | 'unconfirmed' | 'kept';

/** Put `answer`, the fresh NOTAMs filed under `ident` (one ICAO text block
 *  each), into `briefing`. */
export function spliceAerodromeNotams(
	briefing: string,
	ident: string,
	answer: readonly string[],
	rules: SpliceRules,
): AerodromeSplice {
	const x = ident.trim().toUpperCase();
	const opts = rules.parse ?? {};
	// The location check reads the A) item, so a NOTAM merely CITING the
	// ident in its text is not one of its own; the substring test only spares
	// the section parse for the thousands of blocks that cannot match.
	const filedUnder = (content: string): boolean =>
		content.toUpperCase().includes(x) &&
		icaoCodesFromA(parseSections(content).A).some((c) => c.toUpperCase() === x);

	// The answer, one copy per NOTAM, keyed by bare id.
	const fresh = new Map<string, string>();
	const superseded = new Set<string>();
	let count = 0;
	let refused = 0;
	for (const record of answer) {
		const blocks = notamBlocks(record);
		const only = blocks.length === 1 ? blocks[0] : undefined;
		if (!only || !filedUnder(only.content)) {
			refused++;
			continue;
		}
		const key = bareNotamId(only.id);
		if (fresh.has(key)) {
			continue;
		}
		const text = record.slice(only.start).trim();
		fresh.set(key, text);
		const entries = parseNotams(text, opts);
		if (entries.length > 0) {
			count++;
		}
		const replaces = entries[0]?.replaces;
		if (replaces) {
			superseded.add(bareNotamId(replaces));
		}
	}
	const empty = fresh.size === 0;

	const fateOf = (key: string, slice: string): Fate => {
		if (fresh.has(key)) {
			return 'replace';
		}
		if (superseded.has(key)) {
			return 'withdraw';
		}
		// Parsed alone it reads exactly as it does in the briefing; a block
		// with no entry draws nothing anywhere, so there is nothing to judge.
		const entry = parseNotams(slice, opts)[0];
		if (!entry) {
			return 'kept';
		}
		const covered = rules.covers(entry);
		if (covered === false) {
			return 'kept';
		}
		if (covered === null || empty || !rules.sameSource(entry)) {
			return 'unconfirmed';
		}
		return 'withdraw';
	};

	const fates = new Map<string, Fate>();
	const withdrawn: string[] = [];
	const unconfirmed: string[] = [];
	const kept: string[] = [];
	const placed = new Set<string>();
	let out = '';
	let at = 0;
	for (const block of notamBlocks(briefing)) {
		if (!filedUnder(block.content)) {
			continue;
		}
		const key = bareNotamId(block.id);
		const slice = briefing.slice(block.start, block.end);
		// Decided once per NOTAM, so the repeats of one NOTAM a briefing can
		// carry share its fate.
		let fate = fates.get(key);
		if (fate === undefined) {
			fate = fateOf(key, slice);
			fates.set(key, fate);
			if (fate === 'withdraw') {
				withdrawn.push(block.id);
			} else if (fate === 'unconfirmed') {
				unconfirmed.push(block.id);
			} else if (fate === 'kept') {
				kept.push(block.id);
			}
		}
		if (fate === 'kept' || fate === 'unconfirmed') {
			continue;
		}
		out += briefing.slice(at, block.start);
		at = block.end;
		if (fate === 'replace' && !placed.has(key)) {
			out += '\n\n' + (fresh.get(key) ?? '') + '\n';
			placed.add(key);
		} else {
			// A line break where the block was, so the text before the cut can
			// never run into the next header: a body ending on a four-letter
			// word reads as that header's location prefix across one newline.
			out += '\n';
		}
	}
	out += briefing.slice(at);

	const added = [...fresh].filter(([key]) => !placed.has(key)).map(([, text]) => text);
	if (added.length > 0) {
		const body = out.trimEnd();
		out = (body ? body + '\n\n' : '') + added.join('\n\n') + '\n';
	}

	return {
		text: out,
		count,
		freshKeys: [...fresh.keys()].map((key) => `${x}|${key}`),
		withdrawn,
		unconfirmed,
		kept,
		refused,
	};
}
