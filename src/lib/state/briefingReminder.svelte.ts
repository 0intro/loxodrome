/* The reminder at the RTBA release, Android only (docs/android.md, "The
 * briefing reminder"). While the verdict waits for the release and the app
 * would then fetch the briefing by itself (notam/briefingRefresh.ts
 * reminderDue), a notification is set for the release, so a pilot away from
 * the app learns that a fetch now brings the day's activity. It is taken
 * back once the reason is gone. BriefingHost runs syncBriefingReminder as an
 * effect and reads the permission when the app starts and comes back. The
 * map notice's Remind me asks for it. */

import { untrack } from 'svelte';
import { isNativeApp } from '$lib/native/platform';
import {
	cancelReminder,
	reminderPermission,
	requestReminderPermission,
	scheduleReminder,
	type ReminderPermission,
} from '$lib/native/reminder';
import { reminderDue } from '$lib/notam/briefingRefresh';
import { dayKey } from '$lib/notam/briefingVerdict';
import { briefingReplaceable, briefingSourceReady, briefingVerdictNow, briefingWatch } from './briefing.svelte';
import { display } from './display.svelte';
import { t } from './i18n.svelte';
import { nav } from './navRecording.svelte';
import { plannedFlightAt } from './timeWindow.svelte';

/** The notification permission as last read, null on the web, on a shell
 *  without the plugin, and until the first read, and whether the pilot's
 *  last Remind me was refused, until the permission is granted. */
export const briefingReminder = $state<{ permission: ReminderPermission | null; refused: boolean }>({
	permission: null,
	refused: false,
});

/** The reminder the verdict asks for, whatever the permission: its instant
 *  and day, the instant passed once the release has. For the planned
 *  flight alone, on the ground: during a recording, or once the planned
 *  window has passed, the verdict judges a window rolling from the present,
 *  whose day no reminder is for. */
export function reminderNow(nowMs = Date.now()): { atMs: number; dayMs: number } | null {
	return reminderDue({
		planned: !nav.recording && plannedFlightAt().toMs > nowMs,
		enabled: display.autoNotams,
		sourceReady: briefingSourceReady(),
		replaceable: briefingReplaceable(),
		reasons: briefingVerdictNow().reasons,
	});
}

/** What the plugin was last handed: the note, or '' once taken back, and
 *  the release it was for. Plain, so a re-run calls the plugin on a change
 *  alone. */
let sent: string | null = null;
let sentAt: number | null = null;

/** Set the reminder, or take it back, as the verdict and the permission
 *  stand. The strings go straight to the notification, read now so they
 *  carry the locale in force. It waits for the plan's restore and the
 *  first read of the permission: the alarm the last session set stands
 *  until then.
 *
 *  A reminder handed stands past its release: the notification it posts
 *  stays up until the reason goes, the app alive in the background or
 *  killed. A reminder whose release passed before this session handed it
 *  is taken back, with whatever the last session set: the pilot is in the
 *  app, which fetches now. */
export function syncBriefingReminder(nowMs = Date.now()): void {
	if (!isNativeApp() || !briefingWatch.restored || briefingReminder.permission === null) {
		return;
	}
	const due = briefingReminder.permission === 'granted' ? reminderNow(nowMs) : null;
	const note = due && {
		atMs: due.atMs,
		title: t.briefing.reminderTitle,
		text: t.briefing.reminderText(dayKey(due.dayMs)),
		channel: t.briefing.reminderChannel,
	};
	const key = note ? JSON.stringify(note) : '';
	if (key === sent) {
		return;
	}
	// Past its release, the reminder handed for it stands as it was sent,
	// a language changed since included: its notification may be up.
	if (note && note.atMs <= nowMs && note.atMs === sentAt) {
		return;
	}
	const set = note !== null && note.atMs > nowMs;
	const want = set ? key : '';
	if (want === sent) {
		return;
	}
	sent = want;
	sentAt = set ? note.atMs : null;
	untrack(() => {
		void (set && note ? scheduleReminder(note) : cancelReminder());
	});
}

/** Read the permission: at the start, each time the app comes back and
 *  each time its window regains focus, since the pilot may answer Android
 *  elsewhere meanwhile (its settings, the recorder's own question). */
export async function readReminderPermission(): Promise<void> {
	const p = await reminderPermission();
	briefingReminder.permission = p;
	if (p === 'granted') {
		briefingReminder.refused = false;
	}
}

/** The notice's Remind me: Android's question, then the effect sets the
 *  reminder if the answer allows it, and the row says a refusal. */
export async function askReminderPermission(): Promise<void> {
	const p = await requestReminderPermission();
	briefingReminder.permission = p;
	briefingReminder.refused = p !== null && p !== 'granted';
}
