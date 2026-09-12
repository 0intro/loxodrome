/* Pure helpers for the Plans view (the route catalog listing): one
 * stored plan's row derived AS THE MATCHER SEES IT, and the per-yaml
 * outing use counts. Plain TS (no Svelte, no storage I/O) so the pins
 * run without an IndexedDB harness; locale-free by construction
 * (ident-built chain labels, raw upstream parser lines). */

import { buildCandidatePlan } from '$lib/nav/planMatch';
import { planFileSubject, routeEndpointLabel } from '$lib/route/routeLabel';
import { parseRoutesDoc } from '$lib/route/yaml';
import type { WaypointAnchor } from './route.svelte';

/** One route of the chain a row prints. `alternate` rides along because a
 *  diversion is not a step of the day: the Plans view demotes it the way
 *  the route strip and the map already do (italic there, dashed on the
 *  map), and a flat string list left the whole plan reading as one run of
 *  equal legs. */
export interface ChainLeg {
	label: string;
	alternate: boolean;
}

/** The catalog row's validation verdict, the ForeFlight
 *  validate-saved-routes idea mapped onto our own candidate builder:
 *  'ok' lists the route chain the matcher would fold, 'empty' means the
 *  file parsed but resolved no usable route, 'error' carries the
 *  parser's own line (raw upstream EN, the routeLoad decision).
 *  `dropped` lists the anchored idents the CURRENT datasets no longer
 *  resolve, which is both the AIRAC-breakage hint and the reason a row
 *  went 'empty'. */
export type PlanRowState =
	| { kind: 'ok'; chain: ChainLeg[]; dropped: string[] }
	| { kind: 'empty'; dropped: string[] }
	| { kind: 'error'; detail: string };

/** One catalog row as the Plans view reads it. The name and the file base sit
 *  OUTSIDE the verdict union on purpose: neither is something the matcher
 *  decided, and a row whose yaml will not parse still needs both fields
 *  answered. */
export interface PlanRow {
	/** The plan's own descriptive name, null when the file states none (or
	 *  cannot be read). A caption for the chain, never the row's identity. */
	name: string | null;
	/** The SUBJECT field of every file this plan hands back (download,
	 *  export-all; docs/file-names.md): its name when it has one, else the
	 *  aerodrome chain, else '' - which the grammar omits, leaving "plan.yaml". */
	baseName: string;
	state: PlanRowState;
}

/** Derive one stored plan's listing state through the matcher's own
 *  reading (parseRoutesDoc + buildCandidatePlan with the injected
 *  resolver): what this file matches TODAY, against current data. */
export function derivePlanRow(
	yaml: string,
	resolve: (token: string) => WaypointAnchor | null,
	yearOverride?: number,
): PlanRow {
	try {
		const parsed = parseRoutesDoc(yaml);
		const name = parsed.planName ?? null;
		const dropped: string[] = [];
		for (const r of parsed.routes) {
			for (const w of r.waypoints) {
				if (w.ident && !resolve(w.ident) && !dropped.includes(w.ident)) {
					dropped.push(w.ident);
				}
			}
		}
		const plan = buildCandidatePlan('', yaml, parsed, resolve, yearOverride);
		if (!plan) {
			// A named plan still names its own file, even when current data leaves
			// it with no usable route to chain.
			return { name, baseName: planFileSubject(name, []), state: { kind: 'empty', dropped } };
		}
		return {
			name,
			baseName: planFileSubject(name, plan.routes),
			state: {
				kind: 'ok',
				chain: plan.routes
					.map((r) => ({ label: routeEndpointLabel(r, ''), alternate: r.alternate === true }))
					.filter((c) => c.label !== ''),
				dropped,
			},
		};
	} catch (err) {
		return {
			name: null,
			baseName: '',
			state: { kind: 'error', detail: err instanceof Error ? err.message : String(err) },
		};
	}
}

/** The hover-preview ghost's geometry: one lat/lon line per usable
 *  route of the stored plan, derived through the matcher's own reading
 *  (the derivePlanRow recipe), so the ghost shows exactly what an
 *  activation would load. Unreadable yaml previews nothing. */
export function planPreviewLines(
	yaml: string,
	resolve: (token: string) => WaypointAnchor | null,
	yearOverride?: number,
): [number, number][][] {
	try {
		const plan = buildCandidatePlan('', yaml, parseRoutesDoc(yaml), resolve, yearOverride);
		if (!plan) {
			return [];
		}
		return plan.routes.map((r) => r.waypoints.map((w) => [w.lat, w.lon] as [number, number]));
	} catch {
		return [];
	}
}

/** The ZIP export's collision rule over FINAL file names: the compare
 *  normalizes the /\.ya?ml$/i suffix away and is case-insensitive; a
 *  free base takes `.yaml`, a taken one inserts -N BEFORE the extension
 *  ("LFPL-LFOX-2.yaml"), so same-chain plan variants each keep a file
 *  in the archive. */
export function nextPlanName(base: string, taken: Iterable<string>): string {
	const norm = (n: string): string => n.replace(/\.ya?ml$/i, '').toLowerCase();
	const used = new Set<string>();
	for (const t of taken) {
		used.add(norm(t));
	}
	const stem = base.replace(/\.ya?ml$/i, '');
	if (!used.has(norm(stem))) {
		return `${stem}.yaml`;
	}
	for (let n = 2; ; n++) {
		if (!used.has(norm(`${stem}-${n}`))) {
			return `${stem}-${n}.yaml`;
		}
	}
}

