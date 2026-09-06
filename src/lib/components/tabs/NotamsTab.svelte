<script lang="ts" module>
	/* Which view the tab shows. Module-scoped so it survives the unmount a
	 * tab switch causes; session-only, nothing persisted. */
	const wantFetch = $state({ on: false });
</script>

<script lang="ts">
	/* The NOTAMs tab, two views over one panel: the parsed-NOTAM list with
	 * the funnel Filters popover and active-filter chips, and the fetch
	 * view (NotamLoader, three flat sections) shown whenever no briefing is
	 * loaded or the head's load button asks for it. The fetch view fills
	 * the panel rather than a popover: three sections of controls need the
	 * height, on a phone most of all. */
	import Icon from '../Icon.svelte';
	import FiltersPopover from '../FiltersPopover.svelte';
	import NotamLoader from '../NotamLoader.svelte';
	import { notamState, outOfWindowNotams, visibleNotams } from '$lib/state/notam.svelte';
	import { orderedNotamOwnerSections } from '$lib/state/notamOrder.svelte';
	import { requestNotamPrint } from '$lib/state/notamPrint.svelte';
	import { decodeQ, t } from '$lib/state/i18n.svelte';
	import { ui, selectNotam } from '$lib/state/ui.svelte';
	import { mapState } from '$lib/state/map.svelte';
	import { focusNotam } from '$lib/map/notamLayer';
	import { airportByIdent } from '$lib/state/data.svelte';
	import type { NotamOwner } from '$lib/notam/ownership';
	import type { Notam } from '$lib/notam/types';
	import {
		filter,
		activeFilterChips,
		clearFilterDimension,
		clearRestrictingFilters,
		setSearchQuery,
		type FilterChip,
	} from '$lib/state/filter.svelte';
	import { routeDrivesTrafficMode } from '$lib/state/route.svelte';

	// The single canonical SOFIA-Briefing PIB order, sectioned by OWNER
	// (aerodrome in route order, then en-route / FIR, then other), shared with
	// the detail-panel stepper and the print bulletin so all three agree.
	const sections = $derived(orderedNotamOwnerSections());
	/* Kept by every data filter but outside the period: DEMOTED, not dropped,
	 * so a briefing read after the fact still reads as a briefing and a lapsed
	 * NOTAM stays one tap from its panel. The map draws the period only. */
	const outside = $derived(outOfWindowNotams());
	let outsideOpen = $state(false);

	const total = $derived(notamState.notams.length);
	const gaps = $derived(notamState.gaps);
	const shown = $derived(visibleNotams().length);
	const chips = $derived(activeFilterChips());
	const rulesFromRoute = $derived(routeDrivesTrafficMode());

	// Head-overlay state: which overlay is up and where it anchors (the
	// invoking button's rect; ignored by the phone sheet).
	let filtersOpen = $state(false);
	let anchor = $state({ x: 0, y: 0 });

	// No briefing = nothing to list, so the fetch view IS the empty state.
	const showFetch = $derived(notamState.notams.length === 0 || wantFetch.on);

	function anchorTo(e: MouseEvent): void {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		anchor = { x: r.left, y: r.bottom + 4 };
	}

	function openFilters(e: MouseEvent): void {
		anchorTo(e);
		filtersOpen = true;
	}

	function openFetch(): void {
		wantFetch.on = true;
	}

	function showList(): void {
		wantFetch.on = false;
	}

	// Localized heading for a NOTAM's owner block: the aerodrome ident (with its
	// name when known), "FIR <ident>", Checklists, or Other. Read at call time
	// inside the template so a locale change re-labels.
	function sectionLabel(owner: NotamOwner): string {
		if (owner.kind === 'aerodrome') {
			const ident = owner.ident.toUpperCase();
			const name = airportByIdent(ident)?.name;
			return name ? `${ident} ${name}` : ident;
		}
		if (owner.kind === 'fir') {
			const id = [...owner.firs].map((f) => f.toUpperCase()).sort()[0] ?? '';
			return `FIR ${id}`;
		}
		if (owner.kind === 'checklist') {
			return t.detail.checklists;
		}
		return t.notam.firGroups.other;
	}

	function onSelect(index: number): void {
		selectNotam(index, true);
		const notam = notamState.notams[index];
		if (mapState.map && notam) {
			focusNotam(mapState.map, notam);
		}
	}

	function descriptor(notam: Notam): string {
		const decoded = decodeQ(notam.qCode);
		if (decoded) {
			return decoded;
		}
		return notam.isPolygon ? t.notam.kindArea : t.notam.kindPosition;
	}

	function dotClass(notam: Notam): string {
		if (notam.isPolygon) {
			return 'area';
		}
		return notam.coordinates[0]?.type === 'qualifierLine' ? 'qline' : 'psn';
	}

	function chipLabel(chip: FilterChip): string {
		switch (chip.id) {
			case 'rules':
				return filter.trafficMode === 'vfr' ? 'VFR' : 'IFR';
			case 'kind':
				return `${t.filter.kindLegend} ${chip.on}/${chip.total}`;
		}
	}

	/** The dimension's translated name, for the chip x button's label. */
	function chipName(chip: FilterChip): string {
		switch (chip.id) {
			case 'rules':
				return t.filter.flightRulesLegend;
			case 'kind':
				return t.filter.kindLegend;
		}
	}
</script>

<div class="tab-panel">
	<div class="tab-head">
		{#if showFetch}
			{#if total > 0}
				<!-- Back to the list the briefing is already in (the detail
				     panel's back-arrow idiom). -->
				<button
					class="icon-btn head-icon"
					onclick={showList}
					title={t.input.backToList}
					aria-label={t.input.backToList}
				>
					<Icon name="chevron-left" size={16} />
				</button>
			{/if}
			<h2>{t.input.load}</h2>
		{:else}
			<h2>{t.notam.listTitle}</h2>
			<!-- The head has two states, so it is one branch: the fetch view's
			     title and its way back, or the list's title and its actions. -->
			<!-- A briefing fetched route by route can land short of a corridor.
			     The fetch view states which and why; from the list, this says
			     the list is not the whole picture and leads back there. -->
			{#if gaps}
				<button
					class="gap-chip"
					onclick={openFetch}
					title={t.notam.gapChipTip}
					aria-label={t.notam.gapChipTip}
				>
					<Icon name="alert-triangle" size={13} />
					{t.notam.routesNotCovered({ missing: gaps.routes.length, total: gaps.total })}
				</button>
			{/if}
			<button
				class="btn"
				onclick={requestNotamPrint}
				disabled={sections.length === 0}
				title={t.notam.pib.printTip}
			>
				<Icon name="printer" size={13} />
				{t.notam.pib.print}
			</button>
			<!-- The funnel holds what is NOTAM-only: the flight rules and the
			     geometry kinds. The period and the level band govern the whole
			     map, briefing or no briefing, so they are toolbar chrome
			     (ViewConditions) and stay reachable from the fetch view too. -->
			<button
				class="icon-btn head-icon"
				onclick={openFilters}
				aria-expanded={filtersOpen}
				title={t.filter.open}
				aria-label={t.filter.open}
			>
				<Icon name="filter" size={15} />
			</button>
			<button
				class="icon-btn head-icon"
				onclick={openFetch}
				title={t.input.load}
				aria-label={t.input.load}
			>
				<Icon name="download" size={15} />
			</button>
		{/if}
	</div>

	{#if showFetch}
		{#if total === 0 && notamState.parsedAt > 0 && notamState.rawText.trim().length > 0}
			<p class="muted">{t.notam.emptyNoPosition}</p>
		{/if}
		<NotamLoader onLoaded={showList} onGaps={openFetch} />
	{:else}
		<input
			class="search"
			type="search"
			autocapitalize="none"
			autocomplete="off"
			spellcheck="false"
			enterkeyhint="search"
			placeholder={t.notam.searchPlaceholder}
			value={filter.queryDraft}
			oninput={(e) => setSearchQuery(e.currentTarget.value)}
		/>

		<div class="list-meta">
			<p class="muted count">{t.filter.showing({ shown, total })}</p>
			{#if chips.length > 0}
				<div class="chips">
					{#each chips as chip (chip.id)}
						<span class="chip">
							<button
								class="chip-body"
								onclick={openFilters}
								title={chip.id === 'rules' && rulesFromRoute
									? t.filter.setByRoute
									: t.filter.chipEditTip}
							>
								{#if chip.id === 'rules' && rulesFromRoute}
									<span class="chip-prov"><Icon name="route" size={11} /></span>
								{/if}
								{chipLabel(chip)}
							</button>
							<button
								class="chip-x"
								onclick={() => clearFilterDimension(chip.id)}
								aria-label={t.filter.chipClearAria(chipName(chip))}
								title={t.filter.chipClearAria(chipName(chip))}
							>
								<Icon name="x" size={11} />
							</button>
						</span>
					{/each}
				</div>
			{/if}
		</div>

		<!-- One row, wherever it is listed: the body's owner sections and the
		     demoted out-of-period tail below render the same NOTAM the same
		     way, the tail differing only in being dimmed. -->
		{#snippet notamRows(items: { notam: Notam; index: number }[], dim: boolean)}
			<ul class="notam-list" class:dim>
				{#each items as item (item.index)}
					<li>
						<button
							class="row"
							class:active={ui.detail?.kind === 'notam' && ui.detail.index === item.index}
							onclick={() => onSelect(item.index)}
						>
							<span class="dot {dotClass(item.notam)}"></span>
							<span class="row-text">
								<span class="row-id">{item.notam.id}</span>
								<span class="row-desc">{descriptor(item.notam)}</span>
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/snippet}

		{#if sections.length === 0}
			<div class="hidden-note">
				<p class="muted">{t.filter.hiddenByFilters(total)}</p>
				<button class="btn" onclick={clearRestrictingFilters}>{t.filter.showAll}</button>
			</div>
		{:else}
			{#each sections as sec (sec.key)}
				{#if sections.length > 1}
					<h3 class="cat-head">{sectionLabel(sec.owner)}</h3>
				{/if}
				{@render notamRows(sec.items, false)}
			{/each}
		{/if}

		{#if outside.length > 0}
			<div class="outside">
				<button
					class="outside-head"
					onclick={() => (outsideOpen = !outsideOpen)}
					aria-expanded={outsideOpen}
				>
					<Icon name={outsideOpen ? 'chevron-down' : 'chevron-right'} size={13} />
					<span>{t.filter.outsidePeriod(outside.length)}</span>
				</button>
				{#if outsideOpen}
					<p class="muted small outside-note">{t.filter.outsidePeriodNote}</p>
					{@render notamRows(outside, true)}
				{/if}
			</div>
		{/if}
	{/if}
</div>

<FiltersPopover
	open={filtersOpen}
	x={anchor.x}
	y={anchor.y}
	onClose={() => (filtersOpen = false)}
/>

<style>
	.tab-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.tab-head h2 {
		flex: 1;
		min-width: 0;
	}

	/* Head icon buttons (funnel / load): the shared .icon-btn compacted to
	   the head's button scale; :root.touch-ui .icon-btn (app.css) outranks
	   this and restores the 44px hit area. */
	.head-icon {
		width: 28px;
		height: 28px;
		background: var(--surface-2);
		border: 1px solid var(--border);
	}

	/* The incomplete-briefing chip: the tinted-pill caution grammar
	   NavigationTab uses for its position-quality chip, in the workbook
	   amber. A button, because it leads to the fetch view that names the
	   missing routes; the head wraps, so it may take a line of its own in a
	   narrow panel. */
	.gap-chip {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 5px;
		padding: 3px 9px;
		font: inherit;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--workbook-orange);
		cursor: pointer;
		background: color-mix(in srgb, var(--workbook-orange) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--workbook-orange) 40%, transparent);
		border-radius: 999px;
	}

	.gap-chip:hover {
		background: color-mix(in srgb, var(--workbook-orange) 18%, transparent);
	}

	:global(:root.touch-ui) .gap-chip {
		min-height: 44px;
	}

	.list-meta {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.count {
		font-size: 11px;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.chip {
		display: inline-flex;
		align-items: stretch;
		overflow: hidden;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 999px;
	}

	.chip-body,
	.chip-x {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 3px 6px 3px 9px;
		font: inherit;
		font-size: 11px;
		color: var(--text);
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.chip-x {
		padding: 3px 8px 3px 5px;
		color: var(--text-muted);
	}

	.chip-body:hover,
	.chip-x:hover {
		background: var(--surface-3);
	}

	.chip-x:hover {
		color: var(--text);
	}

	.chip-prov {
		display: inline-flex;
		color: var(--accent);
	}

	/* Touch: chip halves grow to the 44px hit area (keyed off touch-ui,
	   the app.css doctrine). */
	:global(:root.touch-ui) .chip-body,
	:global(:root.touch-ui) .chip-x {
		min-height: 44px;
	}

	:global(:root.touch-ui) .chip-x {
		min-width: 40px;
		justify-content: center;
	}

	/* The demoted tail: present, dimmed, and behind one disclosure so it never
	   competes with the briefing proper. */
	.outside {
		margin-top: 10px;
		border-top: 1px solid var(--border);
	}

	.outside-head {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 6px;
		padding: 8px 6px;
		font: inherit;
		font-size: 12px;
		color: var(--text-muted);
		text-align: left;
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.outside-head:hover {
		color: var(--text);
	}

	.outside-note {
		margin: 0 6px 4px;
	}

	.notam-list.dim {
		opacity: 0.6;
	}

	:global(:root.touch-ui) .outside-head {
		min-height: 44px;
	}

	.hidden-note {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
	}

	/* Owner sub-heading (aerodrome ident + name, FIR, Checklists, Other), shown
	 * only when the list spans more than one owner block. */
	.cat-head {
		margin: 12px 0 3px;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted);
	}

	.notam-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* A briefing can be thousands of rows, and the demoted out-of-period tail
	   adds thousands more, all of them in the DOM at once. Off-screen rows
	   skip layout and paint; they stay present, selectable, focusable and
	   findable, and the browser reveals one when it is scrolled to. The
	   intrinsic size is the measured two-line row height, so the scrollbar is right
	   before anything has been laid out. */
	.notam-list li {
		content-visibility: auto;
		contain-intrinsic-size: auto 46px;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 9px;
		width: 100%;
		padding: 7px 8px;
		text-align: left;
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius);
		cursor: pointer;
	}

	.row:hover {
		background: var(--surface-2);
	}

	.row.active {
		background: var(--surface-2);
		border-color: var(--accent);
	}

	.dot {
		flex: 0 0 auto;
		width: 10px;
		height: 10px;
		border-radius: 50%;
	}

	.dot.psn {
		background: var(--marker-red);
	}

	.dot.qline {
		background: var(--marker-blue);
	}

	.dot.area {
		background: var(--area);
	}

	.row-text {
		display: flex;
		min-width: 0;
		flex-direction: column;
	}

	.row-id {
		font-weight: 600;
	}

	.row-desc {
		font-size: 12px;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
