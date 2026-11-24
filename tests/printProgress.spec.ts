/* The print-progress tracker's review (src/lib/state/printProgress.svelte.ts):
 * a run that ends with issues holds for the pilot's decision, and EVERY way
 * the card can go answers that decision, or a host awaiting it would stay
 * busy, its print rows disabled, for the rest of the session. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	addPrintIssue,
	awaitPrintDecision,
	beginPrintProgress,
	cancelPackPrint,
	closePrintProgress,
	decidePrint,
	printBusy,
	printIssueKey,
	printProgress,
	requestPrintCancel,
	settlePrintProgress,
	type PrintIssue,
} from '$lib/state/printProgress.svelte';
import { navlogPrint } from '$lib/state/navlogPrint.svelte';
import { packPrint } from '$lib/state/packPrint.svelte';
import { wxPrint } from '$lib/state/wxPrint.svelte';
import { markDocumentPrint } from '$lib/ui/surfacePrint.svelte';

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

describe('a printing surface opening', () => {
	it('cancels a pack still preparing or in review, and answers its decision', async () => {
		const abort = vi.fn();
		const gen = beginPrintProgress('dossier', PLAN, abort);
		const p = awaitPrintDecision(gen);
		cancelPackPrint();
		expect(await p).toBe('cancel');
		expect(abort).toHaveBeenCalledTimes(1);
		expect(printProgress.active).toBe(false);
		expect(printProgress.cancelled).toBe(true);
	});

	it('leaves a briefing to its own cancel, and a pack handed to the dialog alone', () => {
		const abort = vi.fn();
		beginPrintProgress('wx', PLAN, abort);
		cancelPackPrint();
		expect(abort).not.toHaveBeenCalled();
		expect(printProgress.active).toBe(true);
		const gen = beginPrintProgress('prep', PLAN, abort);
		settlePrintProgress(gen);
		cancelPackPrint();
		expect(abort).not.toHaveBeenCalled();
		expect(printProgress.cancelled).toBe(false);
	});
});

describe('every print row stands down', () => {
	it('while a pack, the briefing or the nav log prepares, and while a job is live', () => {
		expect(printBusy()).toBe(false);
		packPrint.preparing = true;
		expect(printBusy()).toBe(true);
		packPrint.preparing = false;
		navlogPrint.preparing = true;
		expect(printBusy()).toBe(true);
		navlogPrint.preparing = false;
		wxPrint.preparing = true;
		expect(printBusy()).toBe(true);
		wxPrint.preparing = false;
		// A job, as markDocumentPrint holds it until its afterprint.
		const afterprint: (() => void)[] = [];
		vi.stubGlobal('document', { title: 'Loxodrome' });
		vi.stubGlobal('window', {
			addEventListener: (type: string, fn: () => void) => type === 'afterprint' && afterprint.push(fn),
			removeEventListener: () => undefined,
		});
		try {
			markDocumentPrint('LFPN-LFOZ_dossier_20260707');
			expect(printBusy()).toBe(true);
			for (const fn of afterprint.splice(0)) {
				fn();
			}
			expect(printBusy()).toBe(false);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
