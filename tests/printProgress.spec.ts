/* The print-progress tracker's review (src/lib/state/printProgress.svelte.ts):
 * a run that ends with issues holds for the pilot's decision, and EVERY way
 * the card can go answers that decision, or a host awaiting it would stay
 * busy, its print rows disabled, for the rest of the session. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	addPrintIssue,
	awaitPrintDecision,
	beginPrintProgress,
	closePrintProgress,
	decidePrint,
	printIssueKey,
	printProgress,
	requestPrintCancel,
	settlePrintProgress,
	type PrintIssue,
} from '$lib/state/printProgress.svelte';

const PLAN = [{ kind: 'charts' as const }, { kind: 'pages' as const }];

beforeEach(() => {
	closePrintProgress();
});

describe('the review', () => {
	it('holds until Print anyway, then runs on', async () => {
		const gen = beginPrintProgress('dossier', PLAN, () => {});
		const p = awaitPrintDecision(gen);
		expect(printProgress.phase).toBe('review');
		decidePrint('print');
		expect(await p).toBe('print');
		expect(printProgress.phase).toBe('running');
		expect(printProgress.active).toBe(true);
	});

	it('answers Retry', async () => {
		const gen = beginPrintProgress('wx', PLAN, () => {});
		const p = awaitPrintDecision(gen);
		decidePrint('retry');
		expect(await p).toBe('retry');
	});

	it('answers Cancel, aborting the run', async () => {
		const abort = vi.fn();
		const gen = beginPrintProgress('dossier', PLAN, abort);
		const p = awaitPrintDecision(gen);
		requestPrintCancel();
		expect(await p).toBe('cancel');
		expect(abort).toHaveBeenCalledTimes(1);
		expect(printProgress.active).toBe(false);
		expect(printProgress.cancelled).toBe(true);
	});

	it('is answered by a close and by a run replacing it', async () => {
		const gen = beginPrintProgress('dossier', PLAN, () => {});
		const closed = awaitPrintDecision(gen);
		closePrintProgress();
		expect(await closed).toBe('cancel');
		const gen2 = beginPrintProgress('dossier', PLAN, () => {});
		const replaced = awaitPrintDecision(gen2);
		beginPrintProgress('wx', PLAN, () => {});
		expect(await replaced).toBe('cancel');
	});

	it('answers a stale or cancelled run at once', async () => {
		const gen = beginPrintProgress('dossier', PLAN, () => {});
		beginPrintProgress('dossier', PLAN, () => {});
		expect(await awaitPrintDecision(gen)).toBe('cancel');
		const gen3 = beginPrintProgress('dossier', PLAN, () => {});
		requestPrintCancel();
		expect(await awaitPrintDecision(gen3)).toBe('cancel');
	});

	it('ignores a decision with nothing in review', () => {
		beginPrintProgress('dossier', PLAN, () => {});
		decidePrint('print');
		expect(printProgress.phase).toBe('running');
	});
});

describe('after the print dialog', () => {
	it('drops the card, and a late afterprint leaves another run’s card alone', () => {
		const gen = beginPrintProgress('dossier', PLAN, () => {});
		settlePrintProgress(gen);
		expect(printProgress.active).toBe(false);
		const old = beginPrintProgress('dossier', PLAN, () => {});
		const current = beginPrintProgress('wx', PLAN, () => {});
		settlePrintProgress(old);
		expect(printProgress.active).toBe(true);
		settlePrintProgress(current);
		expect(printProgress.active).toBe(false);
	});
});

describe('issues', () => {
	it('are one line per distinct issue, every parameter counting', () => {
		const gen = beginPrintProgress('dossier', PLAN, () => {});
		const failure = { code: 'upstream' as const, detail: 'HTTP 502' };
		const temsi: PrintIssue = { code: 'charts-catalog', product: 'TEMSI', zone: 'FRANCE', failure };
		const wintem: PrintIssue = { code: 'charts-catalog', product: 'WINTEM', zone: 'FRANCE', failure };
		addPrintIssue(gen, temsi);
		addPrintIssue(gen, wintem);
		addPrintIssue(gen, { ...temsi });
		expect(printProgress.issues).toHaveLength(2);
		expect(printIssueKey(temsi)).not.toBe(printIssueKey(wintem));
	});
});
