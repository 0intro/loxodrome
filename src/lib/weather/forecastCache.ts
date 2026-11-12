/* When is a fetched forecast column still the forecast? (docs/wind-aloft.md,
 * "Freshness"). Pure: no Svelte, no clock but the one passed in.
 *
 * A column is the forecast at one point over hours, and it stays the forecast
 * until the model publishes a new run that covers the point. Open-Meteo's
 * run metadata (/data/<dir>/static/meta.json) is free to read, unlike the
 * forecast, so a column is refetched when a RUN changes, never on a clock.
 *
 * A model the app names is served from several run directories (AROME and
 * ARPEGE behind 'meteofrance_seamless', the 1.3 km AROME grid carrying its
 * 10 m wind), grouped into CYCLE GROUPS: the directories one cycle publishes,
 * minutes apart, so the cycle counts once. A cell records, when it was asked
 * for, each group's run (its STAMP); it is stale once a group whose grid holds
 * the point has published another run. A stamp the poll could not fill (the
 * run not known yet, a model with no directory) anchors nothing, and such a
 * cell is the forecast for FALLBACK_TTL_MS. Server times are never compared
 * with the device clock: only runs with runs, and the device's own age.
 *
 * A column of OUR service names the runs it actually used (x_runs), which is
 * a finer stamp than the request's: it is judged on those runs only, so an
 * AROME column is never refetched because IFS published, and a column served
 * wholly from past hours (no run used) is final, no later run ever serving
 * those hours (servedStamp). A column Open-Meteo answered in its place
 * carries no stamp and ages out like any unanchored cell. */

/** A grid's extent, degrees: [south, west, north, east]. */
export type Bbox = readonly [south: number, west: number, north: number, east: number];

/** The run directories one cycle publishes (one model's twins). */
export type RunGroup = readonly string[];

/** One directory's last run, as its meta.json states it. `bbox` is null for
 *  a grid whose extent is unknown, projected or global, which then holds
 *  every point; `intervalMs` is its update cadence, when stated. */
export interface DirRun {
	initMs: number;
	bbox: Bbox | null;
	intervalMs: number | null;
}

/** The directories' last runs, as polled. */
export type RunTable = Readonly<Record<string, DirRun | undefined>>;

/** A cell's groups' runs when it was asked for, keyed by groupKey; null where
 *  a group's run was not known. */
export type RunStamp = Readonly<Record<string, number | null>>;

/** How long a cell no run anchors stays the forecast. */
export const FALLBACK_TTL_MS = 60 * 60_000;

/** The key marking a stamp taken from our service's answer: its other keys
 *  are the run directories the column used, each with its run. */
export const SERVED_KEY = '@served';

/** The stamp of a column our service answered: the runs it used. */
export function servedStamp(runs: Readonly<Record<string, number>>): RunStamp {
	return { [SERVED_KEY]: 0, ...runs };
}

/** The stamp of a column asked of a model of ours that Open-Meteo answered
 *  instead: nothing anchors it, so it ages out (FALLBACK_TTL_MS) and our
 *  service is asked again. */
export const UNANCHORED: RunStamp = Object.freeze({});

/** Several cells' common stamp: a served one keeps, per directory, the
 *  OLDEST run any cell used (the first a newer run outdates); otherwise a
 *  group's run where every cell agrees, else unknown. Mixed cells (some
 *  served, some not) anchor nothing. */
export function mergeStamps(stamps: readonly RunStamp[]): RunStamp {
	if (stamps.length === 0) {
		return UNANCHORED;
	}
	const served = stamps.filter((s) => SERVED_KEY in s).length;
	if (served === stamps.length) {
		const out: Record<string, number> = {};
		for (const st of stamps) {
			for (const [dir, run] of Object.entries(st)) {
				if (dir !== SERVED_KEY && run != null) {
					out[dir] = Math.min(out[dir] ?? Infinity, run);
				}
			}
		}
		return servedStamp(out);
	}
	if (served > 0) {
		return UNANCHORED;
	}
	const first = stamps[0];
	const out: Record<string, number | null> = {};
	for (const k of Object.keys(first)) {
		const v = first[k] ?? null;
		out[k] = stamps.every((c) => (c[k] ?? null) === v) ? v : null;
	}
	return out;
}

export function groupKey(g: RunGroup): string {
	return g.join('+');
}

/** A group's run: its oldest member's, once every member is known (the cycle
 *  is whole only when its last directory has published it). A member more
 *  than one of its own update intervals behind the newest is stalled and
 *  ignored, so one grid that stopped cannot hold its twin's cycles back. */
export function groupRun(g: RunGroup, runs: RunTable): number | null {
	if (g.length === 0) {
		return null;
	}
	const members: DirRun[] = [];
	for (const dir of g) {
		const r = runs[dir];
		if (!r) {
			return null;
		}
		members.push(r);
	}
	const newest = Math.max(...members.map((r) => r.initMs));
	let run = newest;
	for (const r of members) {
		if (r.intervalMs != null && newest - r.initMs > r.intervalMs) {
			continue;
		}
		run = Math.min(run, r.initMs);
	}
	return run;
}

/** A group's extent: the union of its members' grids; null (every point)
 *  while any member's is unknown, projected or global. */
export function groupBbox(g: RunGroup, runs: RunTable): Bbox | null {
	let s = Infinity;
	let w = Infinity;
	let n = -Infinity;
	let e = -Infinity;
	for (const dir of g) {
		const b = runs[dir]?.bbox;
		if (!b) {
			return null;
		}
		s = Math.min(s, b[0]);
		w = Math.min(w, b[1]);
		n = Math.max(n, b[2]);
		e = Math.max(e, b[3]);
	}
	return g.length > 0 ? [s, w, n, e] : null;
}

/** Whether a grid holds a point; a null grid holds every point. A west past
 *  its east reads as crossing the antimeridian. */
export function inBbox(p: { lat: number; lon: number }, b: Bbox | null): boolean {
	if (!b) {
		return true;
	}
	const [s, w, n, e] = b;
	if (p.lat < s || p.lat > n) {
		return false;
	}
	return w <= e ? p.lon >= w && p.lon <= e : p.lon >= w || p.lon <= e;
}

/** The stamp of a cell asked for now: every group's run as known. */
export function stampRuns(groups: readonly RunGroup[], runs: RunTable): RunStamp {
	const out: Record<string, number | null> = {};
	for (const g of groups) {
		out[groupKey(g)] = groupRun(g, runs);
	}
	return out;
}

/** Whether a cell asked for at `atMs` under `stamp` is still the forecast at
 *  `p`. Stale once a group whose grid holds the point has published a run
 *  other than the one stamped (both known); current with no clock read once
 *  every such group's run was known when it was asked for; otherwise, no run
 *  anchoring it, current only while younger than FALLBACK_TTL_MS (a clock
 *  stepped back reads stale). */
export function isCellCurrent(
	stamp: RunStamp,
	atMs: number,
	groups: readonly RunGroup[],
	runs: RunTable,
	p: { lat: number; lon: number },
	nowMs: number,
): boolean {
	if (SERVED_KEY in stamp) {
		// Stale once a run NEWER than one the column used is known; a table
		// lagging behind the column (polled before it landed) outdates
		// nothing.
		for (const [dir, had] of Object.entries(stamp)) {
			const now = runs[dir]?.initMs ?? null;
			if (dir !== SERVED_KEY && had != null && now != null && now > had) {
				return false;
			}
		}
		return true;
	}
	let relevant = 0;
	let anchored = true;
	for (const g of groups) {
		if (!inBbox(p, groupBbox(g, runs))) {
			continue;
		}
		relevant++;
		const had = stamp[groupKey(g)] ?? null;
		const now = groupRun(g, runs);
		if (had != null && now != null && had !== now) {
			return false;
		}
		if (had == null) {
			anchored = false;
		}
	}
	if (relevant > 0 && anchored) {
		return true;
	}
	const age = nowMs - atMs;
	return age >= 0 && age < FALLBACK_TTL_MS;
}

/** Whether the hours a cell was ASKED for cover a need. The asked window,
 *  never the column's own hours: the endpoint answers every hour asked for,
 *  null past the model's horizon, so a column ending early is the horizon
 *  speaking and must not read as a gap to fetch again. */
export function covers(
	win: { startMs: number; endMs: number } | null | undefined,
	needStartMs: number,
	needEndMs: number,
): boolean {
	return win != null && win.startMs <= needStartMs && needEndMs <= win.endMs;
}

/** A store bounded by the weight of what it holds (the values of the columns,
 *  not their count: a cell holding a day weighs eight times one holding three
 *  hours), evicting the least recently used first. */
export class LruStore<V> {
	private readonly entries = new Map<string, { value: V; weight: number }>();
	private total = 0;

	constructor(
		private readonly maxWeight: number,
		private readonly weigh: (value: V) => number,
	) {}

	/** The value, marked as just used. */
	get(key: string): V | undefined {
		const e = this.entries.get(key);
		if (!e) {
			return undefined;
		}
		this.entries.delete(key);
		this.entries.set(key, e);
		return e.value;
	}

	/** The value, leaving its place in the eviction order alone. */
	peek(key: string): V | undefined {
		return this.entries.get(key)?.value;
	}

	set(key: string, value: V): void {
		this.delete(key);
		const weight = Math.max(0, this.weigh(value));
		this.entries.set(key, { value, weight });
		this.total += weight;
		// Never the entry just set: a store smaller than one value keeps it.
		for (const [k, e] of this.entries) {
			if (this.total <= this.maxWeight || k === key) {
				break;
			}
			this.entries.delete(k);
			this.total -= e.weight;
		}
	}

	delete(key: string): void {
		const e = this.entries.get(key);
		if (e) {
			this.entries.delete(key);
			this.total -= e.weight;
		}
	}

	clear(): void {
		this.entries.clear();
		this.total = 0;
	}

	get size(): number {
		return this.entries.size;
	}

	get weight(): number {
		return this.total;
	}
}
