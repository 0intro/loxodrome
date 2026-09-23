/* The alert stack's one render model (nav/alertSurface.ts) over its two
 * evaluators: the volumes (state/airspaceAlert.svelte.ts) and the ground
 * ahead (state/terrainAlert.svelte.ts). Its own module so that neither
 * evaluator's state imports the other's for it (the terrain one already
 * reads the alerts' master switch from the airspace one), and the one door
 * an acknowledgement goes through, routed by the row's subject: each
 * evaluator keeps its own ledger at its own ranks.
 *
 * Memoised like the evaluators: every reactive input is read before the
 * cache check, and the fold's row-order memory advances once per change
 * however many surfaces read it. That memory is presentation memory, so it
 * resets on the evaluators' own two rules: a replaced trace (a new session)
 * and a backward playhead jump (a replay rewound). Plain .ts: no rune of its
 * own, the inputs are the evaluators' tracked reads. */

import { alertSurface, type AlertSurfaceModel, type SurfaceAlert } from '$lib/nav/alertSurface';
import type { TrackPoint } from '$lib/nav/trace';
import { acknowledgeAlert, airspaceAlerts, alertInputGaps, alertSuspension } from './airspaceAlert.svelte';
import {
	acknowledgeTerrainAlert,
	terrainAlerts,
	terrainInhibited,
	terrainInputGaps,
} from './terrainAlert.svelte';
import { autoStop } from './autoStop.svelte';
import { nav, positionQuality } from './navRecording.svelte';

let prevOrder: readonly string[] = [];
let memoSig: unknown[] | null = null;
let memoModel: AlertSurfaceModel | null = null;
let sessionPoints: readonly TrackPoint[] | null = null;
let lastNowMs = 0;

function sameSig(a: unknown[], b: unknown[]): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The strip's render model: the one banner row, the channel chip, the
 *  panel sections and the region order, over both evaluations. */
export function alertSurfaceNow(): AlertSurfaceModel {
	const airspace = airspaceAlerts();
	const terrain = terrainAlerts();
	const suspended = alertSuspension();
	const gaps = alertInputGaps();
	const terrainGaps = terrainInputGaps();
	const inhibited = terrainInhibited();
	const stopPending = autoStop.pending != null;
	const stale = nav.recording && positionQuality() !== 'good';
	const points = nav.points;
	const nowMs = nav.recording ? Math.max(nav.playheadMs, nav.nowMs) : nav.playheadMs;
	if (sessionPoints !== points) {
		sessionPoints = points;
		prevOrder = [];
		memoSig = null;
		memoModel = null;
	} else if (nowMs < lastNowMs - 1000) {
		prevOrder = [];
	}
	lastNowMs = nowMs;
	const sig: unknown[] = [
		airspace,
		terrain,
		suspended,
		gaps?.airspaces ?? false,
		gaps?.briefing ?? false,
		terrainGaps?.unread ?? false,
		terrainGaps?.obstacles ?? false,
		inhibited,
		stopPending,
		stale,
	];
	if (memoModel && memoSig && sameSig(memoSig, sig)) {
		return memoModel;
	}
	const alerts: SurfaceAlert[] = [...(airspace?.alerts ?? []), ...(terrain?.alerts ?? [])];
	const model = alertSurface({
		alerts,
		suspended,
		gaps,
		terrainGaps,
		terrainInhibited: inhibited,
		stopPending,
		stale,
		prevOrder,
	});
	prevOrder = model.order;
	memoSig = sig;
	memoModel = model;
	return model;
}

/** Acknowledge one row in its own evaluator's ledger, at the rank that
 *  evaluator grades it (a volume by severity, a terrain row by level): an
 *  escalation past it alerts again. */
export function acknowledgeSurfaceAlert(a: SurfaceAlert): void {
	if (a.subject === 'terrain') {
		acknowledgeTerrainAlert(a.kind);
	} else {
		acknowledgeAlert(a.key);
	}
}
