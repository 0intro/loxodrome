/* The offline download queue (docs/offline-maps.md, "The download queue"):
 * what the pilot has asked to be stored, held as data so the run itself can
 * be a plain sequential drain nothing has to synchronise against.
 *
 * Pure and store-free, the traceQueue.ts split: one fold per operation, with
 * the reactive runner in state/offlineQueue.svelte.ts. Sequential is the
 * POINT rather than an implementation limit: the archives run from 826 MB
 * (es500) to 25 GB (us500), and racing two of them halves both throughputs,
 * makes every figure on screen meaningless and multiplies the resume
 * surface for nothing.
 *
 * Locale-free (docs/i18n.md rule 6): ids and numbers out, never a string.
 */

/** Which module owns a job's run. `terrain` is a singleton kind: its payload
 *  is the current PLAN rather than a catalog row, so it has exactly one id. */
export type JobKind = 'chart' | 'doc' | 'terrain';

/** One job's identity: the owning module's own catalog id ('es500',
 *  'fr-vac'), or TERRAIN_JOB_ID for the plan. */
export interface JobRef {
	kind: JobKind;
	id: string;
}

/** The terrain job's only id: one plan, one pin set, one job. */
export const TERRAIN_JOB_ID = 'plan';

export type JobKey = string;

/** A queued job as the QUEUE sees it: identity plus the two numbers a waiting
 *  row and the aggregate need. What a job DOES is deliberately absent; the
 *  run is a closure the runner holds, which is what keeps this module
 *  payload-free and node-testable. */
export interface QueueJob {
	kind: JobKind;
	id: string;
	/** Bytes the whole job will write, null when not known (a size HEAD that
	 *  failed, a pre-release pack the server does not publish). Never 0 as a
	 *  stand-in for unknown: the aggregate has to be able to say so. */
	sizeBytes: number | null;
	/** Bytes already secured (a paused .part, tiles already pinned), so that
	 *  what is promised is what is LEFT. */
	localBytes: number;
}

export function jobKey(ref: JobRef): JobKey {
	return `${ref.kind}/${ref.id}`;
}

export function sameJob(a: JobRef, b: JobRef): boolean {
	return a.kind === b.kind && a.id === b.id;
}

/** `queue` with `job` folded in: one entry per key, an existing entry keeping
 *  its POSITION and taking the new numbers. Position is what a pilot tapping
 *  Download twice must not lose; the numbers are what a fresh HEAD improves. */
export function enqueue(queue: readonly QueueJob[], job: QueueJob): QueueJob[] {
	const key = jobKey(job);
	const at = queue.findIndex((j) => jobKey(j) === key);
	if (at < 0) {
		return [...queue, job];
	}
	const out = [...queue];
	out[at] = job;
	return out;
}

/** The head and what is left. A null head on an empty queue. */
export function dequeue(queue: readonly QueueJob[]): { job: QueueJob | null; rest: QueueJob[] } {
	const head = queue[0];
	return head === undefined ? { job: null, rest: [] } : { job: head, rest: queue.slice(1) };
}

/** `queue` without `key`; a copy when it is absent. */
export function removeJob(queue: readonly QueueJob[], key: JobKey): QueueJob[] {
	return queue.filter((j) => jobKey(j) !== key);
}

/** 0-based place in the queue, -1 when absent. */
export function queuePosition(queue: readonly QueueJob[], key: JobKey): number {
	return queue.findIndex((j) => jobKey(j) === key);
}

/** What the queue still has to write: the summed remaining bytes of the jobs
 *  whose size is known, and the COUNT of the ones whose is not. Two numbers
 *  rather than one, so a caller can say "2.2 GB and one unknown" instead of
 *  quietly counting the unknown as nothing. */
export function queuedBytes(queue: readonly QueueJob[]): { known: number; unknown: number } {
	let known = 0;
	let unknown = 0;
	for (const j of queue) {
		if (j.sizeBytes === null) {
			unknown++;
		} else {
			// An adopted orphan archive can report more local bytes than the
			// server's size, so the remainder is clamped rather than negative.
			known += Math.max(0, j.sizeBytes - j.localBytes);
		}
	}
	return { known, unknown };
}
