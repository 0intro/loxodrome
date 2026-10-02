/* Best-effort localStorage wrappers shared by every persisting module.
 * All storage failures (private mode, quota, disabled or absent storage)
 * are swallowed: persistence is a convenience, never load-bearing, so a
 * storage error must not crash the caller. Reads degrade to null.
 *
 * Every write the app makes goes through here (the boot sweep's raw wipe
 * excepted), which is what lets sealStorage() stop them all at once. */

/** No write lands any more: set by sealStorage(). */
let sealed = false;

/** Stop every write and removal through this module for the rest of the
 *  document, right before a page that has just erased storage navigates away
 *  (Reset, a shared session's end). Between the erasure and the unload the
 *  page is still alive: a debounced route write, a layer effect re-run by the
 *  reset of its choices, a throttled map-view stamp or a sync applier would
 *  otherwise put an erased key straight back, and the next boot would read
 *  it. Reads are unaffected. */
export function sealStorage(): void {
	sealed = true;
}

/** Stored string, or null when the key is absent or storage fails. */
export function readItem(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

/** Parsed JSON for the key, or null when absent, malformed, or storage
 *  fails. Callers validate the decoded shape (version field) themselves. */
export function readJson<T>(key: string): T | null {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? null : (JSON.parse(raw) as T);
	} catch {
		return null;
	}
}

/** Best-effort write; failures are swallowed. */
export function writeItem(key: string, value: string): void {
	if (sealed) {
		return;
	}
	try {
		localStorage.setItem(key, value);
	} catch {
		/* storage unavailable */
	}
}

/** Best-effort JSON write. Returns whether it landed, so a caller that is
 *  about to TELL the user something was saved can find out; every existing
 *  caller ignores it and keeps the old behaviour. */
export function writeJson(key: string, value: unknown): boolean {
	if (sealed) {
		return false;
	}
	try {
		localStorage.setItem(key, JSON.stringify(value));
		return true;
	} catch {
		/* storage unavailable or value not serialisable */
		return false;
	}
}

/** Best-effort removal; failures are swallowed. */
export function removeItem(key: string): void {
	if (sealed) {
		return;
	}
	try {
		localStorage.removeItem(key);
	} catch {
		/* storage unavailable */
	}
}

/** Every stored key starting with the prefix, collected in full before the
 *  caller removes any (a removal renumbers localStorage.key(i)); empty when
 *  storage fails. */
export function keysWithPrefix(prefix: string): string[] {
	const keys: string[] = [];
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (key !== null && key.startsWith(prefix)) {
				keys.push(key);
			}
		}
	} catch {
		/* storage unavailable: nothing stored */
	}
	return keys;
}
