/* One print job at a time (ui/surfacePrint.svelte.ts printJobLive). In the
 * Android shell printPage returns at once and the plugin answers only when
 * the JOB ends (ui/print.ts), which a printer working through it can put
 * minutes after the dialog, with the app usable meanwhile. That job's one
 * afterprint tears down every flow's document, classes and @page, so a
 * second print started under it lost its own page setup to the first's end
 * and leaked the first's @page onto every later print. printPage is held
 * here the way the plugin holds it: the job lives until afterprint. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const printPage = vi.hoisted(() => vi.fn());
vi.mock('$lib/ui/print', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/ui/print')>()),
	printPage,
}));

import {
	markDocumentPrint,
	printJobLive,
	printSurface,
	registerPageSetup,
} from '$lib/ui/surfacePrint.svelte';

class FakeStyle {
	textContent = '';
	remove(): void {
		head.children = head.children.filter((c) => c !== this);
	}
}
const head = {
	children: [] as FakeStyle[],
	appendChild(el: FakeStyle): void {
		this.children.push(el);
	},
};
const listeners: { type: string; fn: () => void }[] = [];

beforeEach(() => {
	head.children = [];
	listeners.length = 0;
	printPage.mockClear();
	const classes = new Set<string>();
	vi.stubGlobal('document', {
		title: 'Loxodrome',
		head,
		createElement: () => new FakeStyle(),
		documentElement: { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } },
	});
	vi.stubGlobal('window', {
		addEventListener: (type: string, fn: () => void) => listeners.push({ type, fn }),
		removeEventListener: () => undefined,
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** The job ends: its afterprint reaches every one-shot listener. */
function afterprint(): void {
	const due = listeners.filter((l) => l.type === 'afterprint');
	listeners.splice(0, listeners.length, ...listeners.filter((l) => l.type !== 'afterprint'));
	for (const l of due) {
		l.fn();
	}
}

const LANDSCAPE = '@media print { @page { size: A4 landscape; margin: 10mm; } }';

describe('a surface print', () => {
	it('starts no second job under a live one, and leaves no @page behind', async () => {
		const off = [registerPageSetup('routeProfile', () => LANDSCAPE), registerPageSetup('navlog', () => null)];
		await printSurface('routeProfile');
		expect(printJobLive()).toBe(true);
		expect(head.children).toHaveLength(1);
		await printSurface('navlog');
		expect(printPage).toHaveBeenCalledTimes(1);
		expect(head.children).toHaveLength(1);
		afterprint();
		expect(printJobLive()).toBe(false);
		expect(head.children).toHaveLength(0);
		// The next job runs as its own.
		await printSurface('navlog');
		expect(printPage).toHaveBeenCalledTimes(2);
		afterprint();
		off.forEach((f) => f());
	});

	it('waits for a document flow’s job too', async () => {
		markDocumentPrint('LFPN-LFOZ_dossier_20261118');
		expect(printJobLive()).toBe(true);
		await printSurface('routeProfile');
		expect(printPage).not.toHaveBeenCalled();
		afterprint();
		expect(printJobLive()).toBe(false);
	});
});

describe('the document flows', () => {
	const read = (p: string): string => readFileSync(p, 'utf8');

	it('start no print under a live job, and their menus say so', () => {
		expect(read('src/lib/components/SurfaceShell.svelte')).toContain('disabled={!!directPrint && printBusy()}');
		expect(read('src/lib/components/PackPrintHost.svelte')).toContain('if (printBusy()) {');
		expect(read('src/lib/state/printProgress.svelte.ts')).toContain(
			'return wxPrint.preparing || packPrint.preparing || navlogPrint.preparing || printJobLive();',
		);
		expect(read('src/lib/components/WxPrintHost.svelte')).toContain('if (printBusy() || printing) {');
		expect(read('src/lib/components/NotamPrintHost.svelte')).toContain('if (printing || printBusy()) {');
		const nl = read('src/lib/components/NavLogModal.svelte');
		expect(nl.match(/if \(printBusy\(\) \|\|/g)).toHaveLength(1);
		expect(nl.match(/disabled=\{printBusy\(\)\}/g)).toHaveLength(2);
		expect(nl).not.toContain('printJobLive');
		expect(read('src/lib/components/tabs/WeatherTab.svelte')).toMatch(/printableRouteCount === 0 \|\|\s+printBusy\(\)\}/);
		expect(read('src/lib/components/tabs/NotamsTab.svelte')).toContain('disabled={sections.length === 0 || printBusy()}');
	});
});
