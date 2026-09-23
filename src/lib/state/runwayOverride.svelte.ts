/* Runways a NOTAM has closed, over the runways the AIP publishes.
 *
 * The published side is the airports dataset, which is the state of the world
 * at the last AIRAC cycle. A runway closes for a week of works between
 * cycles, and an aerodrome panel that goes on offering it, or a performance
 * calculation that goes on computing a take-off run on it, is reading a month
 * out of date. 172 runway NOTAMs stood over France on 2026-09-18 and not one
 * of them changed anything the app said (docs/notam-audit-2026-09.md).
 *
 * "Close when sure, else say so", the doctrine the frequency and fuel
 * resolvers already keep. A runway end is struck only where a line closes it
 * outright; a line that closes it to landings, or to visitors, or by night,
 * or whose schedule cannot be read, becomes a NOTE beside the runway with its
 * NOTAM. The dangerous state - a runway reading open with nothing beside it -
 * therefore cannot occur, since every line naming a runway is either read or
 * noted (notam/runwayChange.ts).
 *
 * Judged, by default, at drawnStateAt(): the instant the map draws, so the
 * panel strikes the runway the map would and a nightly works closure does not
 * read as shut at noon. Never the briefing window, whose look-ahead is
 * unbounded by default and would apply next month's closure, or next month's
 * shorter declared distance, to today. The performance page passes
 * plannedFlightAt() (state/timeWindow.svelte.ts), the planned flight's own
 * span.
 *
 * Reactive by construction: the sources come through notamsByIdent(), built
 * off filteredNotams(), so the data filters propagate and notamState.tick
 * carries the day boundaries. Call inside a $derived. */

import { dedupeById } from '$lib/data/dedup';
import { isRunwayQCode, isDeclaredDistanceQCode } from '$lib/notam/qcode';
import { normalizeRunwayDesignator } from '$lib/notam/runwayRefs';
import { parseRunwayChange } from '$lib/notam/runwayChange';
import {
	parseDeclaredDistances,
	DISTANCE_KEYS,
	type DistanceKey,
} from '$lib/notam/declaredDistance';
import { notamEText } from '$lib/notam/sections';
import type { Airport } from '$lib/data/airports';
import { drawnStateAt, filteredNotams, notamsByIdent } from './notam.svelte';
import type { IndexedNotam } from './notam.svelte';
import { activeIn, validIn } from './notamActive';
import type { ResolveAt } from './freqOverride.svelte';

/** Why a runway line did not close anything, said beside the runway it named.
 *
 *  `partial`  the line restricts the runway without closing it.
 *  `schedule` it closes it, but its D) item is outside the parsed subset.
 *  `unmatched` it closes a designator this aerodrome does not publish.
 *  `unreadable` it restates declared distances in a form this cannot read,
 *              or for an end this aerodrome does not publish, so the
 *              published figures are contested rather than trusted. */
export type RunwayNoteKind = 'partial' | 'schedule' | 'unmatched' | 'unreadable';

export interface RunwayNote {
	kind: RunwayNoteKind;
	/** The designators the line named, as it named them. */
	ends: string[];
	notam: IndexedNotam;
}

/** The declared distances NOTAMs restate for one end, METRES. */
export interface DistanceOverride {
	/** Per distance, the SHORTEST figure any NOTAM in force states for this
	 *  end: two in force at once (a works phase and a displaced threshold)
	 *  cannot both be the runway, and the shorter is the one a take-off or a
	 *  landing must be measured against. */
	values: Partial<Record<DistanceKey, number>>;
	/** Which NOTAM each of those figures came from, so a cell names its own
	 *  source rather than whichever NOTAM happened to restate the end first. */
	from: Partial<Record<DistanceKey, IndexedNotam>>;
	/** The first NOTAM that restated the end: what a per-END mark names. */
	notam: IndexedNotam;
}

export interface RunwayResolution {
	/** Published runway end ('07', '25', '03R') -> the NOTAM closing it. */
	closed: Map<string, IndexedNotam>;
	/** Ends whose declared distances a NOTAM has restated, and by how much. */
	distances: Map<string, DistanceOverride>;
	/** Ends a declared-distance NOTAM names whose figures this could NOT
	 *  read. Unlike every other refusal in this family, silence here is not
	 *  safe: what stays on the panel and under the take-off calculation is
	 *  the AIP's own figure, which the NOTAM says is wrong and which is
	 *  usually LONGER. So the ends are marked contested rather than printed
	 *  plain (notam/declaredDistance.ts). */
	contested: Map<string, IndexedNotam>;
	notes: RunwayNote[];
}

/** The shared empty answer, so a caller's memo holds when nothing applies. */
const NONE: RunwayResolution = {
	closed: new Map(),
	distances: new Map(),
	contested: new Map(),
	notes: [],
};

/** The aerodromes any loaded runway NOTAM speaks about.
 *
 *  The cheap gate every consumer reads before resolving: the Airports tab and
 *  the performance page ask about aerodromes by the hundred, and all but a
 *  handful have no runway NOTAM at all. Rebuilt on read, like
 *  freqChangeIdents and fuelNotamIdents. */
export function runwayNotamIdents(): Set<string> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local index, rebuilt on read
	const out = new Set<string>();
	for (const it of filteredNotams()) {
		if (isRunwayQCode(it.notam.qCode) || isDeclaredDistanceQCode(it.notam.qCode)) {
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

/** Every runway end this airport publishes, normalised. */
function publishedEnds(airport: Airport): Set<string> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local index
	const out = new Set<string>();
	for (const r of airport.runways) {
		for (const end of [r.le, r.he]) {
			if (end) {
				out.add(normalizeRunwayDesignator(end));
			}
		}
	}
	return out;
}

/**
 * An aerodrome's runways as they stand today: which ends a NOTAM has closed,
 * and what the lines that closed none of them say.
 *
 * Returns the shared empty answer when no NOTAM touched the aerodrome. That
 * identity is load-bearing: the Airports tab runs this per row on every
 * keystroke, and a fresh object per call would defeat every memo below it.
 */
export function resolveAerodromeRunways(
	airport: Airport,
	at: ResolveAt = defaultAt(),
): RunwayResolution {
	const sources = dedupeById(notamsByIdent().get(airport.ident.toUpperCase()) ?? []);
	if (sources.length === 0) {
		return NONE;
	}
	const ends = publishedEnds(airport);
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local result
	const closed = new Map<string, IndexedNotam>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local result
	const distances = new Map<string, DistanceOverride>();
	// Every NOTAM contesting an end, in source order: a value read clears
	// only its OWN NOTAM's contest, so one NOTAM cannot vouch for another's.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local result
	const contesters = new Map<string, IndexedNotam[]>();
	const contest = (d: string, src: IndexedNotam): void => {
		const list = contesters.get(d);
		if (!list) {
			contesters.set(d, [src]);
		} else if (!list.includes(src)) {
			list.push(src);
		}
	};
	// Which NOTAMs READ a value for each end: those contests are answered.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local result
	const readers = new Map<string, Set<string>>();
	const notes: RunwayNote[] = [];
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local dedup
	const noteSeen = new Set<string>();
	const note = (kind: RunwayNoteKind, list: string[], src: IndexedNotam): void => {
		const key = `${src.notam.id}|${kind}|${list.join('/')}`;
		if (noteSeen.has(key)) {
			return;
		}
		noteSeen.add(key);
		notes.push({ kind, ends: list, notam: src });
	};
	// DECLARED DISTANCES first, so a closure later in the list can strike an
	// end whose figures this has already restated; the two are independent
	// facts about one end and a runway can be both shortened and shut.
	for (const src of sources) {
		const n = src.notam;
		if (!isDeclaredDistanceQCode(n.qCode) || !validIn(n, at) || activeIn(n, at) === false) {
			continue;
		}
		const scopes = parseDeclaredDistances(notamEText(n));
		// A declared-distance NOTAM this could not scope at all still says the
		// published figures changed, so the whole aerodrome is contested
		// rather than left reading as the AIP prints it (D0033/26 LFCN states
		// its distances the other way round, label before designator).
		if (scopes.length === 0) {
			for (const d of ends) {
				contest(d, src);
			}
			note('unreadable', [...ends], src);
			continue;
		}
		for (const s of scopes) {
			const mine = s.designators.filter((d) => ends.has(d));
			if (mine.length === 0) {
				// Figures for an end this aerodrome does not publish (a stale
				// designator, a 23 where the AIP has 23L / 23R): they cannot be
				// placed, and silence would leave the AIP's own, usually
				// longer, figures plain under the calculation. The whole field
				// is contested, as for a NOTAM this cannot scope at all; any
				// end this same NOTAM does read is answered below.
				for (const d of ends) {
					contest(d, src);
				}
				note('unreadable', s.designators, src);
				continue;
			}
			if (s.kind === 'note') {
				for (const d of mine) {
					contest(d, src);
				}
				continue;
			}
			for (const d of mine) {
				let r = readers.get(d);
				if (!r) {
					// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local result
					r = new Set<string>();
					readers.set(d, r);
				}
				r.add(n.id);
				const prev = distances.get(d);
				if (!prev) {
					const from: Partial<Record<DistanceKey, IndexedNotam>> = {};
					for (const k of DISTANCE_KEYS) {
						if (s.values[k] !== undefined) {
							from[k] = src;
						}
					}
					distances.set(d, { values: { ...s.values }, from, notam: src });
					continue;
				}
				// A later scope refines an earlier one rather than replacing
				// it (B1026/26 states TORA/TODA/ASDA for the pair and then RWY
				// 35's own LDA), and where two state the SAME distance the
				// shorter stands, whether they are one NOTAM's pair and end
				// scopes or two NOTAMs in force at once.
				for (const k of DISTANCE_KEYS) {
					const v = s.values[k];
					if (v === undefined) {
						continue;
					}
					const had = prev.values[k];
					if (had === undefined || v < had) {
						prev.values[k] = v;
						prev.from[k] = src;
					}
				}
			}
		}
	}
	// A value READ beats a scope of the SAME NOTAM that merely named the end
	// (A4717/26 states RWY 21's TODA and then says its end lighting is
	// unchanged; E0479/26 heads the pair before stating each end). It never
	// answers ANOTHER NOTAM's contest: a second NOTAM stating RWY 07's LDA in
	// a form this cannot read still says the published LDA is wrong, however
	// plainly the first one stated its TORA.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local result
	const contested = new Map<string, IndexedNotam>();
	for (const [d, list] of contesters) {
		const answered = readers.get(d);
		const open = answered ? list.find((c) => !answered.has(c.notam.id)) : list[0];
		if (open) {
			contested.set(d, open);
		}
	}
	for (const src of sources) {
		const n = src.notam;
		if (!isRunwayQCode(n.qCode) || !validIn(n, at)) {
			continue;
		}
		const statements = parseRunwayChange(notamEText(n));
		if (statements.length === 0) {
			continue;
		}
		// Asked once per NOTAM: the schedule belongs to the NOTAM, not to its
		// lines, and reading it per line would walk the calendar per line.
		let active: boolean | null | undefined;
		for (const s of statements) {
			// "Exact or nothing", the runway-badge rule: a cited 23 never
			// stands for a published 23L, so a designator the aerodrome does
			// not publish is said rather than guessed at.
			const mine = s.designators.filter((d) => ends.has(d));
			if (s.kind === 'note') {
				if (mine.length > 0) {
					note('partial', mine, src);
				}
				continue;
			}
			if (mine.length === 0) {
				note('unmatched', s.designators, src);
				continue;
			}
			active ??= activeIn(n, at);
			if (active === null) {
				note('schedule', mine, src);
				continue;
			}
			if (active === false) {
				continue;
			}
			for (const d of mine) {
				if (!closed.has(d)) {
					closed.set(d, src);
				}
			}
		}
	}
	return closed.size === 0 && distances.size === 0 && contested.size === 0 && notes.length === 0
		? NONE
		: { closed, distances, contested, notes };
}

/** How ONE declared-distance cell should be marked: a panel row printing both
 *  ends of a runway (le over he), or a performance cell printing one.
 *
 *  A CONTESTED end outranks a restated figure, even one this did read: a NOTAM
 *  in force says the end's figures changed in a form this cannot act on, and
 *  what it states may be shorter than anything shown. So each cell is judged
 *  per end and per distance, never per row: marking a whole row from its first
 *  end hid the other end's contest, and styled the AIP's own LDA as the
 *  NOTAM's when that NOTAM had restated only the TORA. */
export function declaredDistanceMark(
	res: RunwayResolution,
	ends: readonly (string | null | undefined)[],
	key: DistanceKey,
): { kind: 'notam' | 'contested'; notam: IndexedNotam } | null {
	let restated: IndexedNotam | null = null;
	for (const raw of ends) {
		if (!raw) {
			continue;
		}
		const id = normalizeRunwayDesignator(raw);
		const c = res.contested.get(id);
		if (c) {
			return { kind: 'contested', notam: c };
		}
		const over = res.distances.get(id);
		if (over && over.values[key] !== undefined) {
			restated ??= over.from[key] ?? over.notam;
		}
	}
	return restated ? { kind: 'notam', notam: restated } : null;
}

/** One of the maps above, re-keyed from the NORMALISED end ('04') onto the
 *  spelling the airport's own runway rows carry ('4'), for the consumers that
 *  key by `RunwayEnd.id` (the performance page and aircraft/aerodromes.ts
 *  runwayEnds, whose overrides are keyed "exactly as RunwayEnd.id spells
 *  it"). The national datasets all pad their designators; the OurAirports
 *  baseline writes 1,297 fields' ends unpadded, and there a closed runway read
 *  open and a restated distance was dropped. The same map comes back when
 *  every key already matches. */
export function onPublishedEnds<V>(airport: Airport, m: ReadonlyMap<string, V>): ReadonlyMap<string, V> {
	if (m.size === 0) {
		return m;
	}
	let same = true;
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local re-keyed view
	const out = new Map<string, V>();
	for (const r of airport.runways) {
		for (const raw of [r.le, r.he]) {
			if (!raw) {
				continue;
			}
			const key = normalizeRunwayDesignator(raw);
			const v = m.get(key);
			if (v !== undefined) {
				out.set(raw, v);
				if (raw !== key) {
					same = false;
				}
			}
		}
	}
	return same ? m : out;
}
