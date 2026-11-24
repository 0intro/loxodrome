/* The pilot's notes of what a unit said of a zone that may be active
 * ("inactive until 16:00Z, says BLOIS INFO"), for the flight. Kept on the
 * device in the briefing's storage class (state/storageKeys.ts): a reload
 * and an Android relaunch keep them, and every wipe of that class clears
 * them. Keyed by the zone's volume id (nav/alertVolumes.ts AlertVolume.id),
 * which the alerts, the panels and the crossings share, so a note settles
 * the zone's answer wherever it may be active (data/activity.ts
 * resolveActivity). The flight app hands them to the shared surfaces
 * through state/planScope.svelte.ts, so the NOTAM Viewer reads none. A
 * note past its end is dropped at the next write and at load. */

import type { NotedState } from '$lib/data/activity';
import { readJson, removeItem, writeJson } from './persist';

const KEY = 'loxodrome:zone-notes';
const MINUTE_MS = 60_000;

/** What a unit said of a zone, and of which zone. */
export interface ZoneNote extends NotedState {
	/** The unit that said it, as the pilot wrote it, empty for none. */
	unit: string;
	/** The zone's name, for the lists that show the notes apart from it. */
	name: string;
}

function isNote(v: unknown): v is ZoneNote {
	if (typeof v !== 'object' || v === null) {
		return false;
	}
	const n = v as Record<string, unknown>;
	return (
		(n.state === 'active' || n.state === 'inactive') &&
		Number.isFinite(n.notedAtMs) &&
		Number.isFinite(n.untilMs) &&
		typeof n.unit === 'string' &&
		typeof n.name === 'string'
	);
}

/** The stored notes still in force at `nowMs`. */
function load(nowMs: number): Record<string, ZoneNote> {
	const raw = readJson<unknown>(KEY);
	const out: Record<string, ZoneNote> = {};
	if (typeof raw === 'object' && raw !== null) {
		for (const [id, n] of Object.entries(raw)) {
			if (isNote(n) && n.untilMs >= nowMs) {
				out[id] = n;
			}
		}
	}
	return out;
}

export const zoneNotes = $state<{ byZone: Record<string, ZoneNote> }>({ byZone: load(Date.now()) });

/** Store the notes, the key removed with the last one. */
function persist(): void {
	if (Object.keys(zoneNotes.byZone).length === 0) {
		removeItem(KEY);
	} else {
		writeJson(KEY, zoneNotes.byZone);
	}
}

/** The note in force on the zone `id` at `nowMs`, null where there is none
 *  or it has ended. */
export function zoneNote(id: string, nowMs = Date.now()): ZoneNote | null {
	const n = zoneNotes.byZone[id];
	return n !== undefined && n.untilMs >= nowMs ? n : null;
}

/** Every note in force at `nowMs`, by zone id. */
export function notesInForce(nowMs = Date.now()): [string, ZoneNote][] {
	return Object.entries(zoneNotes.byZone).filter(([, n]) => n.untilMs >= nowMs);
}

/** Note what a unit said of the zone `id`, replacing its note and dropping
 *  the notes that have ended. The note's time is kept to the minute it was
 *  taken in, the step the panels judge "now" by. */
export function setZoneNote(id: string, note: ZoneNote, nowMs = Date.now()): void {
	const kept: Record<string, ZoneNote> = {};
	for (const [k, n] of Object.entries(zoneNotes.byZone)) {
		if (k !== id && n.untilMs >= nowMs) {
			kept[k] = n;
		}
	}
	kept[id] = { ...note, notedAtMs: Math.floor(note.notedAtMs / MINUTE_MS) * MINUTE_MS };
	zoneNotes.byZone = kept;
	persist();
}

/** Forget the note on the zone `id`. */
export function clearZoneNote(id: string): void {
	if (!(id in zoneNotes.byZone)) {
		return;
	}
	const rest = { ...zoneNotes.byZone };
	delete rest[id];
	zoneNotes.byZone = rest;
	persist();
}
