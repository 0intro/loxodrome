/* Best-effort localStorage wrappers shared by every persisting module.
 * All storage failures (private mode, quota, disabled or absent storage)
 * are swallowed: persistence is a convenience, never load-bearing, so a
 * storage error must not crash the caller. Reads degrade to null. */

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
	try {
		localStorage.removeItem(key);
	} catch {
		/* storage unavailable */
	}
}
