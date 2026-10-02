/* The account's two small documents, as its data download carries them.
 *
 * The account service holds five collections (sync/model.ts). A flights
 * bundle already carries three of them as files this application writes
 * anyway: the plans, the flights with their traces, the user's aircraft
 * sheets. The other two, the pilot details and the grade tanked in each
 * aircraft, have no file of their own, so the account's "Download a copy of
 * my data" adds them as the very payloads the service stores
 * (pilotPayload / acstatePayload), and this module reads them back. Only
 * that download writes them: the flights export is a library a pilot may
 * hand to someone else, and a medical certificate's validity is not part of
 * it.
 *
 * Recognised by CONTENT like every other file (files/detect.ts), and read
 * strictly: a name that is not text, a date that is not a calendar day or a
 * grade that is not text, and the document is not ours. Pure. */

/** The member names the account download writes them under. */
export const PILOT_MEMBER = 'pilot.json';
export const TANKED_FUEL_MEMBER = 'tanked-fuel.json';

/** Past this size a text is not one of these (a pilot block is a few hundred
 *  bytes, a tanked map a few dozen per aircraft), so the sniffer never parses
 *  a large JSON of any other kind only to refuse it. */
const MAX_CHARS = 64 * 1024;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The dossier's pilot block (state/flightPrep.svelte.ts). */
export interface PilotDetails {
	name: string;
	sepValidUntil: string | null;
	medicalValidUntil: string | null;
}

function jsonObject(text: string): Record<string, unknown> | null {
	if (text.length > MAX_CHARS || !text.trimStart().startsWith('{')) {
		return null;
	}
	try {
		const v: unknown = JSON.parse(text);
		return typeof v === 'object' && v !== null && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** A validity date as the dossier's date field writes it, or null for none;
 *  undefined when it is neither. */
function day(v: unknown): string | null | undefined {
	if (v === null) {
		return null;
	}
	return typeof v === 'string' && ISO_DAY.test(v) ? v : undefined;
}

/** The pilot details the text holds, or null when it is not that document. */
export function readPilotDoc(text: string): PilotDetails | null {
	const o = jsonObject(text);
	if (!o || typeof o.name !== 'string') {
		return null;
	}
	const sep = day(o.sepValidUntil);
	const medical = day(o.medicalValidUntil);
	if (sep === undefined || medical === undefined) {
		return null;
	}
	return { name: o.name, sepValidUntil: sep, medicalValidUntil: medical };
}

/** The tanked grades the text holds (aircraft key to grade), or null when it
 *  is not that document. A grade this build does not know is still read: the
 *  restore decides what it can apply. */
export function readTankedFuelDoc(text: string): Record<string, string> | null {
	const o = jsonObject(text);
	if (!o || o.v !== 1 || typeof o.types !== 'object' || o.types === null || Array.isArray(o.types)) {
		return null;
	}
	const out: Record<string, string> = {};
	for (const [key, type] of Object.entries(o.types as Record<string, unknown>)) {
		if (typeof type !== 'string') {
			return null;
		}
		out[key] = type;
	}
	return out;
}
