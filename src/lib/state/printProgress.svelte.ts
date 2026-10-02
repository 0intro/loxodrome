/* Shared progress tracker for the pack-print prefetches (flight preparation
 * / flight dossier in FlightPrepModal, weather briefing in WxPrintHost). One
 * singleton is enough: the app guarantees only one portaled document ever
 * prints at a time (the modal open()s cancel a pending briefing print). The
 * hosts register a step plan per run, advance the steps as their parallel
 * tasks settle, and record ISSUES (i18n codes + params, never rendered
 * strings; docs/i18n.md rule 7) for every degradation. A run that ends
 * clean prints at once; one that ends with issues HOLDS before the print
 * dialog and asks (awaitPrintDecision): print anyway, retry, or cancel, so
 * the pilot reads what is missing while it can still be acted on, never
 * after the paper. Stale writes are the norm here (wind / wx / catalog
 * fetches are not abortable and settle after a cancel), so EVERY mutator
 * takes the run's generation and no-ops when superseded. */

import type { SofiaChartProduct } from '$lib/sofia/charts';
import type { SofiaFailure } from '$lib/sofia/failure';
import type { FrontFailure } from '$lib/weather/frontCharts';

export type PrintProgressMode = 'prep' | 'dossier' | 'wx';

export type PrintStepKind =
	| 'datasets'
	| 'msa'
	| 'wind'
	| 'terrain'
	| 'wx'
	| 'fronts'
	| 'charts'
	| 'pages';

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
	| { code: 'datasets' | 'msa' | 'wind' | 'wind-blank' | 'terrain' }
	| { code: 'wx-station'; param: string }
	| { code: 'charts-catalog'; product: SofiaChartProduct; zone: string; failure: SofiaFailure }
	/** A selected chart that could not be downloaded or drawn. */
	| { code: 'charts-failed'; chart: string; validAtMs: number | null; failure: SofiaFailure }
	/** A product left without a usable chart for the flight (weather/
	 *  tripCharts.ts notes that hold): not out yet, overdue, or none listed. */
	| {
			code: 'charts-missing';
			product: SofiaChartProduct;
			zone: string;
			level: string | null;
			kind: 'not-yet-published' | 'missing' | 'none';
			validAtMs: number | null;
			publishAtMs: number | null;
	  }
	| { code: 'charts-undated'; product: SofiaChartProduct; zone: string }
	/** A half of the DWD front charts that could not be had (weather/
	 *  frontCharts.ts): the analyses through the relay, or every forecast
	 *  file at www.dwd.de. */
	| { code: 'fronts-unavailable'; half: 'analyses' | 'forecasts'; failure: FrontFailure }
	/** The flight left without a DWD chart near it: past the last forecast
	 *  DWD has drawn, or between two too far either side (the nearest
	 *  validity, or null when none is known). */
	| { code: 'fronts-missing'; kind: 'none-near' | 'beyond'; validAtMs: number | null }
	/** A selected DWD chart that could not be retrieved. */
	| { code: 'fronts-failed'; chart: string; validAtMs: number; failure: FrontFailure }
	/** The flight the dossier plans is behind us (weather/tripCharts.ts
	 *  FlightPast): no forecast applies, and no chart is asked for. */
	| { code: 'flight-past'; startMs: number; dayOnly: boolean };

/** An issue's identity: one line per distinct issue, every parameter
 *  counting (a TEMSI and a WINTEM catalog failure are two lines). The keyed
 *  list in PrintProgress reads the same key. */
export function printIssueKey(issue: PrintIssue): string {
	return JSON.stringify(issue);
}

/** What the pilot answers a run that ends with issues. */
export type PrintDecision = 'print' | 'retry' | 'cancel';

export const printProgress = $state<{
	/** Overlay mounted (preparing, or holding for the pilot's decision). */
	active: boolean;
	/** 'review' while the run holds before the print dialog for a decision. */
	phase: 'running' | 'review';
	/** The user cancelled this run; the host skips the print. */
	cancelled: boolean;
	mode: PrintProgressMode;
	/** Run generation; mutators no-op on a stale gen. */
	gen: number;
	steps: PrintStep[];
	issues: PrintIssue[];
}>({
	active: false,
	phase: 'running',
	cancelled: false,
	mode: 'dossier',
	gen: 0,
	steps: [],
	issues: [],
});

/** The active run's abort (plain module var, deliberately non-reactive). */
let onCancel: (() => void) | null = null;

/** The pending decision's resolver: a plain module variable, so no
 *  reactive read or teardown can lose it. EVERY way the card goes away
 *  resolves it (a Cancel, a close, a new run), or a host awaiting it would
 *  stay busy, its print rows disabled, for the rest of the session. */
let decide: ((d: PrintDecision) => void) | null = null;

function resolveDecision(d: PrintDecision): void {
	const r = decide;
	decide = null;
	r?.(d);
}

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
	// A run replacing one that holds for a decision ends that one.
	resolveDecision('cancel');
	printProgress.issues = [];
	printProgress.cancelled = false;
	printProgress.phase = 'running';
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
	const key = printIssueKey(issue);
	if (!printProgress.issues.some((i) => printIssueKey(i) === key)) {
		printProgress.issues.push(issue);
	}
}

/** Hold the run before the print dialog and ask the pilot what to do with
 *  the issues it raised: the card turns into its review (phase 'review')
 *  until a button answers. A stale or cancelled run answers 'cancel' at
 *  once, so a host never waits on a card nobody can see. */
export function awaitPrintDecision(gen: number): Promise<PrintDecision> {
	if (gen !== printProgress.gen || printProgress.cancelled || !printProgress.active) {
		return Promise.resolve('cancel');
	}
	resolveDecision('cancel');
	printProgress.phase = 'review';
	return new Promise((resolve) => {
		decide = resolve;
	});
}

/** The review's Print anyway / Retry. A Retry re-runs the whole prefetch
 *  (the host starts a new run, which resets this card in place). */
export function decidePrint(choice: 'print' | 'retry'): void {
	if (printProgress.phase !== 'review') {
		return;
	}
	printProgress.phase = 'running';
	resolveDecision(choice);
}

/** The Cancel button, while preparing or in review: hide the overlay, flag
 *  the run (the host checks `cancelled` before printing), answer a pending
 *  decision and abort what can be aborted. */
export function requestPrintCancel(): void {
	if (!printProgress.active) {
		return;
	}
	printProgress.cancelled = true;
	printProgress.active = false;
	printProgress.phase = 'running';
	resolveDecision('cancel');
	onCancel?.();
	onCancel = null;
}

/** After the print dialog closes (the afterprint reset): drop the overlay.
 *  Every issue was read before printing, in the review, so nothing is left
 *  to say. Keyed on the run: a late afterprint must not close another run's
 *  card. */
export function settlePrintProgress(gen: number): void {
	if (gen !== printProgress.gen || !printProgress.active || printProgress.cancelled) {
		return;
	}
	printProgress.active = false;
}

/** Full reset: the hosts' close cleanups. Answers a pending decision. */
export function closePrintProgress(): void {
	printProgress.active = false;
	printProgress.phase = 'running';
	printProgress.steps = [];
	printProgress.issues = [];
	resolveDecision('cancel');
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
