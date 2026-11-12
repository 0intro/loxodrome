/* The flight plan as a DOCUMENT (docs/flights-library.md, "The plan-editing
 * loop"): saving it, opening another, naming it, downloading its file, and
 * the one question asked before unsaved work is replaced. Every door that
 * saves (the plan menu, the plan line, the Plans view's row, the Flights
 * header) and every one that replaces the plan on screen (Open, an opened
 * file, New, a flight opened with its plan) comes through here, so the plan
 * answers for itself the same way wherever it is asked.
 *
 * The plan menu and the questions are PlanHost's to show: this module holds
 * them as data and codes, resolves them, and imports no component. A
 * question asked while another stands takes its place, the one it replaced
 * answering Cancel. */

import { fileName } from '$lib/files/fileName';
import { planFileSubject, routeEndpointLabel } from '$lib/route/routeLabel';
import { downloadBlob } from '$lib/ui/dom';
import {
	activePlan,
	activePlanDirty,
	buildWorkspaceFileYaml,
	canStorePlan,
	hasStorableWorkspace,
	planUnsaved,
	renamePlan,
	storePlan,
	storePlanAs,
	type StoreOutcome,
} from './activePlan.svelte';
import { ensureLinks } from './flightLinks.svelte';
import { openFlights } from './flightsModal.svelte';
import { tripLegs } from './planRows';
import { routes, setPlanName } from './route.svelte';
import { loadEmptyPlan } from './routeLoad.svelte';
import { restoreInFlight } from './routePersist';

/** What PlanHost asks: `replace` before unsaved work goes (Save and
 *  continue, Discard, Cancel), `lossy` before a copy that lost waypoints is
 *  saved over its fuller original, `conflict` before an entry that changed
 *  since it was opened is overwritten. */
export type PlanQuestion = 'replace' | 'lossy' | 'conflict';

/** `confirm` is the dialog's own action (Discard, for `replace`), `alt` the
 *  second answer (Save and continue). */
export type PlanAnswer = 'confirm' | 'alt' | 'cancel';

export type SaveOutcome =
	| { kind: 'saved'; asNew: boolean }
	/** Nothing to write: the saved entry already holds this plan, or there
	 *  is no route worth saving. */
	| { kind: 'unchanged' }
	| { kind: 'cancelled' }
	/** The plan moved under the build, or another save held the store. */
	| { kind: 'aborted' }
	| { kind: 'failed'; detail: string };

/** A refusal the plan menu words: which action, and the raw upstream detail
 *  (docs/i18n.md rule 7). */
export interface PlanError {
	op: 'save' | 'download' | 'open';
	detail: string;
}

export const planDocument = $state<{
	question: PlanQuestion | null;
	/** A save is writing: its rows read busy. */
	saving: boolean;
	/** The download is building its file. */
	downloading: boolean;
	/** The receipt of the save just made, for about two seconds. */
	receipt: 'saved' | 'savedAs' | null;
	error: PlanError | null;
	/** The plan menu: a popup under its control on desktop, a sheet on
	 *  phones (HeadOverlay). */
	menuOpen: boolean;
	anchor: { x: number; y: number };
}>({
	question: null,
	saving: false,
	downloading: false,
	receipt: null,
	error: null,
	menuOpen: false,
	anchor: { x: 0, y: 0 },
});

/** How long a receipt stands. */
const RECEIPT_MS = 2000;

// Plain lets: nothing renders them (the openFile datumResolve idiom).
let answer: ((a: PlanAnswer) => void) | null = null;
let receiptTimer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<SaveOutcome> | null = null;
let renaming: Promise<void> | null = null;
let replaceSerial = 0;
let picker: (() => void) | null = null;
let anchorOf: (() => { x: number; y: number }) | null = null;

function ask(q: PlanQuestion): Promise<PlanAnswer> {
	answer?.('cancel');
	planDocument.question = q;
	return new Promise((resolve) => {
		answer = resolve;
	});
}

/** PlanHost's buttons, Escape and the backdrop answer here. */
export function answerPlanQuestion(a: PlanAnswer): void {
	const resolve = answer;
	answer = null;
	planDocument.question = null;
	resolve?.(a);
}

/** The plan's route as the Plans row prints it, its trips alone
 *  ("LFPN → LFOZ / LFOZ → LFPN"), '' for a plan with no route. */
export function planChain(): string {
	const chain = routes.list
		.map((r) => ({ label: routeEndpointLabel(r, ''), alternate: r.alternate === true }))
		.filter((c) => c.label !== '');
	return tripLegs(chain)
		.map((c) => c.label)
		.join(' / ');
}

/** The plan's identity: its name, else its route. */
export function planIdentity(): string {
	return routes.planName ?? planChain();
}

/** Where the plan on screen stands, a code worded at render: no route to
 *  save, never saved, saved with edits, saved from a copy that lost
 *  waypoints, saved as it stands. */
export type PlanState = 'empty' | 'new' | 'dirty' | 'lossy' | 'saved';

export function planState(): PlanState {
	const src = activePlan.source;
	if (src == null) {
		return hasStorableWorkspace() ? 'new' : 'empty';
	}
	if (activePlanDirty()) {
		return 'dirty';
	}
	return src.lossy ? 'lossy' : 'saved';
}

/** Open the plan menu, anchored under the control that asked. */
export function openPlanMenu(anchor: { x: number; y: number }): void {
	planDocument.anchor = anchor;
	planDocument.menuOpen = true;
}

export function closePlanMenu(): void {
	planDocument.menuOpen = false;
}

function showReceipt(r: 'saved' | 'savedAs'): void {
	if (receiptTimer != null) {
		clearTimeout(receiptTimer);
	}
	planDocument.receipt = r;
	receiptTimer = setTimeout(() => {
		receiptTimer = null;
		planDocument.receipt = null;
	}, RECEIPT_MS);
}

async function store(run: () => Promise<StoreOutcome>): Promise<StoreOutcome> {
	planDocument.saving = true;
	try {
		return await run();
	} finally {
		planDocument.saving = false;
	}
}

async function runSave(asNew: boolean): Promise<SaveOutcome> {
	// A rename in flight holds the catalog's store guard: let it land first.
	await renaming;
	planDocument.error = null;
	// The entry a save writes back over; none for a fork or a plan never
	// saved, which become a new entry.
	const back = asNew ? null : activePlan.source;
	const fork = back == null;
	if (fork ? !hasStorableWorkspace() : !canStorePlan()) {
		return { kind: 'unchanged' };
	}
	if (back?.lossy && (await ask('lossy')) !== 'confirm') {
		return { kind: 'cancelled' };
	}
	let out = await store(fork ? storePlanAs : () => storePlan());
	if (out.kind === 'conflict') {
		if ((await ask('conflict')) !== 'confirm') {
			return { kind: 'cancelled' };
		}
		out = await store(() => storePlan({ force: true }));
	}
	switch (out.kind) {
		case 'stored':
			// The catalog changed: every trace's dynamic link recomputes.
			void ensureLinks();
			showReceipt(fork ? 'savedAs' : 'saved');
			return { kind: 'saved', asNew: fork };
		case 'failed':
			planDocument.error = { op: 'save', detail: out.detail };
			return out;
		case 'aborted':
			return out;
		case 'conflict':
			// A forced store answers no conflict.
			// i18n-ignore: a broken invariant's diagnostic, never shown
			throw new Error('planDocument: conflict after a forced store');
		default: {
			const never: never = out;
			return never;
		}
	}
}

function join(run: () => Promise<SaveOutcome>): Promise<SaveOutcome> {
	running ??= run().finally(() => {
		running = null;
	});
	return running;
}

/** Save the plan on screen: over the entry it was opened from, or as a new
 *  entry when it was never saved. A save already running is joined. */
export function savePlan(): Promise<SaveOutcome> {
	return join(() => runSave(false));
}

/** PlanHost registers where the menu opens when no click placed it: under
 *  the chip, or over the phone's page. */
export function setPlanMenuAnchor(find: (() => { x: number; y: number }) | null): void {
	anchorOf = find;
}

/** Save, answering where no menu row was clicked (Ctrl+S, the palette): a
 *  plan its entry already holds reads saved, as an editor's Save answers,
 *  and a failure opens the menu on its error line. */
export async function saveAndAnswer(): Promise<void> {
	const out = await savePlan();
	if (out.kind === 'unchanged' && activePlan.source != null) {
		showReceipt('saved');
	} else if (out.kind === 'failed') {
		openPlanMenu(anchorOf?.() ?? { x: 12, y: 56 });
	}
}

/** Save the plan on screen as a new entry, whatever it was opened from. */
export function savePlanAsNew(): Promise<SaveOutcome> {
	return join(() => runSave(true));
}

/** Name the plan on screen (null hands it back to its route). A saved plan's
 *  name lives in its stored file, so the row is written with the workspace
 *  (renamePlan, the naming doctrine); a plan never saved keeps it in the
 *  workspace until its first save. The rename and the save share the
 *  catalog's store guard, so each waits for the other ALREADY in flight
 *  when it is asked, never for one asked after it, which would wait back. */
export function renameActivePlan(name: string | null): Promise<void> {
	const priorRename = renaming;
	const priorSave = running;
	const run = async (): Promise<void> => {
		await priorRename;
		await priorSave?.catch(() => undefined);
		const src = activePlan.source;
		if (src == null) {
			setPlanName(name);
			return;
		}
		const out = await renamePlan(src.id, name);
		if (out.kind === 'failed') {
			planDocument.error = { op: 'save', detail: out.detail };
		}
	};
	const p = run().finally(() => {
		if (renaming === p) {
			renaming = null;
		}
	});
	renaming = p;
	return p;
}

/** Download the whole plan as its YAML file, named after the plan
 *  (docs/file-names.md). The rich build alone: the file is read outside
 *  this application, nav-log snapshot included. */
export async function downloadPlanFile(): Promise<boolean> {
	if (planDocument.downloading) {
		return false;
	}
	planDocument.downloading = true;
	planDocument.error = null;
	try {
		downloadBlob(
			await buildWorkspaceFileYaml(),
			fileName([planFileSubject(routes.planName, routes.list), 'plan'], 'yaml'),
			'text/yaml',
		);
		return true;
	} catch (err) {
		planDocument.error = { op: 'download', detail: err instanceof Error ? err.message : String(err) };
		return false;
	} finally {
		planDocument.downloading = false;
	}
}

/** The saved plans, in the Flights library (a menu row opens, never toggles). */
export function openSavedPlan(): void {
	planDocument.menuOpen = false;
	openFlights('plans');
}

/** PlanHost registers the file picker: the web input, or the Android one. */
export function setPlanFilePicker(open: (() => void) | null): void {
	picker = open;
}

/** Pick a plan file. Called inside the click, which the web picker needs. */
export function pickPlanFile(): void {
	planDocument.menuOpen = false;
	planDocument.error = null;
	picker?.();
}

/** A picked file that could not be read: the menu reopens on its line. */
export function planFileReadFailed(detail: string): void {
	planDocument.error = { op: 'open', detail };
	planDocument.menuOpen = true;
}

/** Replace the plan on screen with `apply`, asking first when it holds
 *  unsaved work. A boot restore in flight lands first, so the question is
 *  about the plan it brings back (routePersist restoreInFlight). Save and
 *  continue saves, then applies only on success and while no newer request
 *  has come. True when `apply` ran. */
export async function replacePlan(apply: () => unknown): Promise<boolean> {
	// Awaited only while the restore runs. Otherwise the question opens in
	// the tick of the gesture, where a menu closing beside it hands its
	// history entry over to the dialog (ui/backClose).
	const restore = restoreInFlight();
	if (restore) {
		await restore;
	}
	if (!planUnsaved()) {
		await apply();
		return true;
	}
	const serial = ++replaceSerial;
	const a = await ask('replace');
	if (serial !== replaceSerial || a === 'cancel') {
		return false;
	}
	if (a === 'alt') {
		const out = await savePlan();
		if (serial !== replaceSerial || (out.kind !== 'saved' && out.kind !== 'unchanged')) {
			return false;
		}
	}
	await apply();
	return true;
}

/** Start a new flight plan (routeLoad.loadEmptyPlan), asking first. */
export function newPlan(): Promise<boolean> {
	return replacePlan(loadEmptyPlan);
}
