/* The trace->plan links, PURELY DYNAMIC (recorded decision): an outing
 * never stores which plan it flew - the link is computed against the
 * CURRENT catalog, so editing or deleting a plan re-links or detaches
 * its traces automatically and no historic view can drift. What IS
 * stored (the `links` IndexedDB store) is a cache of the computation,
 * valid only while the catalog still hashes to the value it was
 * computed under: any import, store or delete changes the hash, and the
 * next listing recomputes every link in the background, serially,
 * updating the reactive map row by row (the rederiveStale idiom). A
 * computed no-match caches too (planId null), so unmatched traces are
 * not re-folded every session.
 *
 * The matcher run is the importer's own recipe: candidates from the
 * stored catalog (buildCandidatePlan against current data), the touch
 * evidence from the summary fold's lookups, matchTraceToPlans. The
 * importer PRIMES the cache with the match it just computed, so a fresh
 * import costs one fold, not two. */

import {
	buildCandidatePlan,
	matchTraceToPlans,
	traceTouchEvidence,
	type CandidatePlan,
} from '$lib/nav/planMatch';
import { extendMotion, newMotionFold } from '$lib/nav/navlogLive';
import { parseRoutesDoc } from '$lib/route/yaml';
import { ensureAirports, ensureNavaids } from './data.svelte';
import {
	getMetas,
	getPoints,
	getStoredLinks,
	getStoredPlans,
	putStoredLink,
	type StoredPlan,
} from './flightsDb';
import { flownRouteLabelsFor } from './flightRows';
import { summaryDeps } from './flightLibrary.svelte';
import { djb2 } from './hash';
import { resolveWaypointToken } from './waypointSearch.svelte';

export interface FlightLink {
	planId: string | null;
	labels: string[];
}

/** The reactive links: outing id -> computed link. Absent = not yet
 *  computed this session (treated as no link by the display until the
 *  background pass lands). */
export const flightLinks = $state<{
	byOuting: Record<number, FlightLink>;
	/** True while the background recompute pass runs. */
	computing: boolean;
}>({ byOuting: {}, computing: false });

/** The catalog-content hash every cached link is keyed under. Each
 *  entry's yaml contributes its LENGTH beside the hash: djb2 is 32 bits,
 *  and a silent collision here would pin every link to a stale match with
 *  nothing to notice it by. `savedAtMs` is deliberately absent, so a
 *  no-op re-store does not invalidate the whole cache. */
export function catalogHash(plans: readonly StoredPlan[]): string {
	const parts = plans
		.map((p) => `${p.id}:${p.yaml.length}:${djb2(p.yaml)}`)
		.sort()
		.join(' ');
	return djb2(parts);
}

function candidatesFrom(plans: readonly StoredPlan[]): CandidatePlan[] {
	const out: CandidatePlan[] = [];
	for (const sp of plans) {
		try {
			const plan = buildCandidatePlan(sp.id, sp.yaml, parseRoutesDoc(sp.yaml), resolveWaypointToken);
			if (plan) {
				plan.catalogId = sp.id;
				out.push(plan);
			}
		} catch {
			/* an unreadable stored plan links nothing */
		}
	}
	return out;
}

/** Non-reactive in-flight guard (the refreshList doctrine); a request
 *  arriving while a pass runs is remembered and runs once more, so a
 *  catalog mutation mid-pass still lands on the latest hash. */
let running = false;
let rerun = false;

/** Prime one outing's link (the importer's shortcut: it already ran the
 *  matcher). Stored under the CURRENT catalog hash. */
export async function primeLink(outingId: number, link: FlightLink): Promise<void> {
	flightLinks.byOuting[outingId] = link;
	try {
		const hash = catalogHash(await getStoredPlans());
		await putStoredLink({ id: outingId, catalogHash: hash, planId: link.planId, labels: link.labels });
	} catch {
		/* the background pass recomputes it */
	}
}

/** Serve cached links and recompute the stale ones in the background.
 *  Call whenever the links may be consulted (the listing) or the
 *  catalog changed (import, store, delete): entries whose hash matches
 *  the current catalog serve as-is; everything else re-folds serially,
 *  each result updating the reactive map and the cache. */
export async function ensureLinks(): Promise<void> {
	if (running) {
		rerun = true;
		return;
	}
	running = true;
	flightLinks.computing = true;
	try {
		do {
			rerun = false;
			await linksOnce();
		} while (rerun);
	} finally {
		flightLinks.computing = false;
		running = false;
	}
}

async function linksOnce(): Promise<void> {
	try {
		await Promise.all([ensureAirports(), ensureNavaids()]);
	} catch {
		/* candidates resolve what they can; a failed load links less and the
		   next pass (fresh hash after any catalog change) retries */
	}
	const plans = await getStoredPlans();
	const hash = catalogHash(plans);
	const cached = await getStoredLinks();
	const fresh = new Map(cached.filter((l) => l.catalogHash === hash).map((l) => [l.id, l]));
	const metas = (await getMetas()).filter((m) => m.source === 'trace');
	// Orphans first: an outing deleted since the last pass leaves its
	// reactive entry behind, and the same trace re-added under the same id
	// (its first fix's instant) would wear the old plan's labels until a
	// fold replaced them. deleteOuting drops the STORED row; this is the
	// only place that sees both sides.
	const live = new Set(metas.map((m) => m.id));
	for (const key of Object.keys(flightLinks.byOuting)) {
		if (!live.has(Number(key))) {
			delete flightLinks.byOuting[Number(key)];
		}
	}
	// Serve every fresh entry first, so the surface settles instantly.
	for (const m of metas) {
		const hit = fresh.get(m.id);
		if (hit) {
			flightLinks.byOuting[m.id] = { planId: hit.planId, labels: hit.labels };
		}
	}
	const stale = metas.filter((m) => !fresh.has(m.id));
	if (stale.length === 0) {
		return;
	}
	const candidates = candidatesFrom(plans);
	for (const m of stale) {
		if (rerun) {
			return; // the catalog moved again; restart on the new hash
		}
		const points = await getPoints(m.id);
		if (!points) {
			continue;
		}
		const motion = extendMotion(newMotionFold(), points);
		if (motion.takeoffMs == null) {
			continue;
		}
		const deps = summaryDeps(m.datum);
		const touches = traceTouchEvidence(points, motion, deps.altMslFt, deps.fieldElevFt);
		const match = matchTraceToPlans(points, motion, candidates, touches);
		const link: FlightLink =
			match.kind === 'match'
				? {
						planId: match.plan.catalogId ?? null,
						labels: flownRouteLabelsFor(match.plan.routes, match.segments),
					}
				: { planId: null, labels: [] };
		flightLinks.byOuting[m.id] = link;
		try {
			await putStoredLink({ id: m.id, catalogHash: hash, planId: link.planId, labels: link.labels });
		} catch {
			/* stays session-only; recomputed next boot */
		}
	}
}
