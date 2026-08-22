/* French military RTBA (Réseau Très Basse Altitude) restricted-area activation
 * NOTAMs. The air force activates a set of LF-R45* / LF-R69 low-altitude zones,
 * each with its OWN time window, in one NOTAM whose E) section reads:
 *
 *   E) ZONES AIRFORCE RTBA ACT
 *   ZONE R45C ARBOIS
 *   1130-1230:ACTIVE
 *   ZONE R45S2 LANGRES
 *   1130-1330:ACTIVE
 *   ...
 *
 * The bare zone token (R45C, R45S2, R45S6.1, R45NS, R69) maps to the airspace id
 * by prefixing LF (LFR45C, ...); those rows exist in fr-airspaces.json as type-R
 * restricted areas. The Q-code is QRRCA (restricted area, activated). This is the
 * only E-block wording in the corpus; the same block arrives whether the NOTAM is
 * published in SIA French (DU:/AU:) or ICAO English (B)/C)) form, so "both
 * languages" is just the two date layouts, normalised by parseNotamDates.
 *
 * Pure module (no Svelte runes): parses zones and anchors each HHMM-HHMM window
 * to real UTC dates off the NOTAM's startDate, so the per-zone activation can be
 * shown and the map overlay hatched precisely (R45C off at 12:30 while the others
 * run to 13:30). The link wiring lives in state/notamLinks.svelte.ts. */

import { parseSections } from './parser';
import { isActivationQCode } from './qcode';
import type { Notam } from './types';

const DAY_MS = 86_400_000;

// The RTBA E-section header. Case-insensitive; "ZONE(S) AIRFORCE RTBA ACT" is the
// single form seen across the corpus.
const RTBA_HEADER_RE = /\bZONES?\s+AIRFORCE\s+RTBA\s+ACT\b/i;

// A zone line: "ZONE R45S6.1 MACONNAIS NORD EST". Token = R + digit + optional
// [A-Z0-9.] tail (covers R45C, R45S2, the R45S6.1 decimal and the R45NS suffix
// the generic extractAirspaceIds regex can't represent); the rest is the name.
const RTBA_ZONE_RE = /^\s*ZONE\s+(R\d[A-Z0-9.]*)\s+(.+?)\s*$/i;

// The window line that follows a zone line: "1130-1330:ACTIVE". ACTIF is accepted
// defensively though only ACTIVE appears in real data.
const RTBA_WINDOW_RE = /^\s*(\d{2})(\d{2})-(\d{2})(\d{2}):ACTI(?:VE|F)\b/i;

/** One parsed RTBA zone line pair, before date anchoring. */
export interface RtbaZone {
	/** The raw NOTAM token, e.g. "R45S6.1". */
	token: string;
	/** The airspaces.json id, "LF" + token, e.g. "LFR45S6.1". */
	airspaceId: string;
	/** The descriptive name on the ZONE line, e.g. "MACONNAIS NORD EST". */
	name: string;
	/** Activation start, "HHMM" (UTC). */
	startHHMM: string;
	/** Activation end, "HHMM" (UTC); may be on the next day (see anchoring). */
	endHHMM: string;
}

/** An RTBA zone activation with its window anchored to real UTC dates. */
export interface RtbaActivation {
	airspaceId: string;
	name: string;
	start: Date;
	end: Date;
}

/** True when the NOTAM is a French air-force RTBA activation: an activation
 *  Q-code (QRRCA family) whose E) section carries the RTBA header. */
export function isRtbaActivationNotam(notam: Notam): boolean {
	if (!isActivationQCode(notam.qCode)) {
		return false;
	}
	const e = parseSections(notam.fullContent).E ?? '';
	return RTBA_HEADER_RE.test(e);
}

/** The zones an RTBA NOTAM lists, in body order, with their raw HHMM windows.
 *  Scans the E) section line by line (robust to indentation / blank lines):
 *  each ZONE line is paired with EVERY window line that follows it, one returned
 *  entry per window, so a zone active in both a morning and an evening slot
 *  ("0800-1000:ACTIVE" then "2013-2259:ACTIVE") yields two entries. Returns []
 *  for any NOTAM that is not an RTBA activation. The airspaceId is a candidate;
 *  the caller keeps only ids present in the loaded airspace set. */
export function parseRtbaZones(notam: Notam): RtbaZone[] {
	// Cheap gate: skip the section parse unless the body mentions RTBA at all.
	if (!/RTBA/i.test(notam.fullContent) || !isActivationQCode(notam.qCode)) {
		return [];
	}
	const e = parseSections(notam.fullContent).E ?? '';
	if (!RTBA_HEADER_RE.test(e)) {
		return [];
	}
	const lines = e.split('\n');
	const out: RtbaZone[] = [];
	for (let i = 0; i < lines.length; i++) {
		const zm = lines[i].match(RTBA_ZONE_RE);
		if (!zm) {
			continue;
		}
		const token = zm[1].toUpperCase();
		const name = zm[2].trim();
		// A ZONE line can be followed by MORE THAN ONE window line: a zone active
		// in both a morning and an evening slot prints two ":ACTIVE" lines
		// ("0800-1000:ACTIVE" then "2013-2259:ACTIVE"). Consume the whole run and
		// emit one entry per window so each anchors and hatches on its own; blank
		// lines between windows are tolerated, and the run stops at the next ZONE
		// line (or any non-window text).
		let j = i + 1;
		for (; j < lines.length; j++) {
			if (lines[j].trim() === '') {
				continue;
			}
			const wm = lines[j].match(RTBA_WINDOW_RE);
			if (!wm) {
				break;
			}
			out.push({
				token,
				airspaceId: 'LF' + token,
				name,
				startHHMM: wm[1] + wm[2],
				endHHMM: wm[3] + wm[4],
			});
		}
		// Resume the outer scan at the line that stopped the run; the outer loop's
		// i++ lands there from j - 1 (i is unchanged when no window followed).
		i = j - 1;
	}
	return out;
}

/** Anchor each zone's HHMM window to real UTC Date pairs using the NOTAM's
 *  startDate (which parseNotamDates fills from either the B)/C) or the DU:/AU:
 *  form, so the result is identical for both). The base day is startDate's UTC
 *  date; a zone whose start falls before the NOTAM's own start instant belongs
 *  to the next day (late-night NOTAMs), and an end at or before the start means
 *  the window crosses midnight. Returns [] when the NOTAM has no startDate. */
export function rtbaZoneActivations(notam: Notam): RtbaActivation[] {
	const base = notam.startDate;
	if (!base) {
		return [];
	}
	const baseMs = base.getTime();
	const y = base.getUTCFullYear();
	const mo = base.getUTCMonth();
	const d = base.getUTCDate();
	const out: RtbaActivation[] = [];
	for (const z of parseRtbaZones(notam)) {
		const sH = +z.startHHMM.slice(0, 2);
		const sM = +z.startHHMM.slice(2);
		const eH = +z.endHHMM.slice(0, 2);
		const eM = +z.endHHMM.slice(2);
		let startMs = Date.UTC(y, mo, d, sH, sM);
		if (startMs < baseMs) {
			startMs += DAY_MS;
		}
		// End on the (possibly shifted) start day, rolled forward when it does
		// not come strictly after the start.
		const sd = new Date(startMs);
		let endMs = Date.UTC(
			sd.getUTCFullYear(),
			sd.getUTCMonth(),
			sd.getUTCDate(),
			eH,
			eM,
		);
		if (endMs <= startMs) {
			endMs += DAY_MS;
		}
		out.push({
			airspaceId: z.airspaceId,
			name: z.name,
			start: new Date(startMs),
			end: new Date(endMs),
		});
	}
	return out;
}

/** The RTBA zones whose anchored window overlaps [fromMs, toMs]. Pure and
 *  time-injected so the precision logic is testable without mocking the clock.
 *  The map overlay calls this with the active evaluation window: the date
 *  filter's range, or the single instant `now` (under the 60 s heartbeat) when
 *  the filter is off. */
export function rtbaActiveDuring(
	notam: Notam,
	fromMs: number,
	toMs: number,
): RtbaActivation[] {
	return rtbaZoneActivations(notam).filter(
		(z) => z.start.getTime() <= toMs && z.end.getTime() >= fromMs,
	);
}

/** The RTBA zones active at the instant `nowMs`; the degenerate single-instant
 *  case of rtbaActiveDuring. */
export function rtbaActiveAt(notam: Notam, nowMs: number): RtbaActivation[] {
	return rtbaActiveDuring(notam, nowMs, nowMs);
}
