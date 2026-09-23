/* The attention channel: synthesized tones for the alerts, no assets and
 * no network. Strictly opt-in: browsers require a user gesture before
 * audio, so the Navigation-tab arm toggle doubles as the unlock
 * (armAlertAudio runs in its click), and an unarmed channel plays nothing.
 * Single-shot discipline lives upstream: each evaluator emits each edge
 * once, and the state modules' fired-edge queues (drainAlertFires in
 * state/airspaceAlert.svelte.ts, drainTerrainFires in
 * state/terrainAlert.svelte.ts) hand a drained batch to exactly one
 * consumer run, so a re-running effect cannot replay a chime. Haptics
 * ride along where the platform has them (navigator.vibrate; absent on
 * Apple devices).
 *
 * The terrain figures are their own family, so the ear tells the ground
 * from a zone before the eye reaches the banner: a warning is two rising
 * sweeps, the shape of the GPWS whoop without its words (the advisory
 * posture: no "pull up"), a caution two level notes. The tones are
 * browser-only and exercised manually, the map/terrain.ts precedent; the
 * choice of figure is pure and pinned (tests/alertSounds.spec.ts). */

import type { AlertFire } from './airspaceAlert';
import type { TerrainFire } from './terrainAlert';

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

/** A tone gliding between two pitches: the terrain figures' element, unlike
 *  any airspace chime. */
function sweep(t0: number, fromHz: number, toHz: number, durS: number, peak: number): void {
	if (!ctx) {
		return;
	}
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.type = 'triangle';
	osc.frequency.setValueAtTime(fromHz, t0);
	osc.frequency.exponentialRampToValueAtTime(toHz, t0 + durS);
	gain.gain.setValueAtTime(0.0001, t0);
	gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
	gain.gain.setValueAtTime(peak, t0 + durS - 0.04);
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

/** The terrain warning: two rising sweeps, 400 to 800 Hz. */
export function playTerrainWarning(): void {
	if (!ready() || !ctx) {
		return;
	}
	const t = ctx.currentTime + 0.02;
	sweep(t, 400, 800, 0.35, 0.4);
	sweep(t + 0.45, 400, 800, 0.35, 0.4);
	vibrate([220, 90, 220]);
}

/** The terrain caution: two level notes, a step apart from the single
 *  airspace caution tick. */
export function playTerrainCaution(): void {
	if (!ready() || !ctx) {
		return;
	}
	const t = ctx.currentTime + 0.02;
	beep(t, 660, 0.14, 0.3);
	beep(t + 0.2, 660, 0.14, 0.3);
	vibrate([70, 60, 70]);
}

/** The arm toggle's confirmation, so the pilot hears what armed means. */
export function playTest(): void {
	playWarning();
}

export type FireFigure = 'terrainWarning' | 'warning' | 'terrainCaution' | 'caution';

/** The ONE figure a pass plays, in the order of urgency: a terrain warning,
 *  an airspace warning, a terrain caution, an airspace caution. An airspace
 *  caution chimes only behind its own preference; a terrain caution is a
 *  minute from the ground and chimes whenever the channel is armed. */
export function fireFigure(
	fires: { airspace: readonly AlertFire[]; terrain: readonly TerrainFire[] },
	opts: { caution: boolean },
): FireFigure | null {
	if (fires.terrain.some((f) => f.level === 'warning')) {
		return 'terrainWarning';
	}
	if (fires.airspace.some((f) => f.action !== 'caution')) {
		return 'warning';
	}
	if (fires.terrain.length > 0) {
		return 'terrainCaution';
	}
	if (opts.caution && fires.airspace.length > 0) {
		return 'caution';
	}
	return null;
}

/** Play a pass's drained edges from both evaluators (the state-owned queue
 *  hand-off; each edge reaches exactly one call): one figure, never a
 *  medley. */
export function playFireBatch(
	fires: { airspace: readonly AlertFire[]; terrain: readonly TerrainFire[] },
	opts: { caution: boolean },
): void {
	switch (fireFigure(fires, opts)) {
		case 'terrainWarning':
			playTerrainWarning();
			break;
		case 'warning':
			playWarning();
			break;
		case 'terrainCaution':
			playTerrainCaution();
			break;
		case 'caution':
			playCaution();
			break;
		case null:
			break;
	}
}
