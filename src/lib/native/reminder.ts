/* The briefing reminder's native half (docs/android.md, "The briefing
 * reminder"): one notification at an instant, set as an inexact alarm by
 * the local Reminder plugin (ReminderPlugin.java) and posted by
 * ReminderReceiver.java with the app running or killed.
 *
 * On the web every call returns at once. The dynamic import keeps
 * @capacitor/* out of the web bundle (platform.ts), and the handle is PARKED
 * in the module: a plugin handle is a Proxy that answers every property, so
 * resolving a promise with one turns the await machinery's `.then` probe
 * into a plugin call that rejects (the native/openFile.ts trap). */

import { isNativeApp } from './platform';

/** The notification permission, the reminder's channel included: 'prompt'
 *  while it is not granted and a request may still ask the pilot (Android
 *  answers one at once after two refusals). */
export type ReminderPermission = 'granted' | 'prompt' | 'denied';

/** The notification's strings (JS-localized: the shell has no values-fr)
 *  and its channel's name, which Android's settings list. */
export interface ReminderNote {
	atMs: number;
	title: string;
	text: string;
	channel: string;
}

interface NativeReminder {
	schedule(opts: ReminderNote): Promise<void>;
	cancel(): Promise<void>;
	permission(): Promise<{ state?: string }>;
	requestPermission(): Promise<{ state?: string }>;
}

let reminder: NativeReminder | null = null;

async function ensurePlugin(): Promise<void> {
	if (!reminder) {
		const { registerPlugin } = await import('@capacitor/core');
		reminder = registerPlugin<NativeReminder>('Reminder');
	}
}

function permissionOf(r: { state?: string } | undefined): ReminderPermission | null {
	switch (r?.state) {
		case 'granted':
			return 'granted';
		case 'prompt':
		case 'prompt-with-rationale':
			return 'prompt';
		case 'denied':
			return 'denied';
		default:
			return null;
	}
}

/** The permission, null on the web or a shell without the plugin. */
export async function reminderPermission(): Promise<ReminderPermission | null> {
	if (!isNativeApp()) {
		return null;
	}
	try {
		await ensurePlugin();
		return permissionOf(await reminder?.permission());
	} catch {
		return null;
	}
}

/** Ask for the permission (from Android 13, the system's question) and
 *  answer what it then is. */
export async function requestReminderPermission(): Promise<ReminderPermission | null> {
	if (!isNativeApp()) {
		return null;
	}
	try {
		await ensurePlugin();
		return permissionOf(await reminder?.requestPermission());
	} catch {
		return null;
	}
}

/** Set the reminder, replacing the one set before. */
export async function scheduleReminder(note: ReminderNote): Promise<void> {
	if (!isNativeApp()) {
		return;
	}
	try {
		await ensurePlugin();
		await reminder?.schedule(note);
	} catch {
		/* a shell without the plugin */
	}
}

/** Take the reminder back, and its notification if it is up. */
export async function cancelReminder(): Promise<void> {
	if (!isNativeApp()) {
		return;
	}
	try {
		await ensurePlugin();
		await reminder?.cancel();
	} catch {
		/* a shell without the plugin */
	}
}
