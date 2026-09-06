<script lang="ts">
	/* The NOTAMs tab's fetch view: three always-visible sections, one per
	 * way in (the autorouter viewport fetch, the route-corridor fetch
	 * through SOFIA or autorouter, and paste / open a file). Flat by
	 * decision: an accordion of sub-forms inside a popover was two levels
	 * of indirection for one screen of controls. Every fetch reports a
	 * successful load through onLoaded, so the tab can return to the list
	 * the briefing was fetched for; Clear lives at the foot beside the
	 * plotted count, never in the tab chrome. */
	import {
		activeEvalWindow,
		notamState,
		parseInput,
		clearNotams,
	} from '$lib/state/notam.svelte';
	import { autorouter } from '$lib/autorouter/state.svelte';
	import { fetchNotamsForRoute, fetchNotamsForViewport } from '$lib/autorouter/fetch';
	import {
		routeCoverage,
		viewportCoverage,
		MAX_ICAOS_PER_FETCH,
		MAX_VIEWPORT_DEG_PER_SIDE,
	} from '$lib/autorouter/viewport';
	import { sofia } from '$lib/sofia/state.svelte';
	import { fetchRouteNotamsFromSofia, stopSofiaFetch } from '$lib/sofia/fetch';
	import { notamFetchBusy, notamSource, setNotamSource } from '$lib/state/notamSource.svelte';
	import { activeRoute, routes, routeSettings } from '$lib/state/route.svelte';
	import { formatZulu } from '$lib/format/datetime';
	import { t } from '$lib/state/i18n.svelte';
	import { selectTab } from '$lib/state/ui.svelte';
	import { pickerAccept } from '$lib/ui/filePicker';
	import { isNativeApp } from '$lib/native/platform';
	import { pickFileNatively } from '$lib/state/openFile.svelte';

	const native = isNativeApp();
	import Icon from './Icon.svelte';
	import Segmented from './Segmented.svelte';

	let {
		onLoaded,
		onGaps,
	}: {
		/** Called after a fetch or a parse that produced a whole briefing, so
		 *  the tab can show the list it landed in. */
		onLoaded?: (() => void) | undefined;
		/** Called instead when the briefing landed short of a route, so the
		 *  tab holds this view: what is missing and why is stated here, and
		 *  the panel would otherwise flip to the list the moment any NOTAM
		 *  arrived. */
		onGaps?: (() => void) | undefined;
	} = $props();

	const count = $derived(notamState.notams.length);
	const gaps = $derived(notamState.gaps);
	/** Raw upstream message from a file the picker handed us but the platform
	 *  could not read (untranslated detail line, docs/i18n.md rule 7). */
	let uploadError = $state<string | null>(null);
	// One briefing at a time, whichever source: every button here is out while
	// any fetch runs, since they all replace the same parsed briefing.
	const busy = $derived(notamFetchBusy());

	// The route fetch covers every drawable route, so the button is live as
	// soon as any route qualifies (moved verbatim from the Route tab).
	const fetchableRoutes = $derived(routes.list.filter((r) => r.waypoints.length >= 2).length);
	// The briefing's own provenance: which fetch landed what is on the map.
	// One record, because one briefing is loaded at a time.
	const lastFetch = $derived(notamState.lastFetch);
	const lastFetchedTime = $derived(lastFetch ? formatZulu(new Date(lastFetch.at)) : '');
	/* The instant the loaded briefing stops covering, when the viewing period
	 * runs past it; null when the source briefed the whole period (or states
	 * no window of its own, like the autorouter's per-FIR pull). An unbounded
	 * look-ahead is the common case and always overruns a capped briefing. */
	const periodGap = $derived.by(() => {
		const b = lastFetch?.briefed;
		if (!b) {
			return null;
		}
		return activeEvalWindow().to > b.to ? formatZulu(new Date(b.to)) : null;
	});
	const routeEnough = $derived(activeRoute().waypoints.length >= 2);
	const routeCov = $derived(
		routeCoverage(activeRoute().waypoints, routeSettings.corridorRadiusNM),
	);

	const routeCoverageLine = $derived.by(() => {
		if (fetchableRoutes === 0) {
			return '';
		}
		if (!routeCov.dataReady) {
			return t.route.loadingDatasets;
		}
		// The figures describe the active route; the fetch covers all of them.
		const others = fetchableRoutes > 1 ? ` ${t.route.fetchCoversAll(fetchableRoutes)}` : '';
		if (!routeEnough) {
			return t.route.noCorridorYet + others;
		}
		let line = t.route.coverageWithin({
			a: routeCov.airports,
			f: routeCov.firs,
			nm: routeSettings.corridorRadiusNM,
		});
		if (routeCov.overCap) {
			line += ` ${t.route.onlyClosest(MAX_ICAOS_PER_FETCH)}`;
		}
		return line + others;
	});

	// The read is the step that fails on Android (the chooser hands back a
	// content URI a provider can refuse), and an unguarded one rejects into
	// nowhere, which reads as the app ignoring the file. The input clears only
	// once the file has been read, so the clearing cannot race the read.
	async function onUpload(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) {
			return;
		}
		uploadError = null;
		try {
			notamState.rawText = await file.text();
			parseInput();
		} catch (err) {
			uploadError = err instanceof Error ? err.message : String(err);
		}
		input.value = '';
	}

	async function onPaste(): Promise<void> {
		try {
			notamState.rawText = await navigator.clipboard.readText();
		} catch {
			/* clipboard access denied */
		}
	}

	function onClear(): void {
		// clearNotams() drops the fetch provenance along with the briefing it
		// describes. What would otherwise linger is each source's own
		// complaint, still read as being about the NOTAMs now cleared.
		clearNotams();
		autorouter.error = null;
		sofia.error = null;
		sofia.errorDetail = null;
	}

	function goRoute(): void {
		selectTab('route');
	}

	/** Run a fetch / parse and, when it produced a whole briefing, hand the
	 *  panel back to the list. A failure keeps the view, so the error line
	 *  stays under the button that raised it; a briefing that landed short of
	 *  a route asks to keep it too, since the routes it missed and why are
	 *  stated right here and the pilot has to be able to read them. The head
	 *  chip leads back once they move on. */
	async function run(action: () => void | Promise<void>): Promise<void> {
		await action();
		if (notamState.notams.length === 0) {
			return;
		}
		if (notamState.gaps) {
			onGaps?.();
		} else {
			onLoaded?.();
		}
	}

	// Guards the already-fetching case here too, not only through `disabled`
	// and the fetch modules' own guards: run() reads the NOTAM count after
	// awaiting, so a DECLINED fetch would see the previous briefing's count
	// and flip the panel to the list mid-fetch. autorouter needs no account:
	// the shared credential lives in the proxy, so the fetch is always
	// available.
	function onFetchView(): void {
		if (!busy) {
			void run(fetchNotamsForViewport);
		}
	}

	function onFetchRoute(): void {
		if (busy) {
			return;
		}
		void run(
			notamSource.source === 'sofia' ? fetchRouteNotamsFromSofia : fetchNotamsForRoute,
		);
	}

	const coverage = $derived(viewportCoverage());

	/* Single-line summary of what fetching for the current view would
	 * actually request and skip. Lets the user know they're in a
	 * placeholder-ICAO region (Africa, parts of Asia) or a FIR-only one
	 * (most of the world outside France + the US) before pressing Fetch. */
	const coverageLine = $derived.by(() => {
		const c = coverage;
		if (!c.dataReady) {
			return t.input.covLoading;
		}
		if (c.viewportTooLarge) {
			return t.input.covViewportTooLarge(MAX_VIEWPORT_DEG_PER_SIDE);
		}
		if (c.airports === 0 && c.firs === 0 && c.skippedAirports === 0) {
			return t.input.covEmpty;
		}
		const parts = [t.input.covInView({ a: c.airports, f: c.firs })];
		if (c.overCap) {
			parts.push(t.input.covOverCap(MAX_ICAOS_PER_FETCH));
		}
		if (c.skippedAirports > 0) {
			parts.push(t.input.covSkipped(c.skippedAirports));
		}
		if (c.richAirspaces === 0 && c.firs > 0) {
			parts.push(t.input.covFirOnly);
		}
		return parts.join(' ');
	});
</script>

<div class="loader">
	<fieldset class="group">
		<legend>{t.input.launchFetch}</legend>
		<p class="coverage" class:coverage-warn={coverage.viewportTooLarge}>
			{coverageLine}
		</p>
		<div class="actions">
			<button
				class="btn primary"
				disabled={busy}
				title={t.input.fetchTipReady}
				onclick={onFetchView}
			>
				{autorouter.fetching === 'viewport' ? t.input.fetching : t.input.launchFetch}
			</button>
		</div>
		<!-- Only this button's own outcome: the route fetch below writes the
		     same fields, and its error reported here for want of a kind. -->
		{#if autorouter.error && autorouter.lastKind === 'viewport'}
			<p class="error" role="alert">{autorouter.error()}</p>
		{:else if lastFetch?.source === 'autorouter' && lastFetch.kind === 'viewport' && count === 0}
			<p class="muted small">
				{t.input.fetched({ n: lastFetch.count, time: lastFetchedTime })}
			</p>
		{/if}
	</fieldset>

	<fieldset class="group">
		<legend>{t.route.notamsForRoute}</legend>
		{#if fetchableRoutes > 0}
			<!-- Source picker: SOFIA-Briefing (French SIA) or autorouter
			     (Eurocontrol EAD, Europe-wide). Both anonymous to the user;
			     both fetch paths end at the same notamState seam. -->
			<Segmented
				options={[
					{ value: 'sofia', label: t.route.sourceSofia },
					{ value: 'autorouter', label: t.route.sourceAutorouter },
				]}
				value={notamSource.source}
				onSelect={(v) => setNotamSource(v as 'sofia' | 'autorouter')}
				ariaLabel={t.route.sourceAria}
			/>
			<p class="source-hint">
				{notamSource.source === 'sofia' ? t.route.sourceSofiaHint : t.route.sourceAutorouterHint}
			</p>
			<!-- What each source is actually asked for: autorouter takes an
			     ICAO LIST derived from the corridor (so its count and cap
			     matter), SOFIA takes the route itself with a corridor
			     half-width and scans server-side (no list, no cap). -->
			{#if notamSource.source === 'autorouter'}
				{#if routeCoverageLine}
					<p class="coverage">{routeCoverageLine}</p>
				{/if}
			{:else}
				<p class="coverage">
					{t.route.sofiaCorridor({ nm: routeSettings.corridorRadiusNM })}
					{#if fetchableRoutes > 1}
						{t.route.fetchCoversAll(fetchableRoutes)}
					{/if}
				</p>
			{/if}
			<div class="actions">
				<button
					class="btn primary"
					disabled={busy}
					title={notamSource.source === 'sofia' ? t.route.sofiaFetchTip : t.route.fetchTipReady}
					onclick={onFetchRoute}
				>
					{#if sofia.fetching}
						<!-- SOFIA briefs one route per request against a service that
						     can take tens of seconds, so it counts them off; the
						     autorouter fetch is one call and has nothing to count.
						     Both branches read the fetch RUNNING, not the picker, so
						     flipping the source mid-briefing can't hide it. -->
						{sofia.progress ? t.route.fetchingProgress(sofia.progress) : t.route.fetching}
					{:else if autorouter.fetching === 'route'}
						{t.route.fetching}
					{:else}
						{fetchableRoutes > 1 ? t.route.getNotamsMany : t.route.getNotamsOne}
					{/if}
				</button>
				<!-- A briefing that has to wait out a slow route can run for
				     minutes; whatever has already landed is kept. Gated on the
				     briefing, never on the picker: flipping the source mid-fetch
				     must not strand a running briefing with no way to end it. -->
				{#if sofia.fetching}
					<button class="btn" onclick={stopSofiaFetch} title={t.route.stopFetchTip}>
						{t.route.stopFetch}
					</button>
				{/if}
			</div>
			<!-- The outcome of the picked source's last route fetch, nested so a
			     source with nothing to report says nothing rather than falling
			     through to the other's. The autorouter branch takes only what
			     THIS button ran (lastKind), never the viewport fetch's. -->
			{#if notamSource.source === 'sofia'}
				{#if sofia.error}
					<p class="error" role="alert" title={sofia.errorDetail ?? undefined}>{sofia.error()}</p>
				{:else if lastFetch?.source === 'sofia' && count === 0}
					<p class="muted small">
						{t.route.sofiaFetchedAt({ n: lastFetch.count, time: lastFetchedTime })}
					</p>
				{/if}
			{:else if autorouter.error && autorouter.lastKind === 'route'}
				<p class="error" role="alert">{autorouter.error()}</p>
			{:else if lastFetch?.source === 'autorouter' && lastFetch.kind === 'route' && count === 0}
				<p class="muted small">
					{t.input.fetched({ n: lastFetch.count, time: lastFetchedTime })}
				</p>
			{/if}
			<!-- What the briefing that landed does NOT cover, one row per
			     route, beside the count it did fetch: a briefing missing a
			     corridor is still worth flying with, once the pilot knows
			     which corridor. The wire line rides the tooltip. The gap
			     belongs to the briefing, not to this view (docs/sofia-
			     briefing.md), so the picker doesn't gate it. -->
			<!-- The other half of coverage, which was only ever stated in
			     space: a route PIB covers a capped look-ahead from the
			     instant it was asked for, so a viewing period wider than
			     that is briefed on its first day and reads as complete.
			     Same alert family as the route gaps below. -->
			{#if periodGap}
				<p class="gaps-head period-gap" title={t.input.periodNotCoveredTip}>
					<Icon name="alert-triangle" size={13} />
					{t.input.periodNotCovered({ until: periodGap })}
				</p>
			{/if}
			{#if gaps}
				<div class="gaps">
					<p class="gaps-head">
						<Icon name="alert-triangle" size={13} />
						{t.notam.routesNotCovered({ missing: gaps.routes.length, total: gaps.total, list: true })}
					</p>
					<ul>
						{#each gaps.routes as gap (gap.label)}
							<li title={gap.detail}>
								<span class="gap-route">{gap.label}</span>
								{t.errors.sofiaCause[gap.cause]}
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		{:else}
			<p class="muted small">{t.input.launchRouteDesc}</p>
			<div class="actions">
				<button class="btn" onclick={goRoute}>{t.input.launchRoute}</button>
			</div>
		{/if}
	</fieldset>

	<fieldset class="group">
		<legend>{t.input.launchPaste}</legend>
		<!-- Both briefing sites, side by side: the paste box is where a
		     copied SOFIA or autorouter briefing lands. -->
		<div class="ext-links">
			<a
				class="ext-link"
				href="https://sofia-briefing.aviation-civile.gouv.fr/"
				target="_blank"
				rel="noopener noreferrer"
				title={t.input.sofiaLinkTip}
			>{t.input.sofiaLink}</a>
			<a
				class="ext-link"
				href="https://www.autorouter.aero/"
				target="_blank"
				rel="noopener noreferrer"
				title={t.input.autorouterLinkTip}
			>{t.input.autorouterLink}</a>
		</div>
		<textarea
			class="notam-input"
			bind:value={notamState.rawText}
			placeholder={t.input.pastePlaceholder}
			spellcheck="false"
		></textarea>
		<div class="actions">
			<button class="btn primary" onclick={() => void run(parseInput)}>
				{t.input.displayOnMap}
			</button>
			{#if native}
				<!-- The Android picker, not the WebView's own chooser, which hands
				     the page a file it cannot always read back (docs/android.md). -->
				<button class="btn" onclick={() => void pickFileNatively()}>{t.input.upload}</button>
			{:else}
				<label class="btn file">
					{t.input.upload}
					<input type="file" accept={pickerAccept('.txt')} onchange={onUpload} />
				</label>
			{/if}
			<button class="btn" onclick={onPaste}>{t.input.paste}</button>
		</div>
		{#if uploadError}
			<p class="error" role="alert" lang="en">{uploadError}</p>
		{/if}
	</fieldset>
	{#if count > 0}
		<div class="status">
			<p class="muted small">
				{t.input.plotted(count)}
				{#if lastFetch}
					{lastFetch.source === 'sofia'
						? t.route.sofiaFetchedAt({ n: lastFetch.count, time: lastFetchedTime })
						: t.input.fetched({ n: lastFetch.count, time: lastFetchedTime })}
				{/if}
			</p>
			<button class="btn" onclick={onClear}>{t.input.clear}</button>
		</div>
	{/if}
</div>

<style>
	.loader {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	/* The sections stack their own children: a fieldset lays out as blocks,
	   and the coverage / hint paragraphs carry no margin, so without this
	   the status lines sit flush against the button rows. The 12px is the
	   .tab-panel rhythm the controls had when they were its direct
	   children (the retired Input tab). */
	.loader .group {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	/* The source pill hugs its options: a flex child stretches by default,
	   and a full-width segmented control reads as a tab bar. */
	.loader .group :global(.seg) {
		align-self: flex-start;
	}

	/* The routes the briefing that landed does not cover. A caution, not an
	   error: the briefing is usable, it is just short of a corridor. Same
	   tinted-pill grammar as NavigationTab's position-quality chip, in the
	   workbook amber the app already uses for text-weight cautions. */
	.gaps {
		padding: 6px 9px;
		color: var(--workbook-orange);
		background: color-mix(in srgb, var(--workbook-orange) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--workbook-orange) 40%, transparent);
		border-radius: var(--radius);
	}

	.gaps-head {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		font-size: 12px;
		font-weight: 600;
	}

	/* The time half of the same caution, which stands alone (the route gaps
	   have their own box only because they carry a list under the head). */
	.period-gap {
		padding: 6px 9px;
		color: var(--workbook-orange);
		background: color-mix(in srgb, var(--workbook-orange) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--workbook-orange) 40%, transparent);
		border-radius: var(--radius);
	}

	.gaps ul {
		margin: 4px 0 0;
		padding: 0;
		font-size: 12px;
		line-height: 1.45;
		list-style: none;
	}

	.gap-route {
		font-weight: 600;
	}

	/* Source/status line + Clear, shown once a briefing is loaded (the
	   overlay posture). */
	.status {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.status p {
		min-width: 0;
	}

	/* Sub-block under a launcher row (coverage / status / expanded paste). */

	.notam-input {
		width: 100%;
		min-height: 440px;
		padding: 8px 10px;
		font-family: ui-monospace, "SF Mono", "Cascadia Code", consolas, monospace;
		font-size: 12px;
		line-height: 1.5;
		color: var(--text);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		resize: vertical;
	}

	.notam-input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.btn.file {
		position: relative;
		overflow: hidden;
	}

	.btn.file input {
		position: absolute;
		inset: 0;
		opacity: 0;
		cursor: pointer;
	}

	.ext-links {
		display: flex;
		gap: 14px;
	}

	.source-hint {
		margin: 0;
		font-size: 11px;
		line-height: 1.4;
		color: var(--text-muted);
	}

	.ext-link {
		align-self: flex-start;
		font-size: 12px;
		color: var(--accent);
		text-decoration: none;
	}

	.ext-link:hover {
		text-decoration: underline;
	}

	.ext-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.coverage {
		margin: 0;
		font-size: 11px;
		line-height: 1.4;
		color: var(--text-muted);
	}

	.coverage-warn {
		color: var(--text);
	}

	.small {
		font-size: 11px;
	}
</style>
