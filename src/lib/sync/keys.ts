/* The sync layer's storage keys and Web Locks names, in one leaf module
 * so the boot sweep (which must import NO state modules: routePersist's
 * module-eval pristine capture runs at import time, docs/accounts-sync.md)
 * and the registry share them without an edge into the state tree.
 *
 * Every localStorage key here is DELIBERATELY unregistered in reset.ts:
 * clearing is the default for `loxodrome:` keys, so a Reset involving the
 * settings group signs the device out and forgets sync state, and the
 * content reconcile heals the rest. The one exception is documented on
 * LAST_ACCOUNT_KEY. */

/** The sync registry: {v, deviceId, lastSeq, docs, tombstones}
 *  (state/syncRegistry.ts). localStorage ON PURPOSE, tombstones included:
 *  an IndexedDB eviction must not take the record of a real deletion with
 *  it, and an eviction itself records nothing. */
export const SYNC_REGISTRY_KEY = 'loxodrome:sync';

/** The signed-in account: {v, token, email, userId, mode, status}. */
export const ACCOUNT_KEY = 'loxodrome:account';

/** An opaque hash of the last account that used this device. It SURVIVES
 *  sign-out, personal and shared alike (the misused-mode guard's memory:
 *  a different account signing in flips the merge confirm's default), and
 *  resets with the settings group like the other sync keys. */
export const LAST_ACCOUNT_KEY = 'loxodrome:last-account';

/** The device's last MODE choice ('personal' | 'shared'), surviving
 *  sign-out like the breadcrumb: the sign-in checkbox's default, so a
 *  club PC keeps proposing shared. */
export const LAST_MODE_KEY = 'loxodrome:last-mode';

/** Shared-mode flag (localStorage): this device holds account data in
 *  ephemeral mode. Paired with the sessionStorage marker below:
 *  flag-present-and-marker-absent is the ended-session signature the boot
 *  sweep reads. */
export const SHARED_FLAG_KEY = 'loxodrome:shared-session';

/** The per-tab half of the ended-session signature (sessionStorage: dies
 *  with the tab, survives a reload). */
export const SHARED_MARKER_KEY = 'loxodrome:shared-marker';

/** Whether this device currently holds a SHARED-mode session (the flag
 *  above, read raw). A leaf accessor so modules outside the sync layer
 *  (flightLibrary's persist() ask) can test it without an import edge
 *  into account state. */
export function sharedDeviceFlag(): boolean {
	try {
		return localStorage.getItem(SHARED_FLAG_KEY) !== null;
	} catch {
		return false;
	}
}

/** Web Locks name held in `shared` mode by EVERY signed-in tab for the
 *  tab's lifetime. Locks survive background-tab freezing (timers do not,
 *  which is why no heartbeat exists here); `navigator.locks.query()` on
 *  this name is how the boot sweep proves no live tab holds the session
 *  before it wipes. */
export const PRESENCE_LOCK = 'loxodrome-sync-presence';

/** Web Locks name for the EXCLUSIVE single writer: every sync pass,
 *  registry mutation and tombstone record runs under it, so two tabs
 *  cannot clobber each other's revs or erase a freshly recorded
 *  tombstone. */
export const WRITER_LOCK = 'loxodrome-sync-writer';
