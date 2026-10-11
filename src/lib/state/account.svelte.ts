/* The signed-in account's client state (docs/accounts-sync.md): who is
 * signed in, in which DEVICE MODE, since when; the auth calls; the
 * stored token; the presence lock and the shared-mode markers; the
 * last-account breadcrumb. The sync ENGINE (state/sync.svelte.ts) sits
 * downstream and orchestrates the lifecycle flows; this module never
 * imports it, which keeps the graph a DAG.
 *
 * The token lives in localStorage under `loxodrome:account` (GitHub
 * Pages sends no headers, so no cookie or header-CSP alternative
 * exists; the tree renders no raw HTML, the compensating posture). The
 * key is class `account` (state/storageKeys.ts), which Reset erases with
 * its Settings group, deliberately: a settings reset signs the device
 * out. */

import { isNativeApp } from '$lib/native/platform';
import { sha256HexOfText } from '$lib/sync/fingerprint';
import {
	ACCOUNT_KEY,
	LAST_ACCOUNT_KEY,
	LAST_MODE_KEY,
	PRESENCE_LOCK,
	FOUND_KEY,
	SHARED_FLAG_KEY,
	SHARED_MARKER_KEY,
} from '$lib/sync/keys';
import { readSessionEnd, wipeSessionIdb, wipeSharedSession } from '$lib/sync/wipe';
import { clearFoundRows, parkFoundPilot, PILOT_DOC, takeFoundCopy } from '$lib/sync/found';
import { releaseBootPresence } from '$lib/sync/bootSweep';
import { requestCode, verifyCode } from '$lib/sync/protocol';
import { i18n } from './i18n.svelte';
import {
	mutateSyncRegistry,
	readSyncRegistry,
	withSyncWriter,
	writeSyncRegistry,
	type SyncRegistry,
} from './syncRegistry';
import { readItem, readJson, removeItem, sealStorage, writeItem, writeJson } from './persist';

export type DeviceMode = 'personal' | 'shared';

interface StoredAccount {
	v: 1;
	token: string;
	email: string;
	userId: string;
	mode: DeviceMode;
	status: string;
	signedInAtMs: number;
}

function initialStored(): StoredAccount | null {
	const raw = readJson<Partial<StoredAccount>>(ACCOUNT_KEY);
	if (
		!raw ||
		raw.v !== 1 ||
		typeof raw.token !== 'string' ||
		typeof raw.email !== 'string' ||
		typeof raw.userId !== 'string' ||
		(raw.mode !== 'personal' && raw.mode !== 'shared')
	) {
		return null;
	}
	return {
		v: 1,
		token: raw.token,
		email: raw.email,
		userId: raw.userId,
		mode: raw.mode,
		status: typeof raw.status === 'string' ? raw.status : 'active',
		signedInAtMs: typeof raw.signedInAtMs === 'number' ? raw.signedInAtMs : 0,
	};
}

// The token stays OUT of the reactive state (nothing renders it);
// module-held beside the reactive mirror of everything the UI shows.
let stored: StoredAccount | null = initialStored();

export const account = $state<{
	email: string | null;
	userId: string | null;
	mode: DeviceMode;
	status: string;
	signedInAtMs: number;
	/** A 401 flipped this; the UI offers sign-in again, data untouched
	 *  (the offline-first promise: expiry never locks the app). */
	authExpired: boolean;
}>({
	email: stored?.email ?? null,
	userId: stored?.userId ?? null,
	mode: stored?.mode ?? 'personal',
	status: stored?.status ?? 'active',
	signedInAtMs: stored?.signedInAtMs ?? 0,
	authExpired: false,
});

export function signedIn(): boolean {
	return account.email !== null;
}

export function accountToken(): string | null {
	return stored?.token ?? null;
}

/** Whether `token` is still the session STORED on this device, read from
 *  storage rather than this tab's memory: another tab's sign-out, a shared
 *  session's end or a sign-in over it rewrites or removes the stored
 *  account under this tab, and a pass going on with the token it
 *  remembers would pull that session's data back into what the end has
 *  just erased (state/sync.svelte.ts). */
export function tokenStillStored(token: string): boolean {
	return readJson<Partial<StoredAccount>>(ACCOUNT_KEY)?.token === token;
}

export function markAuthExpired(): void {
	account.authExpired = true;
}

// --- the presence lock -----------------------------------------------------
// Held in `shared` Web Locks mode by every signed-in tab for the tab's
// lifetime: what the boot sweep queries before it dares to wipe. Locks
// survive background-tab freezing; timers do not, which is why no
// heartbeat exists anywhere in this design.

let releasePresence: (() => void) | null = null;
// The grant is asynchronous: a drop between request and grant must
// CANCEL it (the generation test), or a signed-out tab would hold
// presence forever and the boot sweep could never wipe.
let presenceGen = 0;

export function holdPresenceLock(): void {
	if (releasePresence) {
		return;
	}
	const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
	if (!locks) {
		releaseBootPresence(); // no API: nothing will ever take over
		return;
	}
	const gen = ++presenceGen;
	void locks.request(
		PRESENCE_LOCK,
		{ mode: 'shared' },
		() =>
			new Promise<void>((resolve) => {
				if (gen !== presenceGen || releasePresence) {
					resolve(); // stale or duplicate grant: let it go at once
					return;
				}
				releasePresence = resolve;
				// Our hold is up: the boot sweep's bridge (if any) may go.
				releaseBootPresence();
			}),
	);
}

export function dropPresenceLock(): void {
	presenceGen++;
	releasePresence?.();
	releasePresence = null;
	releaseBootPresence(); // a sign-out must not leave the bridge up
}

// --- device naming ---------------------------------------------------------

/** A serviceable default device name; renamable in the Account group.
 *  Locale-invariant BY DECISION: the name is minted once, stored
 *  server-side and shown on every device whatever ITS locale, the
 *  designator posture (docs/accounts-sync.md). */
// i18n-ignore-start: wire identifiers, locale-invariant by decision
export function deviceNameGuess(): string {
	if (isNativeApp()) {
		return 'Android app';
	}
	if (typeof navigator === 'undefined') {
		return 'Device';
	}
	const ua = navigator.userAgent;
	const browser = /firefox/i.test(ua)
		? 'Firefox'
		: /edg\//i.test(ua)
			? 'Edge'
			: /chrome|chromium/i.test(ua)
				? 'Chrome'
				: /safari/i.test(ua)
					? 'Safari'
					: 'Browser';
	const os = /android/i.test(ua)
		? 'Android'
		: /iphone|ipad/i.test(ua)
			? 'iOS'
			: /mac os/i.test(ua)
				? 'macOS'
				: /windows/i.test(ua)
					? 'Windows'
					: /linux/i.test(ua)
						? 'Linux'
						: 'Device';
	return `${browser} on ${os}`;
}
// i18n-ignore-end

// --- the auth flows --------------------------------------------------------

/** Ask for a code (always answers quietly server-side; the UI moves to
 *  the code field regardless). */
export async function beginSignIn(email: string, turnstileToken: string): Promise<void> {
	await requestCode(email.trim(), turnstileToken, i18n.locale);
}

/** Ask for a FRESH code for the signed-in account (the sudo re-verify:
 *  delete account, sign out everywhere). The bearer stands in for
 *  Turnstile server-side. */
export async function requestSudoCode(): Promise<void> {
	const token = accountToken();
	if (!account.email || !token) {
		return;
	}
	await requestCode(account.email, '', i18n.locale, token);
}

export interface SignInOutcome {
	created: boolean;
	status: string;
	/** The last-account breadcrumb named a DIFFERENT account: the merge
	 *  confirm flips its default to "don't add" (the misused-mode
	 *  guard). */
	differentAccount: boolean;
}

/** A code the server has accepted, not yet committed to this device: the
 *  network half of a sign-in, whose local half is one of the two commits
 *  below (state/sync.svelte.ts signIn chooses). */
export interface VerifiedSignIn {
	token: string;
	userId: string;
	status: string;
	created: boolean;
	/** The address as stored: trimmed, lower case. */
	email: string;
	mode: DeviceMode;
	breadcrumb: string;
	differentAccount: boolean;
	/** The device holds a shared session of ANOTHER account, which this
	 *  sign-in must end first (commitSignInOverSharedSession). */
	endsShared: boolean;
}

function breadcrumbOf(email: string): Promise<string> {
	return sha256HexOfText(`acct:${email.trim().toLowerCase()}`);
}

/** Whether this device holds a shared session, read from storage rather
 *  than this tab's memory (another tab may have ended or begun one). */
function deviceHoldsSharedSession(): boolean {
	return (
		readItem(SHARED_FLAG_KEY) !== null ||
		readJson<Partial<StoredAccount>>(ACCOUNT_KEY)?.mode === 'shared'
	);
}

/** Whether signing `email` in now would first END the shared session this
 *  device holds: it is another account's (the last-account breadcrumb
 *  differs, or is missing), and a shared session's leftovers must never
 *  bleed into another account (an expired club session someone signs
 *  OVER). The same account signing back in continues its own session. */
export async function signInEndsSharedSession(email: string): Promise<boolean> {
	if (!deviceHoldsSharedSession()) {
		return false;
	}
	return readItem(LAST_ACCOUNT_KEY) !== (await breadcrumbOf(email));
}

/** The network half of a sign-in: verify the code. `remember` is the
 *  device-mode checkbox: unchecked means shared. Commits nothing. */
export async function verifySignIn(
	email: string,
	code: string,
	remember: boolean,
): Promise<VerifiedSignIn> {
	const mode: DeviceMode = remember ? 'personal' : 'shared';
	const res = await verifyCode(email.trim(), code.trim(), deviceNameGuess(), mode);
	const breadcrumb = await breadcrumbOf(email);
	const previous = readItem(LAST_ACCOUNT_KEY);
	return {
		token: res.token,
		userId: res.userId,
		status: res.status,
		created: res.created,
		email: email.trim().toLowerCase(),
		mode,
		breadcrumb,
		differentAccount: previous !== null && previous !== breadcrumb,
		// Asked once the code is accepted, so a session another tab ended
		// meanwhile is not ended twice.
		endsShared: await signInEndsSharedSession(email),
	};
}

/** Write the verified session to storage, and nothing to memory: the
 *  breadcrumb, the mode, the account, and the shared flag and marker or
 *  their removal. */
function storeSession(v: VerifiedSignIn): StoredAccount {
	writeItem(LAST_ACCOUNT_KEY, v.breadcrumb);
	writeItem(LAST_MODE_KEY, v.mode);
	const session: StoredAccount = {
		v: 1,
		token: v.token,
		email: v.email,
		userId: v.userId,
		mode: v.mode,
		status: v.status,
		signedInAtMs: Date.now(),
	};
	writeJson(ACCOUNT_KEY, session);
	if (v.mode === 'shared') {
		writeItem(SHARED_FLAG_KEY, '1');
		try {
			sessionStorage.setItem(SHARED_MARKER_KEY, '1');
		} catch {
			/* no session storage: the 12 h token cap still bounds it */
		}
	} else {
		// A stale shared flag on a now-PERSONAL device would make the next
		// boot's sweep read flag-without-marker and wipe a keeper; and a
		// shared session's found copy has nothing left to put back.
		removeItem(SHARED_FLAG_KEY);
		removeItem(FOUND_KEY);
		void clearFoundRows();
		try {
			sessionStorage.removeItem(SHARED_MARKER_KEY);
		} catch {
			/* no session storage */
		}
	}
	return session;
}

/** The local half of an ordinary sign-in: become signed in, in this
 *  document. The engine's afterSignIn runs the adoption stamping and the
 *  first pass; the caller chains it. Never for a sign-in that ends a
 *  shared session (commitSignInOverSharedSession).
 *
 *  The adoption stamp is OWED from the instant the session exists until
 *  the engine lands it, and the debt is recorded BEFORE the account: a
 *  pass started in between (the edit debounce three seconds after the
 *  account appears, the visibility trigger, the pagehide flush) pushed
 *  every document on the device into the account, and an end that came
 *  first (a page that died before its stamp, then the boot sweep) read
 *  every one as the session's own and took it away (sync/wipe.ts
 *  madeBySession). A device that cannot record the debt is not signed in.
 *  A creation that adopts everything owes none (afterSignIn), and nor does
 *  the same account signing back into its own shared session, whose stamp
 *  stands as its first sign-in took it; a fresh shared session drops a
 *  found copy an earlier one could not, its stamp taking its own. */
export async function commitSignIn(v: VerifiedSignIn): Promise<SignInOutcome> {
	const adoptsAll = v.created && !v.differentAccount && v.mode === 'personal';
	const continues = v.mode === 'shared' && !v.endsShared && deviceHoldsSharedSession();
	const owes = !adoptsAll && !continues;
	if (v.differentAccount || owes) {
		await mutateSyncRegistry((r) => {
			if (v.differentAccount) {
				// The registry's docs / tombstones / lastSeq are per-ACCOUNT
				// state (revs and seqs mean nothing across accounts); only the
				// device id is the device's own.
				r.docs = {};
				r.tombstones = [];
				r.lastSeq = 0;
				delete r.preexisting;
			}
			if (owes) {
				r.stampPending = true;
			}
		});
		if (owes && readSyncRegistry().stampPending !== true) {
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			throw new Error('sync: storage refused the sign-in');
		}
	}
	if (v.mode === 'shared' && !continues) {
		removeItem(FOUND_KEY);
	}
	stored = storeSession(v);
	account.email = stored.email;
	account.userId = stored.userId;
	account.mode = stored.mode;
	account.status = stored.status;
	account.signedInAtMs = stored.signedInAtMs;
	account.authExpired = false;
	holdPresenceLock();
	return { created: v.created, status: v.status, differentAccount: v.differentAccount };
}

/** The local half of a sign-in that ENDS the shared session this device
 *  holds (v.endsShared): in one step under the writer lock, the session's
 *  end as wipe.ts defines it (the IndexedDB half first, from the end's
 *  inputs read once, then wipeSharedSession, the device's defaults; what
 *  that session made and never synced goes with it and what its sign-in
 *  found goes back as found, privacy first, its pilot not being the one at
 *  the keyboard), the new session's stamp, the new session, and the seal.
 *
 *  The stamp is taken HERE, from the stores the end has just settled,
 *  which hold exactly what the new sign-in finds: a shared one takes its
 *  found copy and sets the found pilot block aside (sync/found.ts), and the
 *  fresh registry holds back what it found, so the next document owes
 *  nothing and none of the new session's own work can be taken for found
 *  there before a stamp lands. Nothing is taken from this document's
 *  MEMORY, which still holds the previous pilot's aircraft, pilot block and
 *  workspace: the caller leaves for a fresh document at once. A personal
 *  sign-in, and a store that cannot be read, leave the stamp OWED to that
 *  document as before (state/sync.svelte.ts). The caller stands sync and
 *  the route writer down first; this module cannot reach them. */
export async function commitSignInOverSharedSession(v: VerifiedSignIn): Promise<void> {
	const startMs = Date.now();
	await withSyncWriter(async () => {
		const end = readSessionEnd();
		await wipeSessionIdb(end, startMs);
		wipeSharedSession(end);
		const reg: SyncRegistry = {
			v: 1,
			deviceId: '',
			lastSeq: 0,
			docs: {},
			tombstones: [],
			stampPending: true,
		};
		if (v.mode === 'shared') {
			const taken = await takeFoundCopy(v.userId, null);
			const copy = taken.stored ? await parkFoundPilot(taken.copy) : taken.copy;
			if (copy.listed) {
				const held = copy.keys.filter((k) => !(copy.parked && k === PILOT_DOC));
				if (held.length > 0) {
					reg.preexisting = held;
				}
				delete reg.stampPending;
			}
		}
		writeSyncRegistry(reg);
		storeSession(v);
		// Sealed in the same step: nothing queued behind this callback, an
		// effect included, may write the previous pilot's state back.
		sealStorage();
	});
}

/** The device's LAST mode choice (personal / shared), or null on a
 *  fresh device: the sign-in checkbox's default, so a club PC keeps
 *  proposing shared and a personal laptop keeps proposing personal. */
export function lastModeChoice(): DeviceMode | null {
	const raw = readItem(LAST_MODE_KEY);
	return raw === 'personal' || raw === 'shared' ? raw : null;
}

export function setAccountStatus(status: string): void {
	account.status = status;
	if (stored) {
		stored = { ...stored, status };
		writeJson(ACCOUNT_KEY, stored);
	}
}

/** Forget the stored session on THIS device (the engine's sign-out
 *  flows call it; wiping, when the mode wants one, is theirs). */
export function clearStoredAccount(): void {
	stored = null;
	removeItem(ACCOUNT_KEY);
	removeItem(SHARED_FLAG_KEY);
	try {
		sessionStorage.removeItem(SHARED_MARKER_KEY);
	} catch {
		/* no session storage */
	}
	account.email = null;
	account.userId = null;
	account.status = 'active';
	account.signedInAtMs = 0;
	account.authExpired = false;
	dropPresenceLock();
}

// A signed-in boot re-holds the presence lock at once (the shared boot
// sweep queries it) and refreshes the per-tab marker: sessionStorage
// survives a reload, and a JOINING second tab wrote its own in the boot
// sweep's join branch.
if (stored) {
	holdPresenceLock(); // its grant releases the boot sweep's bridge
	if (stored.mode === 'shared') {
		try {
			sessionStorage.setItem(SHARED_MARKER_KEY, '1');
		} catch {
			/* no session storage */
		}
	}
} else {
	// No session to hold: a bridge the boot sweep raised must not linger
	// (it would keep answering presence for a signed-out machine).
	releaseBootPresence();
}
