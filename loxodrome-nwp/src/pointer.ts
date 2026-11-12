/* latest/<model>.json: what the orchestrator published and the read path
 * serves. Whole runs (newest first, the last three) with their blocks, and
 * the first blocks kept a week for the past hours. Each block carries its
 * segments' steps, so the read path plans which archives an hour needs
 * without opening any. */

import type { ModelId } from './models.ts';

export type StepSegment = 'sfc' | 'ps' | 'uvt' | 'z' | 'cloud';

export interface BlockRef {
	first: number;
	last: number;
	key: string;
	size: number;
	steps: Record<StepSegment, number[]>;
	/** The gust's statistical period in hours, by sfc step. */
	gustPeriod: number[];
}

export interface RunRef {
	/** ISO 8601 UTC. */
	run: string;
	published: string;
	/** The last hour the published blocks reach. */
	horizon: number;
	truncated?: boolean;
	blocks: BlockRef[];
}

export interface PastRef extends BlockRef {
	run: string;
}

export interface Pointer {
	model: ModelId;
	updated: string;
	runs: RunRef[];
	past: PastRef[];
}

export function isPointer(x: unknown): x is Pointer {
	const p = x as Pointer;
	return !!p && typeof p.model === 'string' && Array.isArray(p.runs) && Array.isArray(p.past);
}

/** A run's start in whole hours since the epoch. */
export function runHour(run: string): number {
	return Math.round(Date.parse(run) / 3600_000);
}

/** How a run is named to clients (x_runs, x_latest, the meta's
 *  last_run_initialisation_time), in seconds: its start, one second later
 *  once published whole. A run published truncated at init + 8 h and whole
 *  later keeps its start, and the client's freshness compares the runs it
 *  knows by that number: the second is what makes the whole publication
 *  read as newer than the truncated one, so a column stitched from the
 *  older run past the truncation is asked again rather than kept until the
 *  next cycle. Minutes are all a client shows of it. */
export function runStamp(run: RunRef): number {
	return runHour(run.run) * 3600 + (run.truncated ? 0 : 1);
}
