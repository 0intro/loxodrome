/* The RECORDING lock (sync/keys.ts RECORDING_LOCK; docs/accounts-sync.md,
 * "Device modes"): held by the tab a recording runs in, asked by a tab
 * about to END a shared session (a sign-out, the 12 h cap, a sign-in over
 * it) and by a booting tab about to sweep one. An end in one tab otherwise
 * wiped a flight running in another: its crash copy and its workspace are
 * in the keys a session's end erases, and only the recording tab knew. The
 * presence lock's idiom, for its reason: locks survive background-tab
 * freezing, so a phone recording in a hidden tab still answers. A leaf, for
 * the boot sweep's import discipline. */

import { RECORDING_LOCK } from './keys';

/** Hold the lock until the returned function is called (SyncHost, while
 *  `nav.recording`). A release before the grant lets the grant go at once. */
export function holdRecordingLock(): () => void {
	const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
	if (!locks) {
		return () => {};
	}
	let release: (() => void) | null = null;
	let dropped = false;
	void locks.request(
		RECORDING_LOCK,
		{ mode: 'shared' },
		() =>
			new Promise<void>((resolve) => {
				if (dropped) {
					resolve();
					return;
				}
				release = resolve;
			}),
	);
	return () => {
		dropped = true;
		release?.();
		release = null;
	};
}

/** Whether a recording runs in any tab of the app, this one included. No
 *  locks API answers false: the single-tab assumption the boot sweep makes
 *  there too, where this tab's own `nav.recording` is the whole truth. */
export async function recordingInAnyTab(): Promise<boolean> {
	try {
		const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
		if (!locks || typeof locks.query !== 'function') {
			return false;
		}
		const state = await locks.query();
		return (state.held ?? []).some((l) => l.name === RECORDING_LOCK);
	} catch {
		return false;
	}
}
