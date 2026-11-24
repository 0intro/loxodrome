/* The datasets a NOTAM's own relationship lists read beyond the ones every
 * briefing loads: the obstacle registers behind an obstacle NOTAM's "Affected
 * obstacles", the navaid datasets behind a navaid NOTAM's "Affected navaids".
 * Loaded on demand and gated on the Q-code, so an unrelated NOTAM never pulls
 * the large obstacle set, and loaded even with those layers off, so the lists
 * fill and a row still highlights on the map.
 *
 * Never in the NOTAM Viewer, which reads neither, by decision: its manifest
 * (src/notam/datasets.ts) is the datasets the NOTAM relationship mechanisms
 * need and nothing else. Published inside the flight app's site, whose /data/
 * carries both, the load answered there: an obstacle NOTAM over Zurich fetched
 * 22 files the manifest does not name, and the panel listed Swiss and Finnish
 * obstacles from registers the viewer's About credits nowhere. Plain .ts: it
 * holds no state. */

import { isNotamViewer } from './appIdentity';
import { ensureNavaids, ensureObstacles } from './data.svelte';
import { isNavaidQCode } from './notamNavaidLinks.svelte';
import { isObstacleQCode } from './notamObstacleLinks.svelte';

/** Start loading what the NOTAM with this Q-code lists, fire and forget: a
 *  failed load leaves its list empty, which is an honest answer. */
export function ensureNotamLinkData(qCode: string): void {
	if (isNotamViewer()) {
		return;
	}
	if (isObstacleQCode(qCode)) {
		void ensureObstacles().catch(() => {});
	}
	if (isNavaidQCode(qCode)) {
		void ensureNavaids().catch(() => {});
	}
}
