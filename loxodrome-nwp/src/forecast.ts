/* GET /v1/forecast: Open-Meteo's request and answer shapes over our own
 * archives (docs/nwp-service.md "The read API").
 *
 * Per point and hour, the chain's members are tried in order:
 *  - an hour at or after a member's newest run start comes from the newest
 *    of its published runs that reaches it (an IFS 06Z run stops at +144 h,
 *    the 00Z before it carries on to +360 h);
 *  - an earlier hour comes from the newest kept FIRST block whose run
 *    started at or before it, a week back: the past is stitched from each
 *    run's first hours, which no later run replaces;
 *  - a member serves the hour only where its archives hold the point (the
 *    domain read off the source's bitmaps, never the rectangle: about a
 *    sixth of AROME's is masked), else the next member is asked.
 * Values come hourly whatever the native step: u/v, heights, temperatures,
 * cover and pressures linear in time between the two steps around the hour,
 * a gust repeated over its statistical period. A point no member covers
 * answers x_unserved, and so does one with a PAST hour no kept archive
 * serves (the week after a first deployment, an ingest outage): the client
 * takes such a column whole from Open-Meteo, where a null past hour would
 * read as final. A future hour past the chain's reach is null, the horizon
 * speaking. x_runs names, per member, the newest run that served a LIVE
 * hour (past hours are final: no later run ever serves them). A request of
 * several points too heavy for one answer is refused before any read, with
 * the number of parts to ask it in (SplitError, LIMITS). */

import { CHAINS, MODELS, type ModelSpec } from './models.ts';
import {
	chooseLevel,
	decodeSegment,
	nearest,
	pointLatLon,
	SEGMENTS,
	seriesAt,
	tileOf,
	varKey,
	type Descriptor,
	type Level,
	type SegmentName,
} from './archive.ts';
import { runHour, runStamp, type BlockRef, type Pointer, type StepSegment } from './pointer.ts';

export interface TileRequest {
	key: string;
	z: number;
	x: number;
	y: number;
}

/** A tile's bytes, null where the archive does not hold it, or the archive
 *  gone from the bucket. */
export type TileResult = { payload: Uint8Array | null } | { missing: string };

export interface Source {
	pointer(model: string): Promise<Pointer | null>;
	descriptor(key: string): Promise<Descriptor>;
	tile(key: string, z: number, x: number, y: number): Promise<Uint8Array | null>;
	/** Several tiles at once, a source free to read neighbours together. */
	tiles?(reqs: readonly TileRequest[]): Promise<TileResult[]>;
}

export class RequestError extends Error {
	readonly status: number;
	constructor(status: number, reason: string) {
		super(reason);
		this.status = status;
	}
}

/** An archive a pointer names that the bucket no longer holds: the
 *  lifecycle rules took it while publishing stood still (an ingest outage,
 *  INGEST_PAUSED), or a pointer cached in another isolate outlived its
 *  release. Read as not covering its points, so the next member or
 *  Open-Meteo answers, never as a failed request. */
export class ArchiveMissing extends Error {
	readonly key: string;
	constructor(key: string) {
		super(`nwp: ${key} is not in the bucket`);
		this.key = key;
	}
}

/** A request too heavy for one answer: its points asked in `parts`
 *  contiguous groups instead (the 400's x_split). */
export class SplitError extends RequestError {
	readonly parts: number;
	constructor(parts: number) {
		super(400, `The request needs too many reads: ask for its points in ${parts} parts`);
		this.parts = parts;
	}
}

/** The parts a request of `points` reading `reads` tiles is split into. */
function splitParts(points: number, reads: number, limits: Limits): number {
	return Math.min(points, Math.max(2, Math.ceil(reads / limits.splitReads)));
}

/** A request of several points that would read more tiles than splitReads
 *  is answered with the number of parts to ask its points in instead
 *  (SplitError): six reads are in flight at once, the Workers' limit on
 *  simultaneous connections, and each is an R2 round trip of about 100 ms,
 *  so ninety take about a second and a half, where the client's parts run
 *  side by side, each request with its own six. The estimate is made before
 *  any read (estimateReads); tileReads is the ceiling a request reaches when
 *  the estimate fell short of it, split there too. A single point is never
 *  split: the hours bound its reads. */
export const LIMITS = {
	points: 200,
	hours: 16 * 24 + 1,
	values: 1_200_000,
	splitReads: 90,
	tileReads: 400,
	concurrency: 6,
};

export type Limits = typeof LIMITS;

/** Levels a request may name; a level no member stores answers null. */
const LEVELS = new Set([1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200]);

type Kind = 'plain' | 'speed' | 'dir' | 'gust' | 'ground';

interface Need {
	name: string;
	kind: Kind;
	seg: StepSegment;
	keys: string[];
	digits: number;
	unit: string;
}

function parseVar(name: string): Need {
	const m = /^(wind_speed|wind_direction|temperature|geopotential_height|cloud_cover)_(\d+)hPa$/.exec(name);
	if (m) {
		const level = Number(m[2]);
		if (!LEVELS.has(level)) {
			throw new RequestError(400, `Unsupported level in ${name}`);
		}
		switch (m[1]) {
			case 'wind_speed':
				return { name, kind: 'speed', seg: 'uvt', keys: [`wind_u@${level}`, `wind_v@${level}`], digits: 1, unit: 'kn' };
			case 'wind_direction':
				return { name, kind: 'dir', seg: 'uvt', keys: [`wind_u@${level}`, `wind_v@${level}`], digits: 0, unit: '°' };
			case 'temperature':
				return { name, kind: 'plain', seg: 'uvt', keys: [`temperature@${level}`], digits: 1, unit: '°C' };
			case 'geopotential_height':
				return { name, kind: 'plain', seg: 'z', keys: [`geopotential_height@${level}`], digits: 0, unit: 'm' };
			default:
				return { name, kind: 'plain', seg: 'cloud', keys: [`cloud_cover@${level}`], digits: 0, unit: '%' };
		}
	}
	switch (name) {
		case 'wind_speed_10m':
			return { name, kind: 'speed', seg: 'sfc', keys: ['wind_u_10m', 'wind_v_10m'], digits: 1, unit: 'kn' };
		case 'wind_direction_10m':
			return { name, kind: 'dir', seg: 'sfc', keys: ['wind_u_10m', 'wind_v_10m'], digits: 0, unit: '°' };
		case 'wind_gusts_10m':
			return { name, kind: 'gust', seg: 'sfc', keys: ['wind_gusts_10m'], digits: 1, unit: 'kn' };
		case 'temperature_2m':
			return { name, kind: 'plain', seg: 'sfc', keys: ['temperature_2m'], digits: 1, unit: '°C' };
		case 'pressure_msl':
			return { name, kind: 'plain', seg: 'sfc', keys: ['pressure_msl'], digits: 1, unit: 'hPa' };
		case 'surface_pressure':
			return { name, kind: 'plain', seg: 'ps', keys: ['surface_pressure'], digits: 1, unit: 'hPa' };
		case 'elevation':
			// Ours alone: the ground under each hour, the serving model's own,
			// where `elevation` beside the hours states the first covering
			// member's for the whole column. The surface pressure and the 2 m
			// temperature stand on it, so a chain's hours from another model
			// read their own (an aerodrome's QNH). Planned on the surface
			// steps, read off the static segment every tile carries.
			return { name, kind: 'ground', seg: 'sfc', keys: [], digits: 0, unit: 'm' };
	}
	throw new RequestError(400, `Unsupported variable ${name}`);
}

export interface ForecastRequest {
	points: { lat: number; lon: number }[];
	needs: Need[];
	chainId: string;
	chain: readonly string[];
	startHour: number;
	endHour: number;
}

function parseHour(s: string | null, name: string): number {
	const m = s ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):00$/.exec(s) : null;
	if (!m) {
		throw new RequestError(400, `Parameter '${name}' must be YYYY-MM-DDTHH:00`);
	}
	const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]));
	// Date.UTC rolls 25:00 over to the next day and 31 April to May.
	if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 13) !== s?.slice(0, 13)) {
		throw new RequestError(400, `Parameter '${name}' is not a date`);
	}
	return ms / 3600_000;
}

export function parseRequest(url: URL, chains: Record<string, readonly string[]> = CHAINS): ForecastRequest {
	const q = url.searchParams;
	const lats = (q.get('latitude') ?? '').split(',').filter((s) => s !== '');
	const lons = (q.get('longitude') ?? '').split(',').filter((s) => s !== '');
	if (lats.length === 0 || lats.length !== lons.length) {
		throw new RequestError(400, 'latitude and longitude must name the same number of points');
	}
	if (lats.length > LIMITS.points) {
		throw new RequestError(400, `At most ${LIMITS.points} locations`);
	}
	const points = lats.map((s, k) => {
		const lat = Number(s);
		const lon = Number(lons[k]);
		if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
			throw new RequestError(400, `Invalid coordinates ${s},${lons[k]}`);
		}
		return { lat, lon };
	});
	const names = (q.get('hourly') ?? '').split(',').filter((s) => s !== '');
	if (names.length === 0) {
		throw new RequestError(400, 'No hourly variable');
	}
	const needs = [...new Set(names)].map(parseVar);
	const chainId = q.get('models') ?? '';
	// Own keys only: `constructor` or `toString` is no chain.
	const chain = Object.hasOwn(chains, chainId) ? chains[chainId] : undefined;
	if (!chain) {
		throw new RequestError(400, `Unsupported model ${chainId}`);
	}
	if ((q.get('wind_speed_unit') ?? 'kn') !== 'kn') {
		throw new RequestError(400, 'Only wind_speed_unit=kn is served');
	}
	if ((q.get('timeformat') ?? 'unixtime') !== 'unixtime') {
		throw new RequestError(400, 'Only timeformat=unixtime is served');
	}
	const startHour = parseHour(q.get('start_hour'), 'start_hour');
	const endHour = parseHour(q.get('end_hour'), 'end_hour');
	if (endHour < startHour || endHour - startHour + 1 > LIMITS.hours) {
		throw new RequestError(400, 'The hour window is empty or longer than 16 days');
	}
	if (points.length * needs.length * (endHour - startHour + 1) > LIMITS.values) {
		throw new RequestError(400, 'Too many values requested');
	}
	return { points, needs, chainId, chain, startHour, endHour };
}

/* -------------------------------------------------------------- planning -- */

interface Slot {
	key: string;
	idx: number;
}

interface SegPlan {
	a: Slot;
	b: Slot;
	w: number;
}

interface HourPlan {
	start: number;
	/** The run as named to clients (runStamp); 0 for a past first block. */
	stamp: number;
	live: boolean;
	segs: Partial<Record<StepSegment, SegPlan>>;
	gust: Slot | null;
}

interface Timeline {
	h: number[];
	slots: Slot[];
	period: number[];
}

type RunTimeline = { start: number; stamp: number; segs: Record<StepSegment, Timeline> };

const STEP_SEGMENTS: StepSegment[] = ['sfc', 'ps', 'uvt', 'z', 'cloud'];

function timelineOf(start: number, blocks: readonly BlockRef[], stamp = 0): RunTimeline {
	const segs = {} as Record<StepSegment, Timeline>;
	for (const s of STEP_SEGMENTS) {
		const tl: Timeline = { h: [], slots: [], period: [] };
		for (const b of blocks) {
			(b.steps[s] ?? []).forEach((step, idx) => {
				tl.h.push(start + step);
				tl.slots.push({ key: b.key, idx });
				tl.period.push(s === 'sfc' ? (b.gustPeriod[idx] ?? 0) : 0);
			});
		}
		segs[s] = tl;
	}
	return { start, stamp, segs };
}

const timelines = new WeakMap<Pointer, { live: RunTimeline[]; past: RunTimeline[] }>();

function timelinesOf(p: Pointer): { live: RunTimeline[]; past: RunTimeline[] } {
	let t = timelines.get(p);
	if (!t) {
		t = {
			live: p.runs.map((r) => timelineOf(runHour(r.run), r.blocks, runStamp(r))),
			past: p.past.map((b) => timelineOf(runHour(b.run), [b])),
		};
		timelines.set(p, t);
	}
	return t;
}

function lowerBound(a: number[], x: number): number {
	let lo = 0;
	let hi = a.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (a[mid] < x) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

export function bracket(tl: Timeline, h: number): SegPlan | null {
	const k = lowerBound(tl.h, h);
	if (k >= tl.h.length) {
		return null;
	}
	if (tl.h[k] === h) {
		return { a: tl.slots[k], b: tl.slots[k], w: 0 };
	}
	if (k === 0) {
		return null;
	}
	return { a: tl.slots[k - 1], b: tl.slots[k], w: (h - tl.h[k - 1]) / (tl.h[k] - tl.h[k - 1]) };
}

/** The gust in force at h: the first step at or after it whose period
 *  reaches back over it, (step - period, step]. */
export function gustSlot(tl: Timeline, h: number): Slot | null {
	const k = lowerBound(tl.h, h);
	if (k >= tl.h.length) {
		return null;
	}
	return tl.period[k] > 0 && tl.h[k] - tl.period[k] < h ? tl.slots[k] : null;
}

function planIn(run: RunTimeline, h: number, segs: StepSegment[], gust: boolean, live: boolean): HourPlan | null {
	const plan: HourPlan = { start: run.start, stamp: run.stamp, live, segs: {}, gust: null };
	for (const s of segs) {
		const p = bracket(run.segs[s], h);
		if (!p) {
			return null;
		}
		plan.segs[s] = p;
	}
	if (gust) {
		if (!bracket(run.segs.sfc, h)) {
			return null;
		}
		plan.gust = gustSlot(run.segs.sfc, h);
	}
	return plan;
}

export function planHour(p: Pointer, h: number, segs: StepSegment[], gust: boolean): HourPlan | null {
	const t = timelinesOf(p);
	const newest = t.live[0]?.start ?? Infinity;
	let plan: HourPlan | null = null;
	if (h >= newest) {
		for (const run of t.live) {
			plan = planIn(run, h, segs, gust, true);
			if (plan) {
				break;
			}
		}
	} else {
		for (const run of t.past) {
			if (run.start > h) {
				continue;
			}
			plan = planIn(run, h, segs, gust, false);
			if (plan) {
				break;
			}
		}
	}
	if (plan && gust && !plan.gust) {
		// A run's first hour has no gust of its own (a maximum over the hour
		// before, which the run does not cover): the newest older run's step
		// at that hour holds it. Every run-start hour, the newest's and each
		// past one stitched from a first block, answered null.
		for (const run of [...t.live, ...t.past]) {
			const g = run.start < plan.start ? gustSlot(run.segs.sfc, h) : null;
			if (g) {
				plan.gust = g;
				break;
			}
		}
	}
	return plan;
}

function planKeys(plan: HourPlan): string[] {
	const keys = new Set<string>();
	for (const s of Object.values(plan.segs)) {
		keys.add(s.a.key);
		keys.add(s.b.key);
	}
	if (plan.gust) {
		keys.add(plan.gust.key);
	}
	return [...keys];
}

/* ---------------------------------------------------------------- answer -- */

/** A point still to serve: what planning a member reads. */
interface Pending {
	lat: number;
	lon: number;
	/** The hour indexes not yet served. */
	remaining: Set<number>;
}

interface PointState extends Pending {
	served: ({ member: string; plan: HourPlan } | null)[];
	/** Some member planned an hour of it: its hours were within a reach, so
	 *  a point left unserved was turned down by the archives (a mask), not
	 *  by the horizon. */
	planned: boolean;
	/** The first covering member's grid point and ground. */
	cover: { member: string; lat: number; lon: number; elevation: number } | null;
	/** Per archive key: per variable key, its values by step; and whether
	 *  the archive covers the point. */
	series: Map<string, Map<string, (number | null)[]>>;
	covered: Map<string, boolean>;
}

interface TileRead<S> {
	key: string;
	x: number;
	y: number;
	users: { st: S; at: number }[];
}

interface MemberPlan<S extends Pending> {
	work: { st: S; ij: { i: number; j: number }; plans: Map<number, HourPlan> }[];
	level: Level;
	/** One read per archive tile, shared by every point in it. */
	reads: Map<string, TileRead<S>>;
}

/** A member's share of the points still to serve: each remaining hour of
 *  each point its grid holds, planned on its runs, and the tiles that
 *  reads. Null when it plans nothing. */
function planMember<S extends Pending>(
	spec: ModelSpec,
	pointer: Pointer,
	pending: readonly S[],
	hours: readonly number[],
	segs: StepSegment[],
	gust: boolean,
): MemberPlan<S> | null {
	const work: MemberPlan<S>['work'] = [];
	for (const st of pending) {
		const ij = nearest(spec.grid, st.lat, st.lon);
		if (!ij) {
			continue;
		}
		const plans = new Map<number, HourPlan>();
		for (const k of st.remaining) {
			const plan = planHour(pointer, hours[k], segs, gust);
			if (plan) {
				plans.set(k, plan);
			}
		}
		if (plans.size > 0) {
			work.push({ st, ij, plans });
		}
	}
	if (work.length === 0) {
		return null;
	}
	const level = chooseLevel(spec.pyramid, work.map((w) => w.ij));
	const reads = new Map<string, TileRead<S>>();
	for (const w of work) {
		const t = tileOf(level, 16, w.ij.i, w.ij.j);
		const keys = new Set<string>();
		for (const plan of w.plans.values()) {
			planKeys(plan).forEach((k) => keys.add(k));
		}
		for (const key of keys) {
			const id = `${key}|${t.x}|${t.y}`;
			const r = reads.get(id) ?? { key, x: t.x, y: t.y, users: [] };
			r.users.push({ st: w.st, at: t.at });
			reads.set(id, r);
		}
	}
	return { work, level, reads };
}

function usable(p: Pointer | null): p is Pointer {
	return !!p && (p.runs.length > 0 || p.past.length > 0);
}

/** The tile reads a request will make, counted before any is: the chain
 *  walked with each member serving every hour it plans at every point its
 *  grid holds. Which points a member's archives hold is only learnt by
 *  reading (its mask), so a point inside the first member's rectangle that
 *  its mask turns down is not counted for the next (AROME's masked corners
 *  lie at sea, off the routes it serves): the read ceiling covers that. */
export function estimateReads(
	req: ForecastRequest,
	pointers: readonly (Pointer | null)[],
	models: Record<string, ModelSpec>,
	hours: readonly number[],
	segs: StepSegment[],
	gust: boolean,
): number {
	const pending: Pending[] = req.points.map((p) => ({ lat: p.lat, lon: p.lon, remaining: new Set(hours.map((_, k) => k)) }));
	let reads = 0;
	req.chain.forEach((member, m) => {
		const pointer = pointers[m];
		const spec = models[member];
		if (!usable(pointer) || !spec) {
			return;
		}
		const plan = planMember(
			spec,
			pointer,
			pending.filter((st) => st.remaining.size > 0),
			hours,
			segs,
			gust,
		);
		if (!plan) {
			return;
		}
		reads += plan.reads.size;
		for (const w of plan.work) {
			for (const k of w.plans.keys()) {
				w.st.remaining.delete(k);
			}
		}
	});
	return reads;
}

/** Runs fn over the items, n at a time. A failure stops the workers
 *  taking more, and is thrown once the reads in flight have settled: an
 *  answer that returned at the first one would end the request with its
 *  other reads still out, which the runtime cancels. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	let failure: { err: unknown } | null = null;
	const worker = async (): Promise<void> => {
		while (next < items.length && !failure) {
			try {
				await fn(items[next++]);
			} catch (err) {
				failure ??= { err };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
	if (failure) {
		throw (failure as { err: unknown }).err;
	}
}

function round(x: number, digits: number): number {
	const f = 10 ** digits;
	return Math.round(x * f) / f;
}

export interface Answer {
	locations: Record<string, unknown>[];
	tileReads: number;
	/** The archives named and not found, read as not covering. */
	missing: string[];
}

export async function answer(
	req: ForecastRequest,
	source: Source,
	models: Record<string, ModelSpec> = MODELS,
	nowMs = Date.now(),
	limits: Limits = LIMITS,
): Promise<Answer> {
	const t0 = Date.now();
	const nowHour = Math.floor(nowMs / 3_600_000);
	const hours: number[] = [];
	for (let h = req.startHour; h <= req.endHour; h++) {
		hours.push(h);
	}
	// The gust's own segment too: asked alone, its hours planned no archive
	// at all and passed the coverage test vacuously, a masked point served.
	const segs = [...new Set(req.needs.map((n) => n.seg))];
	const gust = req.needs.some((n) => n.kind === 'gust');
	const keysBySeg = new Map<SegmentName, Set<string>>();
	for (const n of req.needs) {
		if (n.keys.length === 0) {
			continue;
		}
		const set = keysBySeg.get(n.seg) ?? new Set<string>();
		n.keys.forEach((k) => set.add(k));
		keysBySeg.set(n.seg, set);
	}
	const states: PointState[] = req.points.map((p) => ({
		lat: p.lat,
		lon: p.lon,
		remaining: new Set(hours.map((_, k) => k)),
		served: hours.map(() => null),
		planned: false,
		cover: null,
		series: new Map(),
		covered: new Map(),
	}));
	let tileReads = 0;
	const missing = new Set<string>();
	// The pointer of every member whose grid holds a requested point, the
	// isolate's copy for 30 s: a member whose pointer cannot be read serves
	// nothing, its points left to the next member or to Open-Meteo. A member
	// holding none is never consulted (it serves no hour, and the unserved
	// and x_latest rules read the members holding a point), and reading its
	// pointer would only queue a cold request behind the Workers' six
	// connections: Auto's chain has eight members, one point at most three.
	const pointers = await Promise.all(
		req.chain.map((m) =>
			!models[m] || req.points.some((p) => nearest(models[m].grid, p.lat, p.lon) != null) ? source.pointer(m).catch(() => null) : Promise.resolve(null),
		),
	);
	if (req.points.length > 1) {
		const planned = estimateReads(req, pointers, models, hours, segs, gust);
		if (planned > limits.splitReads) {
			throw new SplitError(splitParts(req.points.length, planned, limits));
		}
	}

	for (const [m, member] of req.chain.entries()) {
		const pending = states.filter((s) => s.remaining.size > 0);
		if (pending.length === 0) {
			break;
		}
		const pointer = pointers[m];
		if (!usable(pointer)) {
			continue;
		}
		const spec = models[member];
		if (!spec) {
			throw new Error(`nwp: no model ${member}`);
		}
		const planned = planMember(spec, pointer, pending, hours, segs, gust);
		if (!planned) {
			continue;
		}
		const { work, level, reads } = planned;
		for (const w of work) {
			w.st.planned = true;
		}
		tileReads += reads.size;
		if (tileReads > limits.tileReads && req.points.length > 1) {
			throw new SplitError(splitParts(req.points.length, tileReads, limits));
		}
		const list = [...reads.values()];
		// Every archive's descriptor (its opening), the level checked.
		const descs = new Map<string, Descriptor | null>();
		await pool([...new Set(list.map((r) => r.key))], limits.concurrency, async (key) => {
			try {
				const desc = await source.descriptor(key);
				if (desc.tile !== 16 || desc.levels.every((l) => l.z !== level.z)) {
					throw new Error(`nwp: ${key} does not lay out the levels the registry states`);
				}
				descs.set(key, desc);
			} catch (err) {
				if (!(err instanceof ArchiveMissing)) {
					throw err;
				}
				missing.add(err.key);
				descs.set(key, null);
			}
		});
		const wanted = list.filter((r) => descs.get(r.key));
		// The tiles: together where the source can read neighbours at once.
		const payloads = new Map<TileRead<PointState>, Uint8Array | null>();
		if (source.tiles) {
			const got = await source.tiles(wanted.map((r) => ({ key: r.key, z: level.z, x: r.x, y: r.y })));
			got.forEach((g, i) => {
				if ('missing' in g) {
					missing.add(g.missing);
					payloads.set(wanted[i], null);
				} else {
					payloads.set(wanted[i], g.payload);
				}
			});
		} else {
			await pool(wanted, limits.concurrency, async (r) => {
				try {
					payloads.set(r, await source.tile(r.key, level.z, r.x, r.y));
				} catch (err) {
					if (!(err instanceof ArchiveMissing)) {
						throw err;
					}
					missing.add(err.key);
					payloads.set(r, null);
				}
			});
		}
		await pool(list, limits.concurrency, async (r) => {
			const desc = descs.get(r.key);
			const payload = payloads.get(r) ?? null;
			if (!desc || !payload) {
				r.users.forEach((u) => u.st.covered.set(r.key, false));
				return;
			}
			const decoded = new Map<number, Int16Array>();
			const segment = async (index: number): Promise<Int16Array> => {
				let d = decoded.get(index);
				if (!d) {
					d = await decodeSegment(payload, index);
					decoded.set(index, d);
				}
				return d;
			};
			const staticData = await segment(0);
			for (const u of r.users) {
				const elev = seriesAt(desc.segments[0], staticData, 0, u.at, desc.tile)[0];
				u.st.covered.set(r.key, elev != null);
				if (elev == null) {
					continue;
				}
				const vars = new Map<string, (number | null)[]>();
				vars.set('elevation', [elev]);
				for (const [segName, keys] of keysBySeg) {
					const si = SEGMENTS.indexOf(segName);
					const seg = desc.segments[si];
					const data = await segment(si);
					seg.vars.forEach((v, vi) => {
						if (keys.has(varKey(v))) {
							vars.set(varKey(v), seriesAt(seg, data, vi, u.at, desc.tile));
						}
					});
				}
				u.st.series.set(r.key, vars);
			}
		});
		// An hour goes to this member when every archive its plan reads
		// holds the point.
		for (const w of work) {
			for (const [k, plan] of w.plans) {
				if (planKeys(plan).every((key) => w.st.covered.get(key) === true)) {
					w.st.served[k] = { member, plan };
					w.st.remaining.delete(k);
					if (!w.st.cover) {
						const elev = w.st.series.get(planKeys(plan)[0])?.get('elevation')?.[0] ?? 0;
						const ll = pointLatLon(spec.grid, w.ij.i, w.ij.j);
						w.st.cover = { member, lat: ll.lat, lon: ll.lon, elevation: elev };
					}
				}
			}
		}
	}

	const generation = Date.now() - t0;
	const locations = states.map((st) => {
		const runs: Record<string, number> = {};
		const hourly: Record<string, (number | null)[]> = { time: hours.map((h) => h * 3600) };
		const units: Record<string, string> = { time: 'unixtime' };
		for (const n of req.needs) {
			units[n.name] = n.unit;
			hourly[n.name] = st.served.map((s) => (s ? valueAt(st, n, s.plan) : null));
		}
		// x_runs: the run that served each member's live hours (provenance);
		// x_latest: the newest run each member held when its live hours were
		// answered (freshness). An older run serves what the newest does not
		// reach (an IFS 06Z stopping at +144 h, a truncated run), and judged
		// by x_runs such a column read stale against the newest run on
		// landing and was asked again every minute. Hours past every
		// member's reach (null, the horizon) are answered by whichever
		// member holding the point publishes further: each counts.
		const latest: Record<string, number> = {};
		const newest = (m: number): number | null => {
			const p = pointers[m];
			return p && p.runs.length > 0 ? runStamp(p.runs[0]) : null;
		};
		for (const s of st.served) {
			if (s?.plan.live) {
				runs[s.member] = Math.max(runs[s.member] ?? 0, s.plan.stamp);
				const n = newest(req.chain.indexOf(s.member));
				if (n != null) {
					latest[s.member] = n;
				}
			}
		}
		const holds = req.chain.map((member) => !!models[member] && nearest(models[member].grid, st.lat, st.lon) != null);
		if (st.served.some((s, k) => s === null && hours[k] >= nowHour)) {
			req.chain.forEach((member, m) => {
				const n = holds[m] ? newest(m) : null;
				if (n != null) {
					latest[member] = n;
				}
			});
		}
		const loc: Record<string, unknown> = {
			latitude: st.cover?.lat ?? st.lat,
			longitude: st.cover?.lon ?? st.lon,
			generationtime_ms: generation,
			utc_offset_seconds: 0,
			timezone: 'GMT',
			timezone_abbreviation: 'GMT',
			elevation: st.cover?.elevation ?? 0,
			hourly_units: units,
			hourly,
			x_runs: runs,
			x_latest: latest,
		};
		// Unserved: a past hour no kept archive serves, or a point no member
		// served at all although its hours were within a reach (the masks)
		// or no member's grid holds it. A point whose hours all lie past
		// every member's reach is the horizon, answered null like any hour
		// past it: sent to Open-Meteo, its twin could not answer them either
		// (meteofrance_seamless stops at 102 h).
		const pastHole = st.served.some((s, k) => s === null && hours[k] < nowHour);
		if (pastHole || (!st.cover && (st.planned || !holds.some((h, m) => h && usable(pointers[m]))))) {
			loc.x_unserved = true;
		}
		return loc;
	});
	return { locations, tileReads, missing: [...missing] };
}

function valueAt(st: PointState, n: Need, plan: HourPlan): number | null {
	const get = (slot: Slot, key: string): number | null => st.series.get(slot.key)?.get(key)?.[slot.idx] ?? null;
	if (n.kind === 'ground') {
		const key = planKeys(plan)[0];
		const z = key ? st.series.get(key)?.get('elevation')?.[0] : null;
		return z == null ? null : Math.round(z);
	}
	if (n.kind === 'gust') {
		const v = plan.gust ? get(plan.gust, n.keys[0]) : null;
		return v == null ? null : round(Math.max(0, v), n.digits);
	}
	const sp = plan.segs[n.seg];
	if (!sp) {
		return null;
	}
	const lerp = (key: string): number | null => {
		const a = get(sp.a, key);
		if (sp.w === 0) {
			return a;
		}
		const b = get(sp.b, key);
		return a == null || b == null ? null : a + (b - a) * sp.w;
	};
	if (n.kind === 'plain') {
		const v = lerp(n.keys[0]);
		return v == null ? null : round(v, n.digits);
	}
	const u = lerp(n.keys[0]);
	const v = lerp(n.keys[1]);
	if (u == null || v == null) {
		return null;
	}
	if (n.kind === 'speed') {
		return round(Math.hypot(u, v), n.digits);
	}
	if (u === 0 && v === 0) {
		return 0;
	}
	const dir = (Math.atan2(-u, -v) * 180) / Math.PI;
	return Math.round((dir + 360) % 360) % 360;
}
