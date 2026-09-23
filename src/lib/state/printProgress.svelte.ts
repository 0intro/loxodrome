/* Shared progress tracker for the pack-print prefetches (flight preparation
 * / flight dossier in FlightPrepModal, weather briefing in WxPrintHost). One
 * singleton is enough: the app guarantees only one portaled document ever
 * prints at a time (the modal open()s cancel a pending briefing print). The
 * hosts register a step plan per run, advance the steps as their parallel
 * tasks settle, and record ISSUES (i18n codes + params, never rendered
 * strings; docs/i18n.md rule 7) for every degradation. Issues are
 * non-blocking by design: printing always proceeds with the data that
 * arrived, and the overlay ends in a summary card when anything failed.
 * Stale writes are the norm here (wind / wx / catalog fetches are not
 * abortable and settle after a cancel), so EVERY mutator takes the run's
 * generation and no-ops when superseded. */

export type PrintProgressMode = 'prep' | 'dossier' | 'wx';

export type PrintStepKind = 'datasets' | 'msa' | 'wind' | 'terrain' | 'wx' | 'charts' | 'pages';

export interface PrintStep {
	kind: PrintStepKind;
	status: 'pending' | 'running' | 'done' | 'error';
	/** Settled units (counted steps); done + failed drive completion. */
	done: number;
	failed: number;
	/** Unit count; 0 = binary step (no counter shown). */
	total: number;
	/** Invariant token beside the counter (the SOFIA chart being fetched). */
	param: string | null;
}

/** One degradation line of the overlay: codes + params only, localized at
 *  render (the wx-station / charts codes reuse existing catalog strings). */
export type PrintIssue =
	| { code: 'datasets' | 'msa' | 'wind' | 'terrain' }
	| { code: 'wx-station'; param: string }
	| { code: 'charts-failed'; n: number }
	| { code: 'charts-catalog' };

export const printProgress = $state<{
	/** Overlay mounted (running, or showing the post-print summary). */
	active: boolean;
	/** Post-print "printed with missing data" card (issues.length > 0). */
	summary: boolean;
	/** The user cancelled this run; the host skips the print. */
	cancelled: boolean;
	mode: PrintProgressMode;
	/** Run generation; mutators no-op on a stale gen. */
	gen: number;
	steps: PrintStep[];
	issues: PrintIssue[];
}>({
	active: false,
	summary: false,
	cancelled: false,
	mode: 'dossier',
	gen: 0,
	steps: [],
	issues: [],
});

/** The active run's abort (plain module var, deliberately non-reactive). */
let onCancel: (() => void) | null = null;

/** Start a run: rebuild the step list (in plan order), clear the issues and
 *  flags, register the run's cancel hook, and return the new generation. */
export function beginPrintProgress(
	mode: PrintProgressMode,
	plan: { kind: PrintStepKind; total?: number }[],
	cancel: () => void,
): number {
	printProgress.gen += 1;
	printProgress.mode = mode;
	printProgress.steps = plan.map((p) => ({
		kind: p.kind,
		status: 'pending',
		done: 0,
		failed: 0,
		total: p.total ?? 0,
		param: null,
	}));
	printProgress.issues = [];
	printProgress.cancelled = false;
	printProgress.summary = false;
	printProgress.active = true;
	onCancel = cancel;
	return printProgress.gen;
}

function stepOf(gen: number, kind: PrintStepKind): PrintStep | null {
	if (gen !== printProgress.gen) {
		return null;
	}
	return printProgress.steps.find((s) => s.kind === kind) ?? null;
}

export function stepStart(gen: number, kind: PrintStepKind): void {
	const s = stepOf(gen, kind);
	if (s && s.status === 'pending') {
		s.status = 'running';
	}
}

/** One unit of a counted step settled; auto-settles the step when the last
 *  unit lands (each unit settles on its own, there is no single join). */
export function stepAdvance(gen: number, kind: PrintStepKind, ok = true): void {
	const s = stepOf(gen, kind);
	if (!s) {
		return;
	}
	if (s.status === 'pending') {
		s.status = 'running';
	}
	if (ok) {
		s.done += 1;
	} else {
		s.failed += 1;
	}
	if (s.total > 0 && s.done + s.failed >= s.total && s.status === 'running') {
		s.status = s.failed > 0 ? 'error' : 'done';
	}
}

/** Absolute progress write (the fetchers' onProgress callbacks report
 *  absolute counts); never settles, the host ends the step when the doc
 *  returns. `param` null clears the token; undefined leaves it alone. */
export function stepSet(
	gen: number,
	kind: PrintStepKind,
	progress: { done?: number; total?: number; param?: string | null },
): void {
	const s = stepOf(gen, kind);
	if (!s) {
		return;
	}
	if (s.status === 'pending') {
		s.status = 'running';
	}
	if (progress.done !== undefined) {
		s.done = progress.done;
	}
	if (progress.total !== undefined) {
		s.total = progress.total;
	}
	if (progress.param !== undefined) {
		s.param = progress.param;
	}
}

export function stepEnd(gen: number, kind: PrintStepKind, ok: boolean): void {
	const s = stepOf(gen, kind);
	if (!s) {
		return;
	}
	s.param = null;
	s.status = ok && s.failed === 0 ? 'done' : 'error';
}

export function addPrintIssue(gen: number, issue: PrintIssue): void {
	if (gen !== printProgress.gen) {
		return;
	}
	const key = (i: PrintIssue): string => i.code + ('param' in i ? `|${i.param}` : '');
	if (!printProgress.issues.some((i) => key(i) === key(issue))) {
		printProgress.issues.push(issue);
	}
}

/** The Cancel button: hide the overlay, flag the run (the host checks
 *  `cancelled` before printing) and abort what can be aborted. */
export function requestPrintCancel(): void {
	if (!printProgress.active || printProgress.summary) {
		return;
	}
	printProgress.cancelled = true;
	printProgress.active = false;
	onCancel?.();
	onCancel = null;
}

/** After the print dialog closes (the afterprint reset): keep a summary
 *  card up when anything degraded, else drop the overlay. */
export function settlePrintProgress(): void {
	if (!printProgress.active || printProgress.cancelled) {
		return;
	}
	if (printProgress.issues.length > 0) {
		printProgress.summary = true;
	} else {
		printProgress.active = false;
	}
}

/** Full reset: the summary Close button and the hosts' close cleanups. */
export function closePrintProgress(): void {
	printProgress.active = false;
	printProgress.summary = false;
	printProgress.steps = [];
	printProgress.issues = [];
	onCancel = null;
}

/** Resolves (never rejects) when the signal aborts: racing the prefetch
 *  against it unblocks a cancelled host immediately, while the tasks that
 *  cannot abort settle into locals (their late tracker writes are stale-gen
 *  no-ops or invisible behind the hidden overlay). */
export function abortedPromise(signal: AbortSignal): Promise<void> {
	if (signal.aborted) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		signal.addEventListener('abort', () => resolve(), { once: true });
	});
}

/** Overall fraction for the bar: settled steps count 1, a running counted
 *  step its settled share, anything else 0; averaged over the plan. */
export function printProgressFraction(): number {
	const steps = printProgress.steps;
	if (steps.length === 0) {
		return 0;
	}
	let sum = 0;
	for (const s of steps) {
		if (s.status === 'done' || s.status === 'error') {
			sum += 1;
		} else if (s.total > 0) {
			sum += Math.min(1, (s.done + s.failed) / s.total);
		}
	}
	return sum / steps.length;
}
