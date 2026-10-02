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
 * marker, no sweep), no holder means SWEEP pre-mount, the IndexedDB half
 * FIRST and the storage half after it, so a sweep cut short is swept again
 * by the next boot.
 *
 * IMPORT DISCIPLINE: this module is imported FIRST in main.ts and runs
 * at evaluation, before any state module may initialize (routePersist
 * captures its pristine baselines at module eval). It therefore imports
 * only the leaf-safe wipe/keys/registry modules and the pure language rule
 * (i18n/locale.ts), and touches storage raw.
 *
 * A RECORDING in another tab (sync/recordingLock.ts) holds the sweep off
 * whatever presence says: a flight flown signed out on a device whose
 * session ended with its tabs still open has its crash copy in the keys a
 * sweep erases. */

import { browserLocale } from '$lib/i18n/locale';
import { PRESENCE_LOCK, RECORDING_LOCK, SHARED_FLAG_KEY, SHARED_MARKER_KEY } from './keys';
import { readSessionEnd, wipeSessionIdb, wipeSharedSession } from './wipe';

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
 *  caller mounts when it resolves, after the join-or-sweep decision.
 *
 *  `join: false` is the NOTAM Viewer's SWEEP-ONLY gate (src/notam/main.ts):
 *  an app with no accounts that reads many of the same keys sweeps an ended
 *  session like any tab of the flight app, but joins none. It writes no
 *  marker, which would let the flight app, opened later in this tab, take
 *  the tab for the session's own and skip a sweep it owes, and raises no
 *  presence bridge, which nothing of its own would ever take over. */
export function bootSweepGate(opts: { join?: boolean } = {}): Promise<void> | null {
	const join = opts.join ?? true;
	if (readRaw('local', SHARED_FLAG_KEY) === null) {
		return null;
	}
	if (readRaw('session', SHARED_MARKER_KEY) !== null) {
		// This very tab's session (a reload): nothing ended, but the
		// reload DROPPED this tab's presence hold; bridge the gap until
		// the account module re-holds.
		if (join) {
			bridgeHold();
		}
		return null;
	}
	return decide(join);
}

async function decide(join: boolean): Promise<void> {
	let held = false;
	let recording = false;
	try {
		const locks = navigator.locks;
		if (locks && typeof locks.query === 'function') {
			const state = await locks.query();
			held = (state.held ?? []).some((l) => l.name === PRESENCE_LOCK);
			recording = (state.held ?? []).some((l) => l.name === RECORDING_LOCK);
		}
	} catch {
		held = false; // no locks API: single-tab assumption, sweep
	}
	if (held) {
		if (!join) {
			return; // a live session: nothing to sweep, and none to join
		}
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
	if (recording) {
		// A flight in a tab outside the session (flown signed out on a device
		// whose session ended with its tabs still open): its crash copy and
		// its workspace are in the keys a sweep erases. Neither swept nor
		// joined; the first boot after the recording sweeps.
		return;
	}
	// The session ends at the device's defaults (wipe.ts wipeSharedSession):
	// its preferences too, so the next pilot does not inherit its filters,
	// switched-off alerts and acknowledged cautions, what it made and never
	// synced, and what its sign-in found put back as found, the pilot block,
	// the grades and the planes before the first paint. The URL is kept: at
	// a boot it is what the next pilot opened (a club's bookmark carrying the
	// VFR chart, say), not the ended session's.
	const startMs = Date.now();
	const end = readSessionEnd();
	restampPrePaint();
	// The IndexedDB half FIRST, before the mount and before the storage half,
	// which the in-app ends do too: a tab closed during it leaves the shared
	// flag, the registry and the found copy naming what is left, and the next
	// boot sweeps again. The other way round, a tab closed behind the mount
	// left the session's rows with nothing to name them, the account's and
	// what it made staying on the device and what its sign-in found not put
	// back. Bounded, so a store that never answers holds no mount: the half
	// then finishes behind it, as it used to. A row saved after the sweep
	// began is the next pilot's, and stays.
	await Promise.race([
		wipeSessionIdb(end, startMs).catch(() => undefined),
		new Promise<void>((resolve) => setTimeout(resolve, IDB_HALF_MS)),
	]);
	wipeSharedSession(end);
}

/** How long a sweeping boot waits for its IndexedDB half before it ends the
 *  storage half and mounts anyway (a few hundred milliseconds is the rule). */
export const IDB_HALF_MS = 3_000;

/** The pre-paint scripts (index.html, notam.html) stamped <html lang> and
 *  data-theme from keys this sweep has just erased: i18n.svelte.ts takes its
 *  first locale from <html lang>, so the previous pilot's pinned language
 *  would have stayed for the whole boot while the setting read Auto, and
 *  their night theme showed until the theme module re-stamped. Stamp both as
 *  the pre-paint would have with nothing stored: the browser's languages,
 *  the device's appearance. */
function restampPrePaint(): void {
	if (typeof document === 'undefined') {
		return;
	}
	const html = document.documentElement;
	html.lang = browserLocale();
	let dark = false;
	try {
		dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
	} catch {
		/* no media queries: the day theme, as the pre-paint falls back */
	}
	html.dataset.theme = dark ? 'night' : 'day';
}
