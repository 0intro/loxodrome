/* The native background flight recorder (docs/android.md): while a recording
 * runs, NavRecorderService (an Android foreground service of type location)
 * owns the GPS, journals every raw fix, and emits it live; the web app's
 * recorder consumes both through this seam. The JOURNAL is the source of
 * truth and the events the low-latency path, so nothing here guarantees
 * delivery: navRecording drains the journal on boot, on return to the
 * foreground and on stop, and clears it only after a successful drain.
 *
 * No-op on the web. The dynamic import keeps @capacitor/* out of the web
 * bundle (platform.ts), and the handle is PARKED in the module: a plugin
 * handle is a Proxy that answers every property, so resolving a promise with
 * one turns the await machinery's `.then` probe into a plugin call that
 * rejects (the native/openFile.ts trap). The boot reconcile ensures the
 * handle early, so the fire-and-forget callers (reset's stop + clear, which
 * must outlive a location.reload()) dispatch synchronously off the cached
 * module. */

import { isNativeApp } from './platform';

/** The notification strings (JS-localized; the shell has no values-fr) and
 *  whether this start begins a fresh trace (truncating the journal). */
export interface NativeRecorderStart {
	title: string;
	text: string;
	stopLabel: string;
	fresh: boolean;
}

export interface NativeRecorderState {
	running: boolean;
	startedAtMs: number | null;
	/** Why a NATIVE-side stop ended the recording ('user' = the
	 *  notification's Stop action, 'autostop' = the dead-bridge safety
	 *  valve); null after a clean web-side stop. */
	stoppedReason: 'user' | 'autostop' | null;
	stoppedAtMs: number | null;
}

interface NativeRecorder {
	start(opts: { title: string; text: string; stopLabel: string; fresh: boolean }): Promise<void>;
	stop(): Promise<void>;
	drain(opts: { afterMs: number; limit: number }): Promise<{ fixes?: unknown[]; done?: boolean }>;
	getState(): Promise<{
		running?: boolean;
		startedAtMs?: number;
		stoppedReason?: string;
		stoppedAtMs?: number;
	}>;
	clearJournal(): Promise<void>;
	setAutoStop(opts: { enabled: boolean }): Promise<void>;
	batteryStatus(): Promise<{ ignoring?: boolean }>;
	openBatterySettings(): Promise<void>;
	addListener(event: string, handler: (data: unknown) => void): Promise<unknown>;
}

let recorder: NativeRecorder | null = null;

async function ensurePlugin(): Promise<void> {
	if (!recorder) {
		const { registerPlugin } = await import('@capacitor/core');
		recorder = registerPlugin<NativeRecorder>('NavRecorder');
	}
}

/**
 * Start the foreground service (requesting the location, and on Android 13+
 * the notification, permissions first). 'denied' maps to the recorder's
 * existing localized error state; 'unavailable' means an older shell without
 * the plugin (or a bridge failure), which the caller degrades to the
 * WebView's own watchPosition.
 */
export async function startNativeRecorder(
	opts: NativeRecorderStart,
): Promise<'ok' | 'denied' | 'unavailable'> {
	if (!isNativeApp()) {
		return 'unavailable';
	}
	try {
		await ensurePlugin();
		await recorder?.start(opts);
		return 'ok';
	} catch (e) {
		return e instanceof Error && e.message === 'denied' ? 'denied' : 'unavailable';
	}
}

/** Stop the service. The journal survives this on purpose; the caller
 *  drains it first and clears it itself. */
export async function stopNativeRecorder(): Promise<void> {
	if (!isNativeApp()) {
		return;
	}
	try {
		await ensurePlugin();
		await recorder?.stop();
	} catch {
		/* an older shell without the plugin */
	}
}

/** Every journalled raw fix strictly after afterMs, in order, chunked over
 *  the bridge. Returns [] on the web or when the shell has no plugin. */
export async function drainNativeAfter(afterMs: number): Promise<unknown[]> {
	if (!isNativeApp()) {
		return [];
	}
	const out: unknown[] = [];
	try {
		await ensurePlugin();
		let cursor = afterMs;
		for (;;) {
			const res = await recorder?.drain({ afterMs: cursor, limit: 2000 });
			const fixes = Array.isArray(res?.fixes) ? res.fixes : [];
			out.push(...fixes);
			if (res?.done !== false || fixes.length === 0) {
				break;
			}
			const last = fixes[fixes.length - 1] as { tMs?: unknown };
			const lastMs = typeof last.tMs === 'number' && Number.isFinite(last.tMs) ? last.tMs : null;
			if (lastMs == null || lastMs <= cursor) {
				break; // defensive: never loop on a journal that cannot advance
			}
			cursor = lastMs;
		}
	} catch {
		/* an older shell without the plugin */
	}
	return out;
}

export async function getNativeRecorderState(): Promise<NativeRecorderState | null> {
	if (!isNativeApp()) {
		return null;
	}
	try {
		await ensurePlugin();
		const st = await recorder?.getState();
		if (!st) {
			return null;
		}
		return {
			running: st.running === true,
			startedAtMs: typeof st.startedAtMs === 'number' ? st.startedAtMs : null,
			stoppedReason:
				st.stoppedReason === 'user' || st.stoppedReason === 'autostop' ? st.stoppedReason : null,
			stoppedAtMs: typeof st.stoppedAtMs === 'number' ? st.stoppedAtMs : null,
		};
	} catch {
		return null;
	}
}

export async function clearNativeJournal(): Promise<void> {
	if (!isNativeApp()) {
		return;
	}
	try {
		await ensurePlugin();
		await recorder?.clearJournal();
	} catch {
		/* an older shell without the plugin */
	}
}

/** Mirror the auto-stop preference to the service's dead-bridge safety
 *  valve (a pref on the native side, so ordering against start is free). */
export async function setNativeAutoStop(enabled: boolean): Promise<void> {
	if (!isNativeApp()) {
		return;
	}
	try {
		await ensurePlugin();
		await recorder?.setAutoStop({ enabled });
	} catch {
		/* an older shell without the plugin */
	}
}

/** Live fixes while the WebView exists; best-effort by design (the journal
 *  is the source of truth). */
export async function watchNativeFixes(handler: (fix: unknown) => void): Promise<void> {
	if (!isNativeApp()) {
		return;
	}
	try {
		await ensurePlugin();
		await recorder?.addListener('fix', handler);
	} catch {
		/* an older shell without the plugin */
	}
}

/** A native-side stop (notification action / safety valve) while the web
 *  app is alive. */
export async function watchNativeStopped(handler: (reason: string | null) => void): Promise<void> {
	if (!isNativeApp()) {
		return;
	}
	try {
		await ensurePlugin();
		await recorder?.addListener('stopped', (data) => {
			const reason = (data as { reason?: unknown } | null)?.reason;
			handler(reason === 'user' || reason === 'autostop' ? reason : null);
		});
	} catch {
		/* an older shell without the plugin */
	}
}

/** Whether the app is exempt from battery optimization; null when unknown
 *  (web, or an older shell). */
export async function nativeBatteryStatus(): Promise<boolean | null> {
	if (!isNativeApp()) {
		return null;
	}
	try {
		await ensurePlugin();
		const st = await recorder?.batteryStatus();
		return st?.ignoring === true;
	} catch {
		return null;
	}
}

/** Open the system battery-optimisation list, where the user lifts the
 *  restriction themselves. Not the one-tap grant dialog: that needs the
 *  REQUEST_IGNORE_BATTERY_OPTIMIZATIONS permission, which Play restricts to
 *  apps a location foreground service cannot already serve (docs/android.md). */
export async function nativeOpenBatterySettings(): Promise<void> {
	if (!isNativeApp()) {
		return;
	}
	try {
		await ensurePlugin();
		await recorder?.openBatterySettings();
	} catch {
		/* the settings screen is unavailable: the Settings app still has it */
	}
}
