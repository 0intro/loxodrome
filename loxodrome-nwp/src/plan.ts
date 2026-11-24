/* The ingest orchestrator's decisions, pure (the Durable Object in
 * ingest.ts applies them): which runs to track, which blocks a Container job
 * builds, when a run is published (whole, or truncated at init + 8 h with its
 * first day built), what the published pointer becomes and what retention
 * deletes. A run is visible only once every block is built and checked: a
 * column mixing a new run's early hours with the old run's later ones would
 * be stamped new and never refetched. */

import { MODELS, type ModelId, type ModelSpec } from './models.ts';
import type { BlockRef, PastRef, Pointer, RunRef, StepSegment } from './pointer.ts';

export interface Canary {
	z: number;
	x: number;
	y: number;
	segments: string[];
}

/** What the Container's receipt says of a built block. */
export interface Receipt {
	key: string;
	model: string;
	run: string;
	first: number;
	last: number;
	size: number;
	content: string;
	tiles: number;
	canaries: Canary[];
	steps: Record<StepSegment, number[]>;
	gustPeriod: number[];
	/** When the Container built it (ISO 8601). */
	built?: string;
}

export type BlockStatus = 'waiting' | 'ready' | 'running' | 'built' | 'failed';

export interface BlockState {
	status: BlockStatus;
	attempts: number;
	receipt?: Receipt;
	error?: string;
	/** Its canaries decoded at an earlier publication (a truncated one):
	 *  served already, never demoted by a later read that fails. */
	verified?: boolean;
	/** Jobs stopped on request (EXIT_STOPPED) while it was the first block
	 *  left, since it was last built or retried: charged nothing until
	 *  MAX_STOPS. */
	stops?: number;
}

export type RunStatus = 'collecting' | 'truncated' | 'published' | 'abandoned';

export interface RunState {
	run: string;
	status: RunStatus;
	blocks: Record<string, BlockState>;
	seenAt: number;
	publishedAt?: number;
	/** When its first blocks were found at the publisher. */
	readyAt?: number;
}

export interface Job {
	run: string;
	blocks: string[];
	started: number;
}

export interface ModelState {
	model: ModelId;
	runs: RunState[];
	job: Job | null;
	lastTick: number;
	lastError: string | null;
	/** Runs abandoned in a row (reset by a publication). */
	failedRuns: number;
	alert: { stale: boolean; lastMail: number; reason: string };
	/** The RETRY_EPOCH last applied (retryFailed). */
	retryEpoch?: string;
	/** The MAIL_TEST value a test alert was last sent for. */
	mailTest?: string;
	/** The STATE_EPOCH this state was started under (stateStands). */
	stateEpoch?: string;
	/** No job starts before this (paceAfterJob): set by a job that built
	 *  nothing. */
	notBefore?: number;
	/** The container time the model's jobs took on their UTC day
	 *  (closeJob; another day's reads as none, usageToday). */
	usage?: Usage;
	/** The UTC day each notice was last mailed (noticeDue). */
	notices?: Partial<Record<Notice, string>>;
}

/** The container time a model's jobs took on one UTC day. */
export interface Usage {
	day: string;
	ms: number;
	jobs: number;
}

/** What the operator is mailed about at most once a UTC day per model: the
 *  daily budget spent, a job killed past its cap, a job ended by its own
 *  deadline (the orchestrator having failed to end it). */
export type Notice = 'budget' | 'overCap' | 'deadline';

export const MAX_ATTEMPTS = 3;
/** How long a job may run before the orchestrator stops it. */
export const JOB_CAP_MS = 12 * 60_000;
/** The status `nwp ingest` exits with when it was stopped on request (the
 *  platform's SIGTERM before a rollout replaces its instance or a host's
 *  maintenance) after finishing the block in progress: EX_TEMPFAIL
 *  (cmd/nwp exitStopped, which the suite holds to this value). */
export const EXIT_STOPPED = 75;
/** Stops on request a block takes, as the first block left, before the
 *  next one is charged like a failure: whatever stops a job again and
 *  again must not keep its run, the oldest, ahead of every newer one. */
export const MAX_STOPS = 3;
/** The last line of a job's log when it was stopped on request: the
 *  logger's UTC stamp, then `stopped:` (cmd/nwp statusLine). */
export const STOPPED_LINE = /^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d stopped: /;
/** The status `nwp ingest` exits with when a Container job ran past its
 *  own deadline (cmd/nwp exitDeadline, 15 minutes, held to this value and
 *  past JOB_CAP_MS by the suite): it ended itself because the orchestrator
 *  did not end it at its cap. Charged like any failure. */
export const EXIT_DEADLINE = 124;
/** The last line of a job's log when it ran past its deadline (cmd/nwp
 *  deadlineError, a failure's status line). */
export const DEADLINE_LINE = /^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d error: ran past its \S+ deadline$/;
/** A model's daily budget of container time, minutes, unless
 *  JOB_BUDGET_MINUTES says otherwise. AROME France, the heaviest, used
 *  about 23 minutes on a full day (2026-10-08), the others 4 to 15, so 90
 *  leaves AROME about four times its use, room for a publisher three times
 *  slower. Past it no job starts until 00:00 UTC: a bug hanging every job
 *  costs a model 90 minutes and one job a day, where the cap alone let it
 *  run 17 hours. */
export const JOB_BUDGET_MINUTES = 90;
/** How long a tick may spend listing the publishers, every run of it: one
 *  budget, one timer, cleared once the listings are done (a timer left
 *  pending per fetch kept the Durable Object awake, and billed). */
export const DISCOVERY_BUDGET_MS = 40_000;
/** How long a job that built nothing holds the next one back. The cron
 *  ticks every minute, for the publishers' landing; a fault every block
 *  shares (a store refusing writes) must still cost a job every five
 *  minutes, as when the cron ticked every five, and not every minute,
 *  which spent every block's attempts within minutes on the first night. */
export const EMPTY_JOB_PAUSE_MS = 5 * 60_000;
/** A run still collecting this long after its start is given up. */
export const ABANDON_AFTER_MS = 30 * 3600_000;
export const PAST_KEPT_MS = 7 * 24 * 3600_000;
export const RUNS_KEPT = 3;
export const MAIL_EVERY_MS = 12 * 3600_000;

/** Blocks a job takes at most, the model's own figure. ECMWF posts a
 *  whole IFS run at once and a job decodes one block while it stores the
 *  one before, so a job ends its overlap where it ends: twelve hold a 06Z
 *  or 18Z run whole and a 00Z or 12Z one in two jobs, within the cap at
 *  the old pace (30 s a block). Météo-France posts its blocks one after
 *  another, about 2 GB of source a job. */
export function blocksPerJob(spec: ModelSpec): number {
	return spec.jobBlocks;
}

/** When a run may be published truncated, or given up behind a newer one,
 *  milliseconds after its start. */
function truncateAfterMs(spec: ModelSpec): number {
	return spec.truncateAfterHours * 3600_000;
}

export function emptyState(model: ModelId): ModelState {
	return { model, runs: [], job: null, lastTick: 0, lastError: null, failedRuns: 0, alert: { stale: false, lastMail: 0, reason: '' } };
}

function iso(ms: number): string {
	return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/** The newest run the pointer serves, ms. */
export function newestPublished(state: ModelState): number {
	let t = -Infinity;
	for (const r of state.runs) {
		if (r.status === 'published' || r.status === 'truncated') {
			t = Math.max(t, Date.parse(r.run));
		}
	}
	return t;
}

/** How far back a run is still worth starting: on a first start (or after
 *  an outage) the orchestrator catches up from here, never from a day back
 *  run after run. */
export const TRACK_WINDOW_MS = 12 * 3600_000;

/** Tracks the runs started in the last twelve hours that are newer than
 *  the published one, and gives up those still collecting past their time. */
export function trackRuns(state: ModelState, nowMs: number): void {
	const spec = MODELS[state.model];
	const cycle = spec.cycleHours * 3600_000;
	const newest = newestPublished(state);
	const from = Math.floor((nowMs - TRACK_WINDOW_MS) / cycle) * cycle;
	for (let t = from; t <= nowMs; t += cycle) {
		if (t <= newest || state.runs.some((r) => r.run === iso(t))) {
			continue;
		}
		const blocks: Record<string, BlockState> = {};
		for (const b of spec.blocks(new Date(t).getUTCHours())) {
			blocks[b.name] = { status: 'waiting', attempts: 0 };
		}
		state.runs.push({ run: iso(t), status: 'collecting', blocks, seenAt: nowMs });
	}
	for (const r of state.runs) {
		if (r.status === 'collecting' && nowMs - Date.parse(r.run) > ABANDON_AFTER_MS) {
			r.status = 'abandoned';
			state.failedRuns++;
		}
		// A run older than the published one will never be published.
		if (r.status === 'collecting' && Date.parse(r.run) < newest && nowMs - Date.parse(r.run) > truncateAfterMs(spec)) {
			r.status = 'abandoned';
		}
	}
	state.runs.sort((a, b) => Date.parse(a.run) - Date.parse(b.run));
	// Keep two days of history in the state.
	state.runs = state.runs.filter((r) => nowMs - Date.parse(r.run) < 48 * 3600_000);
}

/** The operator's retry after a fix (the RETRY_EPOCH variable, applied
 *  once per value): every failed block of a run still being built (one
 *  collecting, or one published truncated whose later blocks nextJob still
 *  builds; never one older than the run served, which nextJob never builds)
 *  gets its attempts back and waits for discovery again. Returns how many. */
export function retryFailed(state: ModelState): number {
	let n = 0;
	const newest = newestPublished(state);
	for (const run of state.runs) {
		if ((run.status !== 'collecting' && run.status !== 'truncated') || Date.parse(run.run) < newest) {
			continue;
		}
		for (const b of Object.values(run.blocks)) {
			if (b.status === 'failed') {
				b.status = 'waiting';
				b.attempts = 0;
				delete b.error;
				delete b.stops;
				n++;
			}
		}
	}
	// The operator fixed what failed: no pause holds the retry back.
	delete state.notBefore;
	return n;
}

/** Marks a run's listed blocks ready, and when the first were found. */
export function applyDiscovery(run: RunState, ready: Set<string>, nowMs?: number): void {
	for (const [name, b] of Object.entries(run.blocks)) {
		if (b.status === 'waiting' && ready.has(name)) {
			b.status = 'ready';
			if (nowMs !== undefined && run.readyAt === undefined) {
				run.readyAt = nowMs;
			}
		}
	}
}

/** The runs worth listing at the publisher: collecting, newest first. */
export function runsToDiscover(state: ModelState): RunState[] {
	return state.runs.filter((r) => r.status === 'collecting' || r.status === 'truncated').reverse();
}

/** The runs a tick lists, in the order it lists them: of the three newest
 *  still being built, those with blocks still to be found, the oldest
 *  first, it being the run the next job builds (nextJob) when the budget
 *  runs out before the others. */
export function runsToList(state: ModelState): RunState[] {
	return runsToDiscover(state)
		.slice(0, 3)
		.filter((r) => Object.values(r.blocks).some((b) => b.status === 'waiting'))
		.reverse();
}

/** The next Container job: the OLDEST collecting run with blocks ready (or
 *  failed with attempts left), its ready blocks in order. Never a run older
 *  than the published one. */
export function nextJob(state: ModelState, nowMs: number): Job | null {
	if (state.job || (state.notBefore ?? 0) > nowMs) {
		return null;
	}
	const spec = MODELS[state.model];
	const newest = newestPublished(state);
	for (const r of state.runs) {
		if ((r.status !== 'collecting' && r.status !== 'truncated') || Date.parse(r.run) < newest) {
			continue;
		}
		const order = spec.blocks(new Date(Date.parse(r.run)).getUTCHours()).map((b) => b.name);
		const pick = order.filter((name) => {
			const b = r.blocks[name];
			return b && (b.status === 'ready' || (b.status === 'failed' && b.attempts < MAX_ATTEMPTS));
		});
		if (pick.length > 0) {
			return { run: r.run, blocks: pick.slice(0, blocksPerJob(spec)), started: nowMs };
		}
	}
	return null;
}

export function startJob(state: ModelState, job: Job): void {
	state.job = job;
	const run = state.runs.find((r) => r.run === job.run);
	for (const name of job.blocks) {
		const b = run?.blocks[name];
		if (b) {
			b.status = 'running';
		}
	}
}

/** How far a receipt's build time may run ahead of the job's start (the
 *  Container's clock against the Durable Object's). */
const RECEIPT_SKEW_MS = 10 * 60_000;

/** Whether a receipt is this job's account of this block: the model, the
 *  run and the hours it states, a key where the block's archive lives, and
 *  a build no older than the job. A receipt left by an earlier build of the
 *  block (one demoted by its canaries, say) was taken for the job's own. */
export function receiptFits(state: ModelState, job: Job, name: string, rec: Receipt | null | undefined): rec is Receipt {
	if (!rec || rec.model !== state.model || rec.run !== job.run) {
		return false;
	}
	const spec = MODELS[state.model];
	const blocks = spec.blocks(new Date(Date.parse(job.run)).getUTCHours());
	const i = blocks.findIndex((b) => b.name === name);
	const b = blocks[i];
	if (!b || rec.first !== b.first || rec.last !== b.last) {
		return false;
	}
	const run = runKeyOf(job.run);
	const base = i === 0 ? `first/${state.model}/${run}` : `blocks/${state.model}/${run}/${name}`;
	// The archive's key, its content hash before the extension or none (a
	// build before VersionedKey).
	if (!rec.key.startsWith(base) || !/^(\.[0-9a-f]{12})?\.pmtiles$/.test(rec.key.slice(base.length))) {
		return false;
	}
	return rec.built == null || Date.parse(rec.built) >= job.started - RECEIPT_SKEW_MS;
}

function runKeyOf(run: string): string {
	return run.slice(0, 13).replace(/[-T]/g, '');
}

/** How a job ended, for what it is charged (finishJob): `exited`, run to
 *  its end or its first failure; `stopped` on request after finishing the
 *  block in progress; `unstarted`, the Container never ran. */
export type JobEnd = 'exited' | 'stopped' | 'unstarted';

/** How a job that ran ended: stopped on request when it exited
 *  EXIT_STOPPED, or when its OWN log (writtenByJob) ends on the stop's line.
 *  The log is the evidence that survives the runtime's account: a stop the
 *  platform signalled may be reported as the signal rather than the exit
 *  status, and a lost monitor reports 0. An exit 0 alone is never a stop. */
export function jobEnd(exitCode: number | null | undefined, ownLastLine?: string): JobEnd {
	return exitCode === EXIT_STOPPED || (ownLastLine !== undefined && STOPPED_LINE.test(ownLastLine)) ? 'stopped' : 'exited';
}

/** Whether an object a job leaves (its log, a receipt) is this job's own:
 *  uploaded at or after the job started. A log's key is the job's first
 *  block and a receipt's its block, so a job that died without writing one
 *  (killed at its cap, out of memory) would read an earlier job's: its
 *  error and its stop, or a receipt a canary had already condemned, the
 *  block then taken for built and condemned again, a job a minute. The
 *  earlier object was stored before that job exited, which was before this
 *  one started (job.started is taken right before the start). */
export function writtenByJob(job: Job, uploadedMs: number): boolean {
	return uploadedMs >= job.started;
}

/** Records a finished job. A block with its receipt is built.
 *  - `exited`: `nwp ingest` builds the job's blocks in order and stops at
 *    the first failure, so the first block without a receipt failed
 *    (retried until MAX_ATTEMPTS) and those after it were never tried:
 *    they go back to ready, charged nothing, where every one used to be
 *    charged and a deterministic failure ran the following blocks out of
 *    attempts with it.
 *  - `stopped`: the job finished its block in progress and started no
 *    other, so nothing is charged; the first block left counts the stop,
 *    and from MAX_STOPS is charged as an `exited` job would charge it.
 *  - `unstarted` (the Container refused): nothing counts, nothing is
 *    charged. */
export function finishJob(state: ModelState, receipts: Map<string, Receipt | null>, error: string | null, end: JobEnd = 'exited'): number {
	const job = state.job;
	if (!job) {
		return 0;
	}
	let built = 0;
	const run = state.runs.find((r) => r.run === job.run);
	let charged = end === 'unstarted';
	for (const name of job.blocks) {
		const b = run?.blocks[name];
		if (!b) {
			continue;
		}
		const rec = receipts.get(name);
		if (end !== 'unstarted' && receiptFits(state, job, name, rec)) {
			b.status = 'built';
			b.receipt = rec;
			delete b.error;
			delete b.verified;
			delete b.stops;
			built++;
		} else if (!charged) {
			charged = true;
			if (end === 'stopped' && (b.stops ?? 0) + 1 < MAX_STOPS) {
				b.stops = (b.stops ?? 0) + 1;
				b.status = 'ready';
				continue;
			}
			delete b.stops;
			b.status = 'failed';
			b.attempts++;
			b.error = error ?? 'no receipt';
		} else {
			b.status = 'ready';
		}
	}
	state.job = null;
	return built;
}

/** The UTC day of an instant, as the usage and the notices name it. */
export function utcDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** The daily budget from JOB_BUDGET_MINUTES, ms: whole minutes, 0 holding
 *  every job; anything else (absent, negative, a fraction, a word) the
 *  default. */
export function jobBudgetMs(raw: string | undefined): number {
	const s = (raw ?? '').trim();
	return (/^\d+$/.test(s) ? Number(s) : JOB_BUDGET_MINUTES) * 60_000;
}

/** Today's usage: the stored record when it is today's, none otherwise. */
export function usageToday(state: ModelState, nowMs: number): Usage {
	const day = utcDay(nowMs);
	return state.usage?.day === day ? state.usage : { day, ms: 0, jobs: 0 };
}

/** Whether the model's jobs have spent today's budget: then no job starts
 *  until 00:00 UTC (the overshoot is the one job running when it was
 *  spent, a cap at most, one job running at a time). */
export function budgetSpent(state: ModelState, budgetMs: number, nowMs: number): boolean {
	return usageToday(state, nowMs).ms >= budgetMs;
}

/** Whether a notice is due today, marking it sent: once a UTC day per
 *  kind, so a fault that repeats all day mails once. */
export function noticeDue(state: ModelState, kind: Notice, nowMs: number): boolean {
	const day = utcDay(nowMs);
	if (state.notices?.[kind] === day) {
		return false;
	}
	state.notices = { ...state.notices, [kind]: day };
	return true;
}

/** How a job overran, if it did: ended by its OWN deadline (exit 124, or
 *  its log ending on the deadline's line), which means the orchestrator
 *  did not end it at its cap; or killed past the cap, by the tick or by the
 *  inactivity timeout, whose kill (outside the serialized path) is known by
 *  the time the job ran. A stop never counts. */
export function overran(job: Job, endMs: number, killed: boolean, exitCode?: number | null, lastLine?: string): Notice | null {
	if (exitCode === EXIT_DEADLINE || (lastLine !== undefined && DEADLINE_LINE.test(lastLine))) {
		return 'deadline';
	}
	if (jobEnd(exitCode, lastLine) === 'stopped') {
		return null;
	}
	return killed || endMs - job.started > JOB_CAP_MS + 60_000 ? 'overCap' : null;
}

/** What ended a job, as collect or a failed start found it. */
export interface JobClose {
	receipts: Map<string, Receipt | null>;
	error: string | null;
	end: JobEnd;
	/** The tick killed it past its cap. */
	killed?: boolean;
	exitCode?: number | null;
	/** Its own log's last line, when it wrote one (writtenByJob). */
	lastLine?: string | undefined;
}

/** Closes the job recorded in the state: charges its container time to
 *  today's usage, whatever ended it (a start the library gave up runs the
 *  whole job first: it waits for the container to exit before it throws),
 *  then records its blocks (finishJob) and paces the next job. Returns
 *  what it built and how it overran, if it did. */
export function closeJob(state: ModelState, c: JobClose, nowMs: number): { built: number; overrun: Notice | null } {
	const job = state.job;
	if (!job) {
		return { built: 0, overrun: null };
	}
	const u = usageToday(state, nowMs);
	state.usage = { day: u.day, ms: u.ms + Math.max(0, nowMs - job.started), jobs: u.jobs + 1 };
	const overrun = overran(job, nowMs, c.killed ?? false, c.exitCode, c.lastLine);
	const built = finishJob(state, c.receipts, c.error, c.end);
	paceAfterJob(state, built, nowMs);
	return { built, overrun };
}

/** The budget's line on the status page. */
export function budgetStatus(
	state: ModelState | null | undefined,
	budgetMs: number,
	nowMs: number,
): { usageMin: number; usageJobs: number; budgetMin: number; budgetHeld: boolean } {
	const u = state ? usageToday(state, nowMs) : { ms: 0, jobs: 0 };
	return { usageMin: Math.round(u.ms / 6_000) / 10, usageJobs: u.jobs, budgetMin: budgetMs / 60_000, budgetHeld: u.ms >= budgetMs };
}

/** Paces the jobs after one ended: a job that built nothing, however it
 *  ended (failed, killed at its cap, stopped, or never started), holds the
 *  next one back EMPTY_JOB_PAUSE_MS; one that built a block lets the next
 *  start at once. */
export function paceAfterJob(state: ModelState, built: number, nowMs: number): void {
	if (built > 0) {
		delete state.notBefore;
	} else {
		state.notBefore = nowMs + EMPTY_JOB_PAUSE_MS;
	}
}

/** Whether a stored state stands under the operator's STATE_EPOCH: it
 *  does when it was started under the same value (none reads as ''), or
 *  while it records a job, whose collection the fresh start waits for. A
 *  new value (the bucket moved, or restored) starts every orchestrator
 *  afresh from the bucket's own pointer, once. */
export function stateStands(stored: ModelState, epoch: string): boolean {
	return (stored.stateEpoch ?? '') === epoch || stored.job !== null;
}

/** The fresh state a new STATE_EPOCH starts from: no run and no job, but
 *  the operator's levers remembered (a retry or a test mail already given
 *  is not given again), the alert state kept (a stale model stays
 *  announced, its recovery mailed), and the day's usage and notices kept
 *  (the time spent was spent, and a notice sent is not sent again). The
 *  caller seeds it from the bucket's pointer. */
export function freshState(old: ModelState | undefined, model: ModelId, epoch: string): ModelState {
	const s = emptyState(model);
	s.stateEpoch = epoch;
	if (old) {
		s.alert = { ...old.alert };
		if (old.retryEpoch !== undefined) {
			s.retryEpoch = old.retryEpoch;
		}
		if (old.mailTest !== undefined) {
			s.mailTest = old.mailTest;
		}
		if (old.usage !== undefined) {
			s.usage = { ...old.usage };
		}
		if (old.notices !== undefined) {
			s.notices = { ...old.notices };
		}
	}
	return s;
}

/** Whether a run can be published now, whole or truncated: every block
 *  built, or (past the model's truncation hour, init + 8 h for AROME,
 *  ARPEGE and IFS) the blocks covering the first 24 hours built in a row
 *  from the first, for a run newer than the one served. */
export function publication(state: ModelState, run: RunState, nowMs: number): { blocks: string[]; truncated: boolean } | null {
	const spec = MODELS[state.model];
	const order = spec.blocks(new Date(Date.parse(run.run)).getUTCHours());
	if (run.status === 'collecting' || run.status === 'truncated') {
		if (order.every((b) => run.blocks[b.name]?.status === 'built')) {
			return { blocks: order.map((b) => b.name), truncated: false };
		}
	}
	if (run.status !== 'collecting' || nowMs - Date.parse(run.run) < truncateAfterMs(spec) || Date.parse(run.run) <= newestPublished(state)) {
		return null;
	}
	const prefix: string[] = [];
	for (const b of order) {
		if (run.blocks[b.name]?.status !== 'built') {
			break;
		}
		prefix.push(b.name);
		if (b.last >= 24) {
			return { blocks: prefix, truncated: true };
		}
	}
	return null;
}

function blockRef(rec: Receipt): BlockRef {
	return { first: rec.first, last: rec.last, key: rec.key, size: rec.size, steps: rec.steps, gustPeriod: rec.gustPeriod };
}

/** The pointer once a run is published: the run joins the served ones (the
 *  newest three; never ahead of a newer run already served) and its first
 *  block the week of past hours. */
export function nextPointer(prev: Pointer | null, model: ModelId, run: RunState, names: string[], truncated: boolean, nowMs: number): Pointer {
	const receipts = names.map((n) => run.blocks[n].receipt).filter((r): r is Receipt => !!r);
	if (receipts.length !== names.length || receipts.length === 0) {
		throw new Error(`${model} ${run.run}: publishing blocks without receipts`);
	}
	receipts.sort((a, b) => a.first - b.first);
	const ref: RunRef = {
		run: run.run,
		published: iso(nowMs),
		horizon: receipts[receipts.length - 1].last,
		blocks: receipts.map(blockRef),
	};
	if (truncated) {
		ref.truncated = true;
	}
	// A whole run served is never replaced by a truncated publication of
	// it (the orchestrator's state lost and the run tracked again): what is
	// served stays, and nothing of it is released.
	if (truncated && prev?.runs.some((r) => r.run === run.run && !r.truncated)) {
		return prev;
	}
	const runs = (prev?.runs ?? []).filter((r) => r.run !== run.run);
	const newestServed = runs.length > 0 ? Math.max(...runs.map((r) => Date.parse(r.run))) : -Infinity;
	if (Date.parse(run.run) > newestServed || runs.length < RUNS_KEPT) {
		runs.push(ref);
	}
	runs.sort((a, b) => Date.parse(b.run) - Date.parse(a.run));
	const first = receipts[0];
	const past: PastRef[] = (prev?.past ?? []).filter((p) => p.run !== run.run);
	if (first.first === 0) {
		past.push({ ...blockRef(first), run: run.run });
	}
	past.sort((a, b) => Date.parse(b.run) - Date.parse(a.run));
	return {
		model,
		updated: iso(nowMs),
		runs: runs.slice(0, RUNS_KEPT),
		past: past.filter((p) => nowMs - Date.parse(p.run) <= PAST_KEPT_MS),
	};
}

/** The archive keys a pointer change lets go: blocks of runs no longer
 *  served (a first block lives on while the week of past hours keeps it). */
export function released(prev: Pointer | null, next: Pointer): string[] {
	if (!prev) {
		return [];
	}
	const kept = new Set<string>();
	for (const r of next.runs) {
		r.blocks.forEach((b) => kept.add(b.key));
	}
	next.past.forEach((p) => kept.add(p.key));
	const out = new Set<string>();
	for (const r of prev.runs) {
		r.blocks.forEach((b) => !kept.has(b.key) && out.add(b.key));
	}
	prev.past.forEach((p) => !kept.has(p.key) && out.add(p.key));
	return [...out];
}

/** Whether the served run is overdue: older than its model's stale hours
 *  (the next run should long have landed), or two runs in a row given up. */
export function staleness(state: ModelState, nowMs: number): string {
	const spec = MODELS[state.model];
	const newest = newestPublished(state);
	if (newest === -Infinity) {
		return state.runs.length > 0 && nowMs - Math.min(...state.runs.map((r) => r.seenAt)) > spec.staleHours * 3600_000
			? 'no run published yet'
			: '';
	}
	const age = nowMs - newest;
	if (age > spec.staleHours * 3600_000) {
		return `the served run ${iso(newest)} is ${Math.round(age / 3600_000)} h old`;
	}
	if (state.failedRuns >= 2) {
		return `${state.failedRuns} runs in a row given up`;
	}
	// A run served truncated whose later blocks failed for good is fresh by
	// its age and still serves a day where the model reaches further: the
	// IFS gust's second name had every IFS run served to +24 h for a night
	// with no mail.
	const served = state.runs.find((r) => r.status === 'truncated' && Date.parse(r.run) === newest);
	const dead = served ? Object.entries(served.blocks).filter(([, b]) => b.status === 'failed' && b.attempts >= MAX_ATTEMPTS) : [];
	if (served && dead.length > 0) {
		return `the served run ${served.run} is truncated, ${dead.length} block(s) failed for good (${dead[0][0]}: ${(dead[0][1].error ?? '').slice(0, 200)})`;
	}
	return '';
}

/** Seeds an empty state (a Durable Object that lost its storage) from the
 *  published pointer: its runs as published, the truncated ones with the
 *  blocks it names built and verified, so that no served run is built
 *  again from scratch and none of its blocks released by a truncated
 *  republication. */
export function seedFromPointer(state: ModelState, p: Pointer, nowMs: number): void {
	const spec = MODELS[state.model];
	for (const r of p.runs) {
		if (state.runs.some((x) => x.run === r.run)) {
			continue;
		}
		const blocks: Record<string, BlockState> = {};
		for (const b of spec.blocks(new Date(Date.parse(r.run)).getUTCHours())) {
			const ref = r.blocks.find((x) => x.first === b.first && x.last === b.last);
			blocks[b.name] = ref
				? {
						status: 'built',
						attempts: 0,
						verified: true,
						receipt: { ...ref, model: state.model, run: r.run, content: '', tiles: 0, canaries: [] },
					}
				: { status: 'waiting', attempts: 0 };
		}
		state.runs.push({ run: r.run, status: r.truncated ? 'truncated' : 'published', blocks, seenAt: nowMs, publishedAt: Date.parse(r.published) });
	}
	state.runs.sort((a, b) => Date.parse(a.run) - Date.parse(b.run));
}
