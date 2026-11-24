/* Which surface a print job belongs to, and the page setup it needs.
 *
 * Several surfaces can be up at once (a docked profile beside a paged nav
 * log), and they all live in the same body portal, so a print would
 * otherwise put every open box on the paper. A job names one surface: its
 * box keeps the `printing` class SurfaceShell stamps, and app.css hides the
 * rest for the duration.
 *
 * The job also owns the default `@page`. Each surface used to inject its own
 * for the WHOLE TIME it was open, which was sound when a modal was the only
 * thing that could be on screen: with two surfaces up, an open profile
 * silently re-sized another surface's print job (landscape 10mm over the nav
 * log's portrait 0), and with two injectors the winner was DOM order.
 * `@page` cannot be scoped, so exactly one may be installed and only while
 * that job runs.
 *
 * Every programmatic print claims. That is what lets `beforeprint` tell the
 * browser's own print (its menu, or a Ctrl+P the window in front has no
 * printer for) from a flow's own `window.print()` and auto-claim only for
 * the former; the flows that print a portaled document of their own
 * (the nav log's A4 pages and its kneeboard, the flight dossier, the weather
 * briefing, the NOTAM bulletin) mark themselves instead, since their
 * box-hiding and page setup are already their own.
 *
 * The per-surface `html.<name>-print` classes stay what they were: set while
 * a surface is open, carrying its print CSS and palette pins. They say how
 * that surface would print, this says which one is printing.
 *
 * The job owns the document TITLE for the same reason it owns the `@page`:
 * it is the only lever either platform gives us over what the printed file
 * is called. `window.print()` proposes `document.title` as the Save-as-PDF
 * name in both desktop browsers, and the Android bridge hands it over as the
 * print JOB name (ui/print.ts). It is one static string in index.html, so
 * every one of the nine print entry points used to arrive as
 * "Loxodrome.pdf", "Loxodrome (1).pdf", ... The stems come from the same
 * grammar the downloads use (files/fileName.ts, docs/file-names.md); the
 * browser appends the extension itself.
 */

import { tick } from 'svelte';
import type { SurfaceId } from '$lib/surfaces';
import { type PageOrientation, pageOrientation, printPage } from '$lib/ui/print';

/** The job under way: the surface it claims, or a document flow's mark
 *  (`document`), each until its afterprint. */
const job = $state<{ id: SurfaceId | null; document: boolean }>({ id: null, document: false });

/** Page setup per open surface, registered by SurfaceShell. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a callback registry, never rendered
const pageSetups = new Map<SurfaceId, () => string | null>();
/** What each open surface's print job is CALLED, registered alongside. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a callback registry, never rendered
const printNames = new Map<SurfaceId, () => string>();
/** What each open surface's printer does, for Ctrl/Cmd+P (ui/printKey.ts),
 *  registered alongside: null while the surface has no printer to press. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a callback registry, never rendered
const printers = new Map<SurfaceId, () => (() => void) | null>();
/** The app's own printer, for Ctrl/Cmd+P with no window open. */
let appPrinter: (() => (() => void) | null) | null = null;
/** The frontmost-first order the auto-claim picks from; see claimFrontmost. */
let frontmost: () => SurfaceId | null = () => null;

let installed: HTMLStyleElement | null = null;
/** The title to put back when the job ends; null while none is claimed. It
 *  is CAPTURED rather than assumed, because a document flow may already have
 *  set one and the page's own title is index.html's to state, not ours. */
let priorTitle: string | null = null;
let listening = false;

export function isPrintingSurface(id: SurfaceId): boolean {
	return job.id === id;
}

/** A print job is under way, from its claim or mark to its afterprint. On
 *  the web that is the dialog, during which nothing else runs. In the
 *  Android shell the plugin answers only when the JOB ends (ui/print.ts),
 *  which a printer working through it can put minutes after the dialog,
 *  with the app usable meanwhile, and that one afterprint tears down every
 *  flow's document, classes and @page: no print starts under it. */
export function printJobLive(): boolean {
	return job.id !== null || job.document;
}

/** Register a surface's default `@page` while it is open. The thunk is read
 *  at claim time, so a surface whose setup depends on its current page (the
 *  flight-prep pages differ) reports the live one. */
export function registerPageSetup(id: SurfaceId, pageCss: () => string | null): () => void {
	pageSetups.set(id, pageCss);
	return () => {
		if (pageSetups.get(id) === pageCss) {
			pageSetups.delete(id);
		}
	};
}

/** Register what a surface's print job is called, the registerPageSetup
 *  mirror: read at claim time, so a surface whose subject moves (the route
 *  the nav log shows) names the job it actually prints. Registering it here
 *  rather than at each print button is what gives the browser's own print,
 *  auto-claimed, a
 *  name for free. */
export function registerPrintName(id: SurfaceId, printName: () => string): () => void {
	printNames.set(id, printName);
	return () => {
		if (printNames.get(id) === printName) {
			printNames.delete(id);
		}
	};
}

/** Register what a surface's printer does while it is open, the
 *  registerPageSetup mirror: read at key time, so a printer that comes and
 *  goes with the surface's content (a profile with nothing to plot) answers
 *  as it stands. */
export function registerPrinter(id: SurfaceId, printer: () => (() => void) | null): () => void {
	printers.set(id, printer);
	return () => {
		if (printers.get(id) === printer) {
			printers.delete(id);
		}
	};
}

/** Register the app's own printer, the one Ctrl/Cmd+P presses with no
 *  window open: the toolbar's in Loxodrome, the bulletin in the viewer. */
export function registerAppPrinter(printer: () => (() => void) | null): () => void {
	appPrinter = printer;
	return () => {
		if (appPrinter === printer) {
			appPrinter = null;
		}
	};
}

/** The printer Ctrl/Cmd+P presses: the window's, or with none open the
 *  app's. A window with no printer never falls through to the app's. */
export function printerFor(id: SurfaceId | null): (() => void) | null {
	if (id !== null) {
		return printers.get(id)?.() ?? null;
	}
	return appPrinter?.() ?? null;
}

/** Name the job about to run. Idempotent within one job: the first call
 *  captures the title to restore. */
function setPrintTitle(stem: string): void {
	if (stem === '') {
		return;
	}
	priorTitle ??= document.title;
	document.title = stem;
}

function releasePrintTitle(): void {
	if (priorTitle !== null) {
		document.title = priorTitle;
		priorTitle = null;
	}
}

/** Tell the auto-claim which surface is in front: the workspace's overlay if
 *  it holds one, else the most recently opened dock. Wired once by App. */
export function setFrontmostSurface(fn: () => SurfaceId | null): void {
	frontmost = fn;
}

/** Install the surface's `@page` and report the sheet it asks for: Android
 *  takes the orientation as a print attribute rather than from the CSS, so
 *  the two must come from the same string (print.ts). */
function installPageSetup(id: SurfaceId): PageOrientation {
	const css = pageSetups.get(id)?.() ?? null;
	if (css === null) {
		return 'portrait';
	}
	const style = document.createElement('style');
	style.textContent = css;
	document.head.appendChild(style);
	installed = style;
	return pageOrientation(css);
}

function claim(id: SurfaceId): PageOrientation {
	job.id = id;
	document.documentElement.classList.add('surface-printing');
	setPrintTitle(printNames.get(id)?.() ?? '');
	return installPageSetup(id);
}

/** Claim the print job for one surface, then print, unless another job is
 *  live. The class has to land before the print snapshot, hence the tick. */
export async function printSurface(id: SurfaceId): Promise<void> {
	if (printJobLive()) {
		return;
	}
	const orientation = claim(id);
	await tick();
	window.addEventListener('afterprint', releasePrintJob, { once: true });
	printPage(orientation);
}

/** A flow is about to print a portaled document of its own: it owns the page
 *  setup and the box hiding, so the next print must not be auto-claimed. The
 *  name is REQUIRED, so a new document flow cannot silently inherit the
 *  page's own title the way all four of these once did; it is the discipline
 *  printPage's orientation parameter already imposes. */
export function markDocumentPrint(printName: string): void {
	job.document = true;
	setPrintTitle(printName);
	window.addEventListener(
		'afterprint',
		() => {
			job.document = false;
			releasePrintTitle();
		},
		{ once: true },
	);
}

export function releasePrintJob(): void {
	job.id = null;
	document.documentElement.classList.remove('surface-printing');
	releasePrintTitle();
	installed?.remove();
	installed = null;
}

/** The browser's own print (its menu, or a Ctrl+P the window in front has
 *  no printer for) claims nothing, so
 *  without this every open surface would flow onto the paper one after
 *  another. Claim the frontmost one, and release it once the job is over. */
export function listenForUserPrint(): () => void {
	if (listening) {
		return () => undefined;
	}
	listening = true;
	const onBefore = (): void => {
		if (printJobLive()) {
			return;
		}
		const id = frontmost();
		if (id === null) {
			return;
		}
		claim(id);
		window.addEventListener('afterprint', releasePrintJob, { once: true });
	};
	window.addEventListener('beforeprint', onBefore);
	return () => {
		window.removeEventListener('beforeprint', onBefore);
		listening = false;
	};
}
