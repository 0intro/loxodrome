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
 * Every programmatic print claims. That is what lets `beforeprint` tell a
 * user-initiated Ctrl+P from a flow's own `window.print()` and auto-claim
 * only for the former; the flows that print a portaled document of their own
 * (kneeboard, flight dossier, weather briefing, NOTAM bulletin) mark
 * themselves instead, since their box-hiding and page setup are already
 * their own.
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

const job = $state<{ id: SurfaceId | null }>({ id: null });

/** Page setup per open surface, registered by SurfaceShell. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a callback registry, never rendered
const pageSetups = new Map<SurfaceId, () => string | null>();
/** What each open surface's print job is CALLED, registered alongside. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a callback registry, never rendered
const printNames = new Map<SurfaceId, () => string>();
/** The frontmost-first order the auto-claim picks from; see claimFrontmost. */
let frontmost: () => SurfaceId | null = () => null;

let installed: HTMLStyleElement | null = null;
/** The title to put back when the job ends; null while none is claimed. It
 *  is CAPTURED rather than assumed, because a document flow may already have
 *  set one and the page's own title is index.html's to state, not ours. */
let priorTitle: string | null = null;
/** Set by a flow that is about to print a document of its own. */
let programmatic = false;
let listening = false;

export function isPrintingSurface(id: SurfaceId): boolean {
	return job.id === id;
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
 *  rather than at each print button is what gives the Ctrl+P auto-claim a
 *  name for free. */
export function registerPrintName(id: SurfaceId, printName: () => string): () => void {
	printNames.set(id, printName);
	return () => {
		if (printNames.get(id) === printName) {
			printNames.delete(id);
		}
	};
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

/** Claim the print job for one surface, then print. The class has to land
 *  before the print snapshot, hence the tick. */
export async function printSurface(id: SurfaceId): Promise<void> {
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
	programmatic = true;
	setPrintTitle(printName);
	window.addEventListener(
		'afterprint',
		() => {
			programmatic = false;
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

/** A user-initiated print (Ctrl+P, the browser menu) claims nothing, so
 *  without this every open surface would flow onto the paper one after
 *  another. Claim the frontmost one, and release it once the job is over. */
export function listenForUserPrint(): () => void {
	if (listening) {
		return () => undefined;
	}
	listening = true;
	const onBefore = (): void => {
		if (job.id !== null || programmatic) {
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
