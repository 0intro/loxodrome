/* One screen wake lock for the whole app, refcounted by holder tag: the
 * recording watch is today's only holder, and the lock stands while ANY
 * tag is held, so a second holder stays possible. The platform drops the sentinel
 * whenever the page hides, so a visibilitychange listener re-takes it on
 * return while holders remain (no user gesture needed, unlike audio).
 * Best-effort throughout: denial or absence of the API is silent, the
 * navRecording posture. Browser-only, exercised manually. */

let sentinel: WakeLockSentinel | null = null;
const holders = new Set<string>();
let hooked = false;

async function request(): Promise<void> {
	try {
		if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
			sentinel = await navigator.wakeLock.request('screen');
		}
	} catch {
		/* wake lock denied or unavailable */
	}
}

function onVisibility(): void {
	if (document.visibilityState !== 'hidden' && holders.size > 0) {
		void request();
	}
}

export function acquireWakeLock(tag: string): void {
	holders.add(tag);
	if (!hooked && typeof document !== 'undefined') {
		document.addEventListener('visibilitychange', onVisibility);
		hooked = true;
	}
	void request();
}

export function releaseWakeLock(tag: string): void {
	holders.delete(tag);
	if (holders.size > 0) {
		return;
	}
	try {
		void sentinel?.release();
	} catch {
		/* already released */
	}
	sentinel = null;
}
