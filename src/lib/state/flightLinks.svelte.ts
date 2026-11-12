/* The trace->plan links, PURELY DYNAMIC (recorded decision): an outing
 * never stores which plan it flew - the link is computed against the
 * CURRENT catalog, so editing or deleting a plan re-links or detaches
 * its traces automatically and no historic view can drift. What IS
 * stored (the `links` IndexedDB store) is a cache of the computation,
 * valid only while the catalog and what it resolves to still hash to the
 * key it was computed under (linkKey): any import, store or delete moves
 * the key, and so does a country's airports or navaids landing, a catalog
 * plan naming its aerodromes and navaids by ident; the next listing then
 * recomputes every link in the background, serially, updating the
 * reactive map row by row (the rederiveStale idiom). A computed no-match
 * caches too (planId null), so unmatched traces are not re-folded every
 * session.
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
import { dataState, ensureAirports, ensureNavaids } from './data.svelte';
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

/** What a catalog's plans resolved to: each candidate's routes, as the
 *  matcher reads them. A catalog plan names its aerodromes and navaids by
 *  ident, resolved against the datasets loaded, which load by area and can
 *  fail: an ident the data could not reach is a waypoint dropped, and a
 *  country landing later moves this hash. */
function candidatesHash(candidates: readonly CandidatePlan[]): string {
	const parts = candidates
		.map(
			(c) =>
				`${c.catalogId ?? c.name}|` +
				c.routes
					.map((r) => r.waypoints.map((w) => `${w.ident ?? ''}@${w.lat.toFixed(5)},${w.lon.toFixed(5)}`).join(';'))
					.join('/'),
		)
		.sort()
		.join(' ');
	return `${parts.length}:${djb2(parts)}`;
}

/** The key a link verdict is stored under: the catalog's content and what
 *  its plans resolved to. A verdict reached without a country's navaids is
 *  folded again once they land and the key moves, and one reached with
 *  them is reused while nothing moves, whatever failure persists: gated on
 *  the data having landed instead, a verdict was stored stale (reached
 *  before the data, stored after) or never stored at all while a read kept
 *  failing, every listing then folding every outing again. */
export function linkKey(plans: readonly StoredPlan[], candidates: readonly CandidatePlan[]): string {
	return `${catalogHash(plans)}:${candidatesHash(candidates)}`;
}

/** The airports' and navaids' identity this session: it moves whenever a
 *  merge publishes, which is what can change what a plan resolves to. The
 *  importer reads it when it builds its candidates, and a primed verdict is
 *  stored only if it has not moved since (primeLink). */
export function linkDataStamp(): string {
	return `${dataState.revision.airports}:${dataState.revision.navaids}`;
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

/** The key the current catalog and data give, kept while neither moves: a
 *  batch import primes one link per trace. */
let keyMemo: { catalog: string; stamp: string; key: string } | null = null;

async function currentLinkKey(): Promise<string> {
	const plans = await getStoredPlans();
	const catalog = catalogHash(plans);
	const stamp = linkDataStamp();
	if (keyMemo && keyMemo.catalog === catalog && keyMemo.stamp === stamp) {
		return keyMemo.key;
	}
	const key = linkKey(plans, candidatesFrom(plans));
	keyMemo = { catalog, stamp, key };
	return key;
}

/** Prime one outing's link (the importer's shortcut: it already ran the
 *  matcher). `matchedAt` is linkDataStamp when the importer built the
 *  candidates it matched against: stored under the current key only while
 *  the data has not moved since. A verdict reached before a country landed
 *  mid-import, stored after it, stood under the new key until the catalog
 *  next changed; it now shows for the session and the next pass folds it. */
export async function primeLink(outingId: number, link: FlightLink, matchedAt: string): Promise<void> {
	flightLinks.byOuting[outingId] = link;
	try {
		const key = await currentLinkKey();
		if (linkDataStamp() !== matchedAt) {
			return;
		}
		await putStoredLink({ id: outingId, catalogHash: key, planId: link.planId, labels: link.labels });
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
	await Promise.allSettled([ensureAirports(), ensureNavaids()]);
	// Candidates resolve what they can, and the key says what that was
	// (linkKey): a verdict reached without some of it is folded again when
	// the rest lands.
	const plans = await getStoredPlans();
	const candidates = candidatesFrom(plans);
	const hash = linkKey(plans, candidates);
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
