/* The device-WIPE half of the delete-versus-wipe invariant
 * (docs/accounts-sync.md): removing the ACCOUNT'S data from this device
 * without recording a single tombstone, since wiping a club PC must
 * never delete anything server-side. Shared sign-out and the boot sweep
 * both run through here.
 *
 * Import discipline: the boot sweep runs at main.ts import time, BEFORE
 * any state module may evaluate (routePersist's module-eval pristine
 * capture), so this module touches storage RAW and imports only leaves:
 * keys, the registry reader (persist + keys + model, all leaf-safe) and
 * flightsDb (deflate + type-only nav imports, no state init).
 *
 * Scope, per the contract: every registry-listed doc, the sync keys, and
 * the BRIEFING key group (a plan pulled from the account and Activated
 * lands in loxodrome:routes, which would otherwise stay drawn on the
 * club PC's map; the session's desk is cleared with the session). The
 * two map-shaped aircraft keys are edited PER-ENTRY so anonymous
 * leftovers survive; `loxodrome:last-account` deliberately survives (the
 * misused-mode guard's memory). */

import { ACCOUNT_KEY, SHARED_FLAG_KEY, SHARED_MARKER_KEY, SYNC_REGISTRY_KEY } from './keys';
import { deleteOuting, deleteStoredPlan } from '$lib/state/flightsDb';
import { readSyncRegistry, type SyncRegistry } from '$lib/state/syncRegistry';

const PILOT_KEY = 'loxodrome:pilot';
const AIRCRAFT_USER_KEY = 'loxodrome:aircraft-user';
const AIRCRAFT_FUEL_KEY = 'loxodrome:aircraft-fuel';
const BRIEFING_KEYS = [
	'loxodrome:routes',
	'loxodrome:routes-rescued',
	'loxodrome:nav-trace',
	'loxodrome:nav-trace-parked',
];

function rawRemove(key: string): void {
	try {
		localStorage.removeItem(key);
	} catch {
		/* storage unavailable: nothing stored, nothing to wipe */
	}
}

/** Remove the registry-listed entries from one map-shaped key
 *  ({v: 1, <field>: Record<key, ...>}), leftovers untouched. */
function surgicalMapRemove(storageKey: string, field: string, doomed: Set<string>): void {
	try {
		const raw = localStorage.getItem(storageKey);
		if (raw === null) {
			return;
		}
		const doc = JSON.parse(raw) as { v?: number } & Record<string, unknown>;
		const map = doc[field];
		if (doc.v !== 1 || !map || typeof map !== 'object') {
			return;
		}
		let changed = false;
		for (const key of Object.keys(map)) {
			if (doomed.has(key)) {
				delete (map as Record<string, unknown>)[key];
				changed = true;
			}
		}
		if (changed) {
			localStorage.setItem(storageKey, JSON.stringify(doc));
		}
	} catch {
		/* unreadable: leave it, absence must never cascade */
	}
}

/** The SYNCHRONOUS wipe: everything paint-visible or localStorage-held.
 *  Answers the registry snapshot so the caller can run the async IDB
 *  half. Callable before any state module evaluates. */
export function wipeLocalSync(): SyncRegistry {
	const reg = readSyncRegistry();
	const planes = new Set<string>();
	let wipeFuel = false;
	let wipePilot = false;
	for (const key of Object.keys(reg.docs)) {
		if (key.startsWith('aircraft/')) {
			planes.add(key.slice('aircraft/'.length));
		} else if (key === 'acstate/tanked-fuel') {
			wipeFuel = true;
		} else if (key === 'pilot/pilot') {
			wipePilot = true;
		}
	}
	surgicalMapRemove(AIRCRAFT_USER_KEY, 'planes', planes);
	if (wipeFuel) {
		rawRemove(AIRCRAFT_FUEL_KEY);
	}
	if (wipePilot) {
		rawRemove(PILOT_KEY);
	}
	for (const key of BRIEFING_KEYS) {
		rawRemove(key);
	}
	rawRemove(ACCOUNT_KEY);
	rawRemove(SYNC_REGISTRY_KEY);
	rawRemove(SHARED_FLAG_KEY);
	try {
		sessionStorage.removeItem(SHARED_MARKER_KEY);
	} catch {
		/* no session storage */
	}
	return reg;
}

/** The ASYNC half: the registry-listed IndexedDB docs (plans, outings).
 *  Flights data is not paint-visible (the surface lists on open), so
 *  this may run after mount; store-level deletes on purpose, tombstone
 *  recording structurally bypassed. */
export async function wipeLocalIdb(reg: SyncRegistry): Promise<void> {
	for (const key of Object.keys(reg.docs)) {
		if (key.startsWith('plans/')) {
			try {
				await deleteStoredPlan(key.slice('plans/'.length));
			} catch {
				/* best-effort */
			}
		} else if (key.startsWith('outings/')) {
			const id = Number(key.slice('outings/'.length));
			if (Number.isFinite(id)) {
				try {
					await deleteOuting(id);
				} catch {
					/* best-effort */
				}
			}
		}
	}
}
