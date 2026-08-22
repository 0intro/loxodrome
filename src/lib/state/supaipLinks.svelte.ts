/* Link between NOTAMs and French SUP AIP temporary zones (ZRT / ZIT / ZDT,
 * LF-R / LF-D), the SUP-AIP counterpart of the NOTAM<->airspace activation in
 * notamLinks.svelte.ts.
 *
 * A supplement creates a zone that is "activable par NOTAM": a framework /
 * trigger NOTAM (QRTTT...) announces it, and a separate activation NOTAM
 * (QRTCA / QRRCA..., with a B)/C) window) brings a specific zone into force,
 * e.g. `E) AIP SUP 093/26 : 'ZRT LOURDES' ACT`. The shared "AIP SUP NNN/YY"
 * citation is the bridge (extractAipSups); the quoted / prefixed zone name in
 * the activation's E) text scopes WHICH zones of that supplement light up.
 *
 * Scope rule (confirmed with the user): NAMED ZONE, ELSE ALL. When the NOTAM
 * names a zone that matches a supplement zone, only those zones activate; when
 * nothing matches, all of the supplement's zones do. This bounds the worst case
 * to a whole-supplement hatch, never a wrong single zone (PDF-derived zone
 * names are noisy and NOTAM quoting varies).
 *
 * As in notamLinks.svelte.ts the public helpers read filteredNotams() and the
 * loaded SUP AIP dataset, so any active filter (date, status, kind, text)
 * propagates; reading them inside a derived / effect tracks everything. */

import type { Notam } from '$lib/notam/types';
import type { SupAip } from '$lib/data/supaip';
import { extractAipSups, extractActivatedSups } from '$lib/notam/aipSup';
import { isActivationQCode } from '$lib/notam/qcode';
import { dataState, getSupaips, supaipByRef } from './data.svelte';
import {
	activeEvalWindow,
	notamState,
	filteredNotams,
	type IndexedNotam,
} from './notam.svelte';
import { isActiveDuring } from './notamLinks.svelte';
import type { VisibleZone } from './supaip.svelte';

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

/** Stable per-zone key, `<supId>#<zoneIndex>`. SUP ids ("metropole-2026-012")
 *  never contain `#`, so the last `#` always splits the index off cleanly. */
export function supZoneKey(supId: string, zoneIndex: number): string {
	return `${supId}#${zoneIndex}`;
}

/** Inverse of supZoneKey; null when the key is malformed. */
export function parseSupZoneKey(key: string): { supId: string; zoneIndex: number } | null {
	const hash = key.lastIndexOf('#');
	if (hash <= 0) {
		return null;
	}
	const zoneIndex = Number(key.slice(hash + 1));
	if (!Number.isInteger(zoneIndex) || zoneIndex < 0) {
		return null;
	}
	return { supId: key.slice(0, hash), zoneIndex };
}

/** Canonical SUP-citation key, YEAR-FIRST to match supaipByRef's index
 *  (`<year>/<number>`). Deliberately NOT notamLinks' private number-first
 *  supKey: a mismatch would silently yield zero matches. */
function refKey(ref: { number: number; year: number }): string {
	return `${ref.year}/${ref.number}`;
}

/* ------------------------------------------------------------------ */
/* Zone-name matcher (pure)                                            */
/* ------------------------------------------------------------------ */

// Quoted runs the activation cites the zone by. Guillemets / double quotes are
// unambiguous; a straight / curly single quote is treated as a quotation only
// when its opener is NOT preceded by a letter, so a French elision apostrophe
// ("ZONE D'ESSAIS", "L'AERODROME") never opens a spurious run.
const PAIRED_QUOTE_RE = /[«"“]\s*([^«»"“”\n]+?)\s*[»"”]/g;
const SINGLE_QUOTE_RE = /(?<![A-Za-zÀ-ÿ])['‘]\s*([^'‘’\n]+?)\s*['’]/g;
// A "ZRT/ZIT/ZDT <name>" run (subject + up to four name words), the unquoted
// form ("ZRT OCHEY (AIP SUP 167/25)"). Stops at punctuation / parens / newline.
const ZONE_PREFIX_RE =
	/\bZ[RID]T(?:\/Z[RID]T)?(?:\s+[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9'’-]*){1,4}/gi;
// A special-use designator the zone may be named after ("LF-R17", "LFR17A").
const DESIGNATOR_RE = /\bLF-?[RDP]\d{1,4}[A-Z0-9.]*/gi;

/** Uppercase, strip accents, collapse to bare alphanumerics. "LF-R17 A tempo
 *  « AVEL »" -> "LFR17ATEMPOAVEL"; "Baie de Somme Sud" -> "BAIEDESOMMESUD".
 *  PDF-jammed and spaced spellings normalise to the same string. */
function normalize(s: string): string {
	return s
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '');
}

/** Candidate zone tokens carried in the NOTAM body: quoted runs + ZRT/ZIT/ZDT
 *  runs + LF-R/D/P designators. Normalised, non-empty, deduped. */
function candidateTokens(notam: Notam): string[] {
	const text = notam.fullContent;
	const raw: string[] = [];
	for (const m of text.matchAll(PAIRED_QUOTE_RE)) {
		raw.push(m[1]);
	}
	for (const m of text.matchAll(SINGLE_QUOTE_RE)) {
		raw.push(m[1]);
	}
	for (const m of text.matchAll(ZONE_PREFIX_RE)) {
		raw.push(m[0]);
	}
	for (const m of text.matchAll(DESIGNATOR_RE)) {
		raw.push(m[0]);
	}
	// Local, intentionally non-reactive dedup index.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of raw) {
		const n = normalize(r);
		if (n && !seen.has(n)) {
			seen.add(n);
			out.push(n);
		}
	}
	return out;
}

/** Whole-token equality, or containment either way guarded to >= 4 chars so a
 *  short designator never bleeds into a longer one ("R17" does NOT match
 *  "R170") while a real name run still matches its zone ("AVEL" in
 *  "LFR17ATEMPOAVEL", "ZRTLOURDES" around "LOURDES"). */
function tokenMatchesZone(cand: string, zone: string): boolean {
	if (cand === zone) {
		return true;
	}
	if (cand.length >= 4 && zone.includes(cand)) {
		return true;
	}
	if (zone.length >= 4 && cand.includes(zone)) {
		return true;
	}
	return false;
}

/** The supplement zone indices a NOTAM activates: those whose name matches one
 *  of the NOTAM's candidate tokens, else (no zone matched) ALL of them.
 *  Precondition: the NOTAM cites this supplement; the caller gates on the
 *  activation Q-code. Pure; exported for the activation spec. */
export function activatedZoneIndices(notam: Notam, sup: SupAip): number[] {
	const cands = candidateTokens(notam);
	const matched: number[] = [];
	sup.zones.forEach((z, i) => {
		const zn = normalize(z.name);
		if (zn && cands.some((c) => tokenMatchesZone(c, zn))) {
			matched.push(i);
		}
	});
	if (matched.length > 0) {
		return matched;
	}
	// Named-zone else all: nothing matched, so the whole supplement activates.
	return sup.zones.map((_, i) => i);
}

/** True iff `notam` activates zone `zoneIndex` of `sup` (see
 *  activatedZoneIndices). Exported for the activation spec. */
export function notamActivatesZone(notam: Notam, sup: SupAip, zoneIndex: number): boolean {
	return activatedZoneIndices(notam, sup).includes(zoneIndex);
}

/* ------------------------------------------------------------------ */
/* Reverse link: zone -> activating NOTAMs (map hatch + SUP detail)    */
/* ------------------------------------------------------------------ */

/** True iff `notam` cites the SUP keyed by `key` (year/number) anywhere in its
 *  body. */
function citesSupKey(notam: Notam, key: string): boolean {
	for (const r of extractAipSups(notam.fullContent)) {
		if (refKey(r) === key) {
			return true;
		}
	}
	return false;
}

let actCache: {
	sups: SupAip[];
	from: number;
	to: number;
	notams: readonly IndexedNotam[];
	out: Map<string, IndexedNotam[]>;
} | null = null;

/** The no-dataset answer, one stable reference: consumers key caches on the
 *  returned identity, and the NOTAM list need not even be read to know the
 *  result is empty (tests mock this module's world accordingly). */
const EMPTY_ACTS: Map<string, IndexedNotam[]> = new Map();

/** Every supplement zone activated by at least one visible NOTAM whose validity
 *  window overlaps the active evaluation window (the period condition's range, or
 *  now → the future when the filter is off; see activeEvalWindow). Keyed by
 *  supZoneKey, value the activating NOTAMs. Mirrors activatedAirspaceLinks();
 *  the heart of the magenta-hatch overlay and the SUP "Activated by" section.
 *  Only loaded metropole supplements (the ones supaipByRef indexes) are
 *  considered, matching the forward link.
 *
 *  Memoised on its inputs (read BEFORE the cache check, the notamCorridor
 *  idiom) so the RETURNED REFERENCE is stable between input changes: the
 *  airspace-alert selector keys its evaluation signature and its
 *  NOTAM-window cache on this reference, and a fresh Map per call defeated
 *  both, running the evaluator once per consumer per pass. */
export function supZoneActivations(): Map<string, IndexedNotam[]> {
	void dataState.supaipLoaded;
	const { from, to } = activeEvalWindow();
	const all = getSupaips();
	if (!all) {
		return EMPTY_ACTS;
	}
	const items = filteredNotams();
	if (
		actCache &&
		actCache.sups === all &&
		actCache.from === from &&
		actCache.to === to &&
		actCache.notams === items
	) {
		return actCache.out;
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const out = new Map<string, IndexedNotam[]>();
	// Local refKey -> SupAip index over the loaded metropole supplements.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const byRef = new Map<string, SupAip>();
	for (const s of all) {
		if (s.region === 'metropole' && Number.isFinite(s.number) && Number.isFinite(s.year)) {
			byRef.set(refKey(s), s);
		}
	}
	const push = (key: string, item: IndexedNotam) => {
		const arr = out.get(key);
		if (arr) {
			arr.push(item);
		} else {
			out.set(key, [item]);
		}
	};
	for (const item of items) {
		const n = item.notam;
		if (!isActivationQCode(n.qCode)) {
			continue;
		}
		if (!isActiveDuring(n, from, to)) {
			continue;
		}
		// The supplements this NOTAM ACTIVATES (references / exclusions dropped)
		// that are actually loaded; dedup so a supplement cited twice isn't
		// double-counted.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
		const cited = new Set<SupAip>();
		for (const r of extractActivatedSups(n.fullContent)) {
			const s = byRef.get(refKey(r));
			if (s) {
				cited.add(s);
			}
		}
		for (const sup of cited) {
			for (const i of activatedZoneIndices(n, sup)) {
				push(supZoneKey(sup.id, i), item);
			}
		}
	}
	actCache = { sups: all, from, to, notams: items, out };
	return out;
}

/** The activation NOTAMs currently lighting up any zone of `sup`, deduped by id
 *  and in filteredNotams (source-index) order. Drives the SUP detail's "Activated
 *  by" cards and the per-zone ACTIVE badge. Empty for a null / unloaded sup. */
export function activatedNotamsForSup(sup: SupAip | null): IndexedNotam[] {
	if (!sup) {
		return [];
	}
	const acts = supZoneActivations();
	const out: IndexedNotam[] = [];
	// Local, intentionally non-reactive dedup index.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const seen = new Set<string>();
	for (const [key, items] of acts) {
		const parsed = parseSupZoneKey(key);
		if (!parsed || parsed.supId !== sup.id) {
			continue;
		}
		for (const it of items) {
			if (!seen.has(it.notam.id)) {
				seen.add(it.notam.id);
				out.push(it);
			}
		}
	}
	return out.sort((a, b) => a.index - b.index);
}

/* ------------------------------------------------------------------ */
/* Forward link: NOTAM -> activated zones (NOTAM detail)               */
/* ------------------------------------------------------------------ */

/** The SUP AIP zones this NOTAM activates, for the NOTAM panel's "Activates SUP
 *  AIP zones" list. qCode-gated; NO time filter (parallels activatesAirspaces),
 *  so a panel lists every activation regardless of its window. Reads loaded
 *  metropole supplements via supaipByRef, so it fills in once the dataset
 *  loads. */
export function activatesSupZones(notam: Notam): VisibleZone[] {
	if (!isActivationQCode(notam.qCode)) {
		return [];
	}
	const out: VisibleZone[] = [];
	// Local, intentionally non-reactive dedup index over zone keys.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const seen = new Set<string>();
	// extractActivatedSups, not extractAipSups: a SUP the NOTAM only references
	// or excepts is not a zone it activates.
	for (const r of extractActivatedSups(notam.fullContent)) {
		const sup = supaipByRef(r.number, r.year);
		if (!sup) {
			continue;
		}
		for (const i of activatedZoneIndices(notam, sup)) {
			const key = supZoneKey(sup.id, i);
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			const zone = sup.zones[i];
			if (zone) {
				out.push({ sup, zoneIndex: i, zone });
			}
		}
	}
	return out;
}

/** Visible NOTAMs that reference this supplement but are NOT among its current
 *  activations (those live in "Activated by"); the SUP detail's "Referenced by"
 *  section. Mirrors AirspaceDetail's split of affecting-vs-activated: an
 *  activation NOTAM whose window falls outside the eval range isn't in
 *  activatedNotamsForSup, so it surfaces here. Deduped, in filteredNotams
 *  order. */
export function notamsReferencingSup(number: number, year: number): IndexedNotam[] {
	void notamState.tick;
	const key = refKey({ number, year });
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const activatingIds = new Set(
		activatedNotamsForSup(supaipByRef(number, year)).map((it) => it.notam.id),
	);
	const out: IndexedNotam[] = [];
	// Local, intentionally non-reactive dedup index.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const seen = new Set<string>();
	for (const it of filteredNotams()) {
		if (seen.has(it.notam.id) || activatingIds.has(it.notam.id)) {
			continue;
		}
		if (!citesSupKey(it.notam, key)) {
			continue;
		}
		seen.add(it.notam.id);
		out.push(it);
	}
	return out;
}
