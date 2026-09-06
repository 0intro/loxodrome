/* The shared-mode boot sweep (docs/accounts-sync.md, "Device modes"):
 * flag-present-and-marker-absent is the ended-session signature, and the
 * sweep must complete its localStorage half BEFORE FIRST PAINT so the
 * next pilot never sees a flash of someone else's plans on the club PC.
 *
 * Two tabs are ordinary in this PWA and sessionStorage is PER TAB, so
 * the naive signature has a false positive: a second tab opened into a
 * LIVE session carries the flag and no marker. The gate is Web Locks:
 * every signed-in tab holds the PRESENCE lock in `shared` mode for its
 * lifetime (locks survive background-tab freezing, which is why no
 * heartbeat exists), and `navigator.locks.query()` proves whether any
 * live tab holds the session. The query is async, so a SUSPECT boot
 * defers mount behind it (single-digit milliseconds, and only on the
 * suspect shared-mode signature); a holder means JOIN (write our own
 * marker, no sweep), no holder means SWEEP pre-mount, the IDB half
 * following after mount (flights data is not paint-visible).
 *
 * IMPORT DISCIPLINE: this module is imported FIRST in main.ts and runs
 * at evaluation, before any state module may initialize (routePersist
 * captures its pristine baselines at module eval). It therefore imports
 * only the leaf-safe wipe/keys/registry modules and touches storage
 * raw. */

import { PRESENCE_LOCK, SHARED_FLAG_KEY, SHARED_MARKER_KEY } from './keys';
import { wipeLocalIdb, wipeLocalSync } from './wipe';

// The boot BRIDGE hold: a joining or reloading tab's own presence hold
// only goes up when the account module evaluates, and the tab it joined
// may close in between; a third tab booting in that window would find
// no holder and sweep under a live session. The bridge requests the
// lock HERE, synchronously with the decision, and account.svelte
// releases it from inside its own grant (or at once when it has no
// session to hold).
let releaseBridge: (() => void) | null = null;
let bridgeGen = 0;

function bridgeHold(): void {
	try {
		const locks = navigator.locks;
		if (!locks) {
			return;
		}
		const gen = ++bridgeGen;
		void locks.request(
			PRESENCE_LOCK,
			{ mode: 'shared' },
			() =>
				new Promise<void>((resolve) => {
					if (gen !== bridgeGen || releaseBridge) {
						resolve(); // released before the grant, or duplicate
						return;
					}
					releaseBridge = resolve;
				}),
		);
	} catch {
		/* no locks API: the sweep already assumes single-tab there */
	}
}

/** Hand the bridge over (account.svelte, once its own hold is granted
 *  or provably never coming). Idempotent. */
export function releaseBootPresence(): void {
	bridgeGen++;
	releaseBridge?.();
	releaseBridge = null;
}

function readRaw(storage: 'local' | 'session', key: string): string | null {
	try {
		return (storage === 'local' ? localStorage : sessionStorage).getItem(key);
	} catch {
		return null;
	}
}

/** null = boot normally, right now (the overwhelmingly common case: no
 *  shared-mode signature). A promise = a SUSPECT shared-mode boot; the
 *  caller mounts when it resolves, after the join-or-sweep decision. */
export function bootSweepGate(): Promise<void> | null {
	if (readRaw('local', SHARED_FLAG_KEY) === null) {
		return null;
	}
	if (readRaw('session', SHARED_MARKER_KEY) !== null) {
		// This very tab's session (a reload): nothing ended, but the
		// reload DROPPED this tab's presence hold; bridge the gap until
		// the account module re-holds.
		bridgeHold();
		return null;
	}
	return decide();
}

async function decide(): Promise<void> {
	let held = false;
	try {
		const locks = navigator.locks;
		if (locks && typeof locks.query === 'function') {
			const state = await locks.query();
			held = (state.held ?? []).some((l) => l.name === PRESENCE_LOCK);
		}
	} catch {
		held = false; // no locks API: single-tab assumption, sweep
	}
	if (held) {
		// A live signed-in tab holds the session: JOIN it (the token is in
		// localStorage), bridge presence until our own hold is up, write
		// our own marker, wipe nothing.
		bridgeHold();
		try {
			sessionStorage.setItem(SHARED_MARKER_KEY, '1');
		} catch {
			/* no session storage: the 12 h token cap still bounds it */
		}
		return;
	}
	const reg = wipeLocalSync();
	// The IndexedDB half rides behind the mount; nothing it holds paints.
	void wipeLocalIdb(reg);
}
