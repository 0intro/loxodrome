<script lang="ts">
	/* The Flight Plan Catalog view (the Garmin model,
	 * docs/flights-library.md "The plan-editing loop"): the remembered
	 * route files as a table, each row derived as the MATCHER reads the
	 * file against current data, the ForeFlight validate-saved-routes
	 * posture. Activate copies a plan into the route workspace (the
	 * active flight plan; the stored copy stays intact), the source row
	 * wears the active marker and, when the workspace has unstored
	 * edits, the store-back button; download hands the file back, delete
	 * forgets it; filed flights keep their own frozen copies either
	 * way. */
	import Icon from '../Icon.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import {
		activePlan,
		activePlanDirty,
		canStorePlan,
		detachFromPlan,
		renamePlan,
		setActivePlanSource,
		storePlan,
	} from '$lib/state/activePlan.svelte';
	import { clearAllRoutes } from '$lib/state/route.svelte';
	import { planCatalog, removeStoredPlan } from '$lib/state/planCatalog.svelte';
	import type { ChainLeg, PlanRowState } from '$lib/state/planRows';
	import { ensureLinks, flightLinks } from '$lib/state/flightLinks.svelte';
	import { isoDateUtc } from '$lib/nav/logbook';
	import { fmtClockUtc } from '$lib/route/format';
	import { loadRoutesFromYaml, routeLoad } from '$lib/state/routeLoad.svelte';
	import { fitRoute } from '../tabs/route/fitRoute';
	import { downloadBlob } from '$lib/ui/dom';
	import { fileName } from '$lib/files/fileName';
	import { usePlanPreview } from '../mapPreview.svelte';

	interface Props {
		/** The surface's cockpit-confirm helper (the ask idiom). */
		ask: (message: string, label: string, run: () => void) => void;
	}

	let { ask }: Props = $props();

	// Hovering a row ghosts the plan on the map (mapPreview doctrine:
	// desktop, dock-right only; this view unmounts on the view switch, so
	// its effect teardown covers the modal's permanence).
	const planPreview = usePlanPreview();

	// The per-plan flight counts from the DYNAMIC links: how many trace
	// outings currently match this entry (recomputed on every catalog
	// change; no frozen association).
	const counts = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived local
		const out = new Map<string, number>();
		for (const link of Object.values(flightLinks.byOuting)) {
			if (link.planId != null) {
				out.set(link.planId, (out.get(link.planId) ?? 0) + 1);
			}
		}
		return out;
	});
	// The active flight plan's row + its unstored-edits state (tracked:
	// both read the workspace deep through the provenance module).
	const sourceId = $derived(activePlan.source?.id ?? null);
	const dirty = $derived(activePlanDirty());
	// Two questions, deliberately not one: the row's amber bar answers "did I
	// edit this?", the store-back button "would storing change the entry?".
	// They part on a LOSSY activation, where the copy already differs from the
	// fuller original with no edit of its own (state/activePlan.canStorePlan).
	const canStore = $derived(canStorePlan());

	/* The load / store failure, raw upstream detail (worded at render). */
	let loadError = $state<string | null>(null);
	let storingRow = $state(false);

	async function activate(r: { id: string; yaml: string; savedAtMs: number }): Promise<void> {
		// Activation carries the row's identity: the workspace becomes this
		// catalog entry's working copy (the provenance, activePlan.svelte.ts).
		if (await loadRoutesFromYaml(r.yaml, { id: r.id, savedAtMs: r.savedAtMs })) {
			loadError = null;
			fitRoute();
		} else {
			loadError = routeLoad.error;
		}
	}

	/** Clear the active flight plan back out of the workspace (the
	 *  Activate button's TOGGLE face on the active row): the stored entry
	 *  is untouched, the workspace empties, the provenance detaches. One
	 *  undo step stands (clearAllRoutes records it). */
	function deactivate(): void {
		clearAllRoutes();
		setActivePlanSource(null);
	}

	/** The Garmin device replaces flight plan 00 silently; here unstored
	 *  edits ask first (the ConfirmDialog doctrine). On the ACTIVE row the
	 *  same button toggles the plan back OUT of the workspace. */
	function onActivate(r: { id: string; yaml: string; savedAtMs: number }): void {
		if (r.id === sourceId) {
			if (dirty) {
				ask(t.flights.deactivateDirtyConfirm, t.flights.deactivateAction, deactivate);
				return;
			}
			deactivate();
			return;
		}
		if (dirty && sourceId != null) {
			ask(t.flights.activateOverDirtyConfirm, t.flights.activateAction, () => void activate(r));
			return;
		}
		void activate(r);
	}

	/** The source row's store-back (the RouteTab menu's action, reachable
	 *  where the switching happens). Conflict / lossy pass through the
	 *  same ask helper; failures land on the view's error line. */
	function onStoreRow(): void {
		const src = activePlan.source;
		if (src == null) {
			return;
		}
		if (src.lossy) {
			ask(t.route.storeLossyConfirm, t.route.storeLossyAction, () => void runStore(false));
			return;
		}
		void runStore(false);
	}

	async function runStore(force: boolean): Promise<void> {
		storingRow = true;
		try {
			const out = await storePlan({ force });
			if (out.kind === 'conflict') {
				ask(t.route.storeConflictConfirm, t.route.storeConflictAction, () =>
					void runStore(true),
				);
			} else if (out.kind === 'failed') {
				loadError = out.detail;
			} else if (out.kind === 'stored') {
				loadError = null;
				void ensureLinks();
			}
		} finally {
			storingRow = false;
		}
	}

	/** The file name is GENERATED (planRows.baseName): the plan's own name
	 *  when it has one, else its route. A row that resolves neither loses the
	 *  subject field and is a bare "plan.yaml". */
	function onDownload(r: { yaml: string; baseName: string }): void {
		downloadBlob(r.yaml, fileName([r.baseName, 'plan'], 'yaml'), 'text/yaml');
	}

	/* The row being renamed, one at a time (the route sub-tab's idiom, down to
	 * Enter committing, Escape discarding and blur committing). */
	let editingId = $state<string | null>(null);
	/* Discarding has to SAY so: Escape closes the editor by removing the input,
	 * and Chromium fires `blur` on a focused element it removes (Firefox does
	 * not), so the blur commit would otherwise write the abandoned text into
	 * the catalog. A plain let, the transient-guard idiom: nothing renders it. */
	let cancelled = false;

	function autofocus(node: HTMLInputElement): void {
		node.focus();
		node.select();
	}

	function startRename(id: string): void {
		cancelled = false;
		editingId = id;
	}

	function cancelRename(): void {
		cancelled = true;
		editingId = null;
	}

	/** Blank hands the plan back to its derived chain. The write is the
	 *  catalog's (renamePlan): the stored file is where a plan's name lives. */
	function commitRename(id: string, value: string): void {
		editingId = null;
		if (cancelled) {
			return;
		}
		void renamePlan(id, value).then((out) => {
			if (out.kind === 'failed') {
				loadError = out.detail;
			}
		});
	}

	/* Typed readers: the template's own narrowing does not survive the
	 * discriminated union across nested blocks. */
	function chainText(state: PlanRowState): string {
		return state.kind === 'ok' ? state.chain.map((c) => c.label).join(' / ') : '';
	}

	/** The chain as the cell PRINTS it: the trips alone. An alternate is a
	 *  diversion of the trip before it, so a six-route file spent most of a
	 *  clipped cell on routes the day did not fly and buried the three legs
	 *  it did. The tooltip below still carries every route, alternates
	 *  included, so the fact is demoted rather than lost.
	 *
	 *  The same rule already names the plan's files (routesFileBaseName
	 *  chains the TRIPS' aerodromes and skips alternates, docs/file-names.md).
	 *
	 *  A file that is somehow all alternates would print nothing, so it falls
	 *  back to the whole chain: an empty cell reads as a broken row. */
	function chainLegs(state: PlanRowState): ChainLeg[] {
		if (state.kind !== 'ok') {
			return [];
		}
		const trips = state.chain.filter((c) => !c.alternate);
		return trips.length > 0 ? trips : state.chain;
	}

	/** The tooltip: the full chain (the cell may clip it). */
	function rowTitle(state: PlanRowState): string {
		return chainText(state);
	}

	function droppedText(state: PlanRowState): string {
		return state.kind !== 'error' && state.dropped.length > 0 ? state.dropped.join(', ') : '';
	}

	function errorDetail(state: PlanRowState): string {
		return state.kind === 'error' ? state.detail : '';
	}

	function onDelete(id: string): void {
		ask(t.flights.plansDeleteConfirm, t.flights.deleteConfirmAction, () => {
			// The workspace releases the entry it is about to lose: a
			// provenance pointing at a deleted id makes Store recreate it.
			detachFromPlan(id);
			void removeStoredPlan(id).then(() => ensureLinks());
		});
	}
</script>

{#if loadError != null}
	<p class="load-error no-print" role="alert">
		{t.flights.plansLoadFailed(loadError)}
		<button class="icon-btn" aria-label={t.common.close} onclick={() => (loadError = null)}>
			<Icon name="x" size={12} />
		</button>
	</p>
{/if}
{#if planCatalog.rows.length === 0}
	<p class="muted">{planCatalog.loading ? t.flights.plansLoading : t.flights.plansEmpty}</p>
{:else}
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th scope="col" title={t.flights.colPlanTip}>{t.flights.colPlan}</th>
					<th scope="col" class="num">{t.flights.colPlanSaved}</th>
					<th scope="col" class="num" title={t.flights.colPlanUsedTip}
						>{t.flights.colPlanUsed}</th
					>
					<th class="no-print"></th>
				</tr>
			</thead>
			<tbody>
				{#each planCatalog.rows as r (r.id)}
					<tr
						data-plan-id={r.id}
						aria-current={r.id === sourceId ? 'true' : undefined}
						class:active={r.id === sourceId}
						class:dirty={r.id === sourceId && dirty}
						onmouseenter={() => planPreview.set({ id: r.id, yaml: r.yaml })}
						onmouseleave={() => planPreview.set(null)}
					>
						<!-- The plan's own NAME over the route the matcher reads today.
						     The caption never replaces the fact: it is the one stored,
						     unverifiable field on a row that derives everything else,
						     and it is what tells same-chain variants (via MLN vs via B)
						     apart, the store key being opaque. -->
						<td class="routes" title={rowTitle(r.state) || undefined}>
							{#if editingId === r.id}
								<input
									class="plan-rename"
									type="text"
									autocapitalize="sentences"
									spellcheck="false"
									value={r.name ?? ''}
									placeholder={t.flights.planNameLabel}
									aria-label={t.flights.planNameLabel}
									use:autofocus
									onkeydown={(e) => {
										if (e.key === 'Enter') {
											commitRename(r.id, e.currentTarget.value);
										} else if (e.key === 'Escape') {
											// The surface's own Escape closes it; a cancelled
											// rename must not take the catalog with it.
											e.stopPropagation();
											cancelRename();
										}
									}}
									onblur={(e) => commitRename(r.id, e.currentTarget.value)}
								/>
							{:else if r.name !== null}
								<button
									class="plan-name"
									title={`${r.name}\n${t.flights.planRename}`}
									ondblclick={() => startRename(r.id)}>{r.name}</button
								>
							{/if}
							<div class="plan-chain">
								{#if r.state.kind === 'error'}
									<span class="pl-bad">{t.flights.planParseFailed(errorDetail(r.state))}</span>
								{:else}
									{#if r.state.kind === 'empty'}
										<span class="pl-bad">{t.flights.planNoRoutes}</span>
									{:else}
										<!-- The TRIPS only (chainLegs): what the day flew. The
										     alternates ride the cell's title. -->
										{#each chainLegs(r.state) as leg, i (i)}{#if i > 0}<span
												class="chain-sep">/</span
											>{/if}{leg.label}{/each}
									{/if}
									{#if droppedText(r.state) !== ''}
										<span class="pl-warn">{t.flights.planDropped(droppedText(r.state))}</span>
									{/if}
								{/if}
							</div>
						</td>
						<td class="num saved">
							<div>{isoDateUtc(r.savedAtMs)}</div>
							<!-- Same-day stores are the norm under the editing loop:
							     the time is what answers "did my store land?". -->
							<div class="saved-clock">{fmtClockUtc(r.savedAtMs)}Z</div>
						</td>
						<td class="num">{counts.get(r.id) ?? 0}</td>
						<td class="actions no-print">
							<!-- The store-back call to action, on the ACTIVE row while
							     storing would change the entry (a row that matches its
							     workspace is carried by the highlight alone). It is
							     FIRST in a flex-end strip on purpose: the group grows
							     leftwards, so the buttons behind it never move when a
							     row turns dirty. It used to reserve a column of its
							     own on the left for that, which cost 52px of empty
							     gutter down the whole table on every row and in every
							     state but this one. -->
							{#if r.id === sourceId && canStore}
								<button
									class="icon-btn warn"
									title={dirty ? t.flights.planActiveDirtyTip : t.flights.planActiveLossyTip}
									aria-label={t.flights.planStoreRow}
									disabled={storingRow}
									onclick={onStoreRow}
								>
									<Icon name="save" size={13} />
								</button>
							{/if}
							<!-- The same toggle idiom as the flights rows' replay
							     button, and it needs the same pressed state: the
							     label swaps, but nothing else said the plan in this
							     row is the one in the workspace. -->
							<button
								class="icon-btn"
								class:on={r.id === sourceId}
								title={r.id === sourceId ? t.flights.planDeactivateTip : t.flights.planActivateTip}
								aria-label={r.id === sourceId ? t.flights.planDeactivate : t.flights.planActivate}
								aria-pressed={r.id === sourceId}
								onclick={() => onActivate(r)}
							>
								<Icon name="route" size={13} />
							</button>
							<!-- A plan is named HERE, where names are read; a row whose
							     yaml will not parse has no name to write into. -->
							<button
								class="icon-btn"
								title={t.flights.planRename}
								aria-label={t.flights.planRename}
								disabled={r.state.kind === 'error'}
								onclick={() => startRename(r.id)}
							>
								<Icon name="edit-2" size={13} />
							</button>
							<button
								class="icon-btn"
								title={t.flights.plansDownload}
								aria-label={t.flights.plansDownload}
								onclick={() => onDownload(r)}
							>
								<Icon name="upload" size={13} />
							</button>
							<button
								class="icon-btn"
								title={t.flights.plansDelete}
								aria-label={t.flights.plansDelete}
								onclick={() => onDelete(r.id)}
							>
								<Icon name="trash" size={13} />
							</button>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<style>
	.muted {
		font-size: 13px;
		color: var(--text-muted);
	}

	.load-error {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0 0 10px;
		font-size: 12px;
		color: var(--danger);
	}

	.table-wrap {
		overflow-x: auto;
	}

	table {
		width: 100%;
		min-width: 640px;
		border-collapse: collapse;
		font-size: 12px;
	}

	th {
		padding: 4px 8px;
		font-size: 11px;
		font-weight: 600;
		color: var(--text-muted);
		text-align: left;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}

	td {
		padding: 5px 8px;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
		white-space: nowrap;
	}

	/* The row under the pointer highlights (the AirportsTab row idiom),
	   pairing with the map's hover-preview line. */
	tbody tr:hover {
		background: var(--surface-2);
	}

	th.num,
	td.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	td.routes {
		max-width: 520px;
	}

	/* Name over chain, each clipping on its own line (the Stored cell's
	   date-over-clock rhythm); the cell keeps the table's `nowrap`. */
	.plan-name,
	.plan-chain {
		display: block;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* The separator is its own element rather than a text node: the spaces
	   around it would otherwise ride on Svelte's whitespace handling. */
	.plan-chain .chain-sep {
		margin: 0 0.3em;
	}

	.plan-name {
		padding: 0;
		font: inherit;
		font-weight: 600;
		color: var(--text);
		text-align: left;
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.plan-rename {
		width: 100%;
		min-width: 0;
		padding: 3px 6px;
		font: inherit;
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--accent);
		border-radius: 4px;
	}

	/* The accent border IS the focus signal, as on the route sub-tab rename:
	   the field only exists while it holds focus. */
	.plan-rename:focus-visible {
		outline: none;
	}

	td.saved {
		line-height: 1.25;
	}

	.saved-clock {
		font-size: var(--fs-2xs);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.pl-bad {
		color: var(--danger);
	}

	.pl-warn {
		color: var(--workbook-orange);
	}

	.actions {
		display: flex;
		gap: 2px;
		align-items: center;
		justify-content: flex-end;
	}

	/* The plan catalog's actions stay put while its 640px table pans, the
	   outings table's rule and for the same measured reason. Screen only. */
	@media screen {
		thead th:last-child,
		td.actions {
			position: sticky;
			right: 0;
			z-index: 1;
			background: var(--surface);
		}

		tbody tr:hover td.actions,
		tbody tr.active td.actions {
			background: var(--surface-2);
		}
	}

	/* The ACTIVE flight plan's row: the permanent selected-row highlight
	   (the AirportsTab .row.active idiom), its left bar amber while the
	   workspace holds unstored edits. */
	tbody tr.active {
		background: var(--surface-2);
	}

	tbody tr.active td:first-child {
		box-shadow: inset 3px 0 0 var(--accent);
	}

	tbody tr.active.dirty td:first-child {
		box-shadow: inset 3px 0 0 var(--workbook-orange);
	}

	.actions .icon-btn.warn {
		color: var(--workbook-orange);
	}

	:global(:root.touch-ui) .actions .icon-btn {
		width: 44px;
		height: 44px;
	}
</style>
