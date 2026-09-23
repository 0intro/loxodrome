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
 * key is deliberately unregistered in reset.ts: a settings reset signs
 * the device out. */

import { isNativeApp } from '$lib/native/platform';
import { sha256HexOfText } from '$lib/sync/fingerprint';
import {
	ACCOUNT_KEY,
	LAST_ACCOUNT_KEY,
	LAST_MODE_KEY,
	PRESENCE_LOCK,
	SHARED_FLAG_KEY,
	SHARED_MARKER_KEY,
} from '$lib/sync/keys';
import { wipeLocalIdb, wipeLocalSync } from '$lib/sync/wipe';
import { releaseBootPresence } from '$lib/sync/bootSweep';
import { requestCode, verifyCode } from '$lib/sync/protocol';
import { i18n } from './i18n.svelte';
import { mutateSyncRegistry } from './syncRegistry';
import { readItem, readJson, removeItem, writeItem, writeJson } from './persist';

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

/** Verify the code and become signed in. `remember` is the device-mode
 *  checkbox: unchecked means shared. The engine's afterSignIn runs the
 *  adoption stamping and the first pass; the caller chains it. */
export async function completeSignIn(
	email: string,
	code: string,
	remember: boolean,
): Promise<SignInOutcome> {
	const mode: DeviceMode = remember ? 'personal' : 'shared';
	const prevShared = stored?.mode === 'shared' || readItem(SHARED_FLAG_KEY) !== null;
	const res = await verifyCode(email.trim(), code.trim(), deviceNameGuess(), mode);
	const breadcrumb = await sha256HexOfText(`acct:${email.trim().toLowerCase()}`);
	const previous = readItem(LAST_ACCOUNT_KEY);
	const differentAccount = previous !== null && previous !== breadcrumb;
	if (differentAccount) {
		if (prevShared) {
			// A shared session's leftovers must never bleed into another
			// account (an expired club session someone signs OVER).
			await wipeLocalIdb(wipeLocalSync());
		}
		// The registry's docs / tombstones / lastSeq are per-ACCOUNT state
		// (revs and seqs mean nothing across accounts); only the device id
		// is the device's own.
		await mutateSyncRegistry((r) => {
			r.docs = {};
			r.tombstones = [];
			r.lastSeq = 0;
			delete r.preexisting;
		});
	}
	writeItem(LAST_ACCOUNT_KEY, breadcrumb);
	writeItem(LAST_MODE_KEY, mode);
	stored = {
		v: 1,
		token: res.token,
		email: email.trim().toLowerCase(),
		userId: res.userId,
		mode,
		status: res.status,
		signedInAtMs: Date.now(),
	};
	writeJson(ACCOUNT_KEY, stored);
	account.email = stored.email;
	account.userId = stored.userId;
	account.mode = mode;
	account.status = res.status;
	account.signedInAtMs = stored.signedInAtMs;
	account.authExpired = false;
	if (mode === 'shared') {
		writeItem(SHARED_FLAG_KEY, '1');
		try {
			sessionStorage.setItem(SHARED_MARKER_KEY, '1');
		} catch {
			/* no session storage: the 12 h token cap still bounds it */
		}
	} else {
		// A stale shared flag on a now-PERSONAL device would make the next
		// boot's sweep read flag-without-marker and wipe a keeper.
		removeItem(SHARED_FLAG_KEY);
		try {
			sessionStorage.removeItem(SHARED_MARKER_KEY);
		} catch {
			/* no session storage */
		}
	}
	holdPresenceLock();
	return { created: res.created, status: res.status, differentAccount };
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
