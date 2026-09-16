/* The attention channel: synthesized tones for the airspace alerts, no
 * assets and no network. Strictly opt-in: browsers require a user gesture
 * before audio, so the Navigation-tab arm toggle doubles as the unlock
 * (armAlertAudio runs in its click), and an unarmed channel plays nothing.
 * Single-shot discipline lives upstream: the evaluator emits each edge
 * once, and the state module's fired-edge queue (drainAlertFires in
 * state/airspaceAlert.svelte.ts) hands a drained batch to exactly one
 * consumer run, so a re-running effect cannot replay a chime. Haptics
 * ride along where the platform has them (navigator.vibrate; absent on
 * Apple devices). Browser-only, exercised manually, the map/terrain.ts
 * precedent. */

import type { AlertFire } from './airspaceAlert';

let ctx: AudioContext | null = null;

/** Create / resume the audio context. MUST be called from a user gesture
 *  (the arm toggle's click); returns false where Web Audio is missing. */
export function armAlertAudio(): boolean {
	if (typeof window === 'undefined' || !('AudioContext' in window)) {
		return false;
	}
	ctx = ctx ?? new AudioContext();
	void ctx.resume();
	return true;
}

/** Let the context idle; a re-arm resumes it. */
export function disarmAlertAudio(): void {
	void ctx?.suspend();
}

let gestureHooked = false;

/** A persisted-on channel cannot resume audio without a gesture after a
 *  reload; hook the next pointer or key press once so the first touch
 *  anywhere re-arms it silently. */
export function armAlertAudioOnGesture(): void {
	if (gestureHooked || typeof window === 'undefined') {
		return;
	}
	if (ctx != null && ctx.state === 'running') {
		return;
	}
	gestureHooked = true;
	const arm = (): void => {
		armAlertAudio();
	};
	window.addEventListener('pointerdown', arm, { once: true });
	window.addEventListener('keydown', arm, { once: true });
}

function beep(t0: number, freqHz: number, durS: number, peak: number): void {
	if (!ctx) {
		return;
	}
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.type = 'sine';
	osc.frequency.value = freqHz;
	gain.gain.setValueAtTime(0.0001, t0);
	gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.01);
	gain.gain.setValueAtTime(peak, t0 + durS - 0.03);
	gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durS);
	osc.connect(gain).connect(ctx.destination);
	osc.start(t0);
	osc.stop(t0 + durS);
}

function vibrate(pattern: number[]): void {
	if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
		navigator.vibrate(pattern);
	}
}

function ready(): boolean {
	return ctx != null && ctx.state === 'running';
}

/** The warning chime: a three-note attention figure for the forbidden /
 *  clearance / equipment tiers. */
export function playWarning(): void {
	if (!ready() || !ctx) {
		return;
	}
	const t = ctx.currentTime + 0.02;
	beep(t, 880, 0.16, 0.35);
	beep(t + 0.2, 1175, 0.16, 0.35);
	beep(t + 0.4, 880, 0.16, 0.35);
	vibrate([120, 80, 120]);
}

/** The caution tick: one soft low note. */
export function playCaution(): void {
	if (!ready() || !ctx) {
		return;
	}
	beep(ctx.currentTime + 0.02, 620, 0.14, 0.2);
	vibrate([60]);
}

/** The arm toggle's confirmation, so the pilot hears what armed means. */
export function playTest(): void {
	playWarning();
}

/** Play a drained batch of sound edges (the state-owned queue hand-off;
 *  each edge reaches exactly one call). Warning tones dominate; cautions
 *  chime only behind their own preference. */
export function playAlertFireList(fires: readonly AlertFire[], opts: { caution: boolean }): void {
	if (fires.length === 0) {
		return;
	}
	let warning = false;
	let caution = false;
	for (const f of fires) {
		if (f.action === 'caution') {
			caution = true;
		} else {
			warning = true;
		}
	}
	if (warning) {
		playWarning();
	} else if (caution && opts.caution) {
		playCaution();
	}
}
