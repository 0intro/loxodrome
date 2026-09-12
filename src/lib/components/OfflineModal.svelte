<script lang="ts">
	/* The offline manager (docs/offline-maps.md, "The manager UI"): every
	 * download the app can make, in one place, over the one queue.
	 *
	 * The three families differ in their metadata, not in their shape, so
	 * they are folded into ONE row view and rendered by ONE snippet. That is
	 * what replaced the two near-identical rows the Layers tab carried and
	 * the third, differently-worded one in the Route tab. */
	import SurfaceShell from './SurfaceShell.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import Icon from './Icon.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { closeOffline, offlineModal, type OfflineSection } from '$lib/state/offlineModal.svelte';
	import { CHART_LAYERS } from '$lib/map/chartOverlays';
	import { formatPackBytes } from '$lib/offline/packStore';
	import { freeBytes, storageSpace } from '$lib/offline/quota';
	import {
		offlineQueue,
		pendingBytes,
		pendingCount,
		stopOfflineQueue,
	} from '$lib/state/offlineQueue.svelte';
	import { jobKey, type JobRef } from '$lib/offline/downloadQueue';
	import {
		cancelPack,
		downloadPack,
		ensureOfflineCharts,
		ensurePackSizes,
		offlineCharts,
		packQueuePosition,
		packQueued,
		packRunning,
		packableCharts,
		removePack,
	} from '$lib/state/offlineCharts.svelte';
	import {
		cancelDocPack,
		docPackPublished,
		docPackQueuePosition,
		docPackQueued,
		docPackRunning,
		downloadDocPack,
		ensureDocPackSizes,
		offlineDocs,
		removeDocPack,
	} from '$lib/state/offlineDocs.svelte';
	import { DOC_PACKS, supPackId, type DocPackId } from '$lib/offline/docPacks';
	import { nextAiracString } from '$lib/data/airac';
	import {
		cancelTerrainPins,
		downloadTerrainPins,
		ensureTerrainPinStats,
		offlineTerrain,
		pinRadiusNM,
		planRoutePoints,
		plannedTileCount,
		removeTerrainPins,
		terrainPinQueued,
		terrainPinQueuePosition,
		terrainPinRunning,
	} from '$lib/state/offlineTerrain.svelte';
	import { estimateBytes, isoDay } from '$lib/offline/terrainPin';
	import { passiveClear, passiveStats } from '$lib/offline/passiveStore';
	import { display } from '$lib/state/display.svelte';
	import { resolveLangPref } from '$lib/i18n/locale';
	import { i18n } from '$lib/state/i18n.svelte';
	import { isNativeApp } from '$lib/native/platform';

	/* The download OFFER is the Android shell's alone (docs/offline-maps.md):
	 * a pack is the promise that a chart will be there at the aerodrome, and
	 * only the shell can keep it. SERVING and an already-held pack's Delete
	 * stay platform-blind, which is why this gates `canDownload` per row
	 * rather than the surface. */
	const offlineManager = isNativeApp();

	// The sizes ride the offer, so the HEADs are made here rather than on the
	// Layers tab: the manager is the only place that needs them.
	if (offlineManager) {
		void ensurePackSizes();
		void ensureDocPackSizes();
	}
	void ensureOfflineCharts();
	void ensureTerrainPinStats();

	/** What a row can be, folded from the module's own status and the queue.
	 *  'paused' is the reading of a state that already existed on disk and
	 *  was never shown: a cancelled download keeps its .part, and localBytes
	 *  has held those bytes since boot. */
	type RowState = 'none' | 'queued' | 'running' | 'paused' | 'ready' | 'error';

	interface ManagerRow {
		key: string;
		name: string;
		note: string;
		/** Facts joined with a separator: size, date, cycle, counts. */
		meta: string[];
		state: RowState;
		pct: number;
		queuePos: number;
		updateAvailable: boolean;
		/** The server's size, for the queue and the bulk-update total. */
		sizeBytes: number | null;
		error: string | null;
		/** An archive keeps its part and resumes byte-exact; a terrain sweep
		 *  keeps what it got and starts the rest afresh. One button cannot
		 *  honestly say both, so the row declares which it offers. */
		stopVerb: 'pause' | 'cancel';
		canDownload: boolean;
		heldBytes: number;
		onDownload: () => void;
		onStop: () => void;
		onDelete: (() => void) | null;
	}

	const sizeText = (n: number | null | undefined): string =>
		n ? formatPackBytes(n) : '';

	/** A storage TOTAL, where nothing held is a real answer and has to read
	 *  as one. formatPackBytes floors at "1 MB" so a small PACK never claims
	 *  to be empty, which is right for a size and wrong for a total. */
	const totalText = (n: number): string => (n > 0 ? formatPackBytes(n) : '\u2014');

	/** One pack's row, chart or document: the two views differ only in the
	 *  extra facts a document carries. */
	function packRow(
		key: string,
		name: string,
		note: string,
		v:
			| {
					status: 'none' | 'downloading' | 'ready' | 'error';
					progress: number;
					sizeBytes: number | null;
					localBytes: number;
					downloadedAt: string | null;
					updateAvailable: boolean;
					error: 'quota' | 'download' | 'unpublished' | 'unsupported' | null;
			  }
			| undefined,
		extraMeta: string[],
		published: boolean,
		acts: { download: () => void; stop: () => void; remove: () => void },
		queued: boolean,
		running: boolean,
		queuePos: number,
	): ManagerRow {
		const localBytes = v?.localBytes ?? 0;
		const status = v?.status ?? 'none';
		const state: RowState = running
			? 'running'
			: queued
				? 'queued'
				: status === 'ready'
					? 'ready'
					: status === 'error'
						? 'error'
						: localBytes > 0
							? 'paused'
							: 'none';
		const pct = Math.round((v?.progress ?? 0) * 100);
		/* ONE line, saying whatever the row is doing. A download used to ADD
		 * lines (a size, then a percentage, then a position) and a whole
		 * section above them; the state belongs where the size already was, so
		 * starting one changes what the row says and not how tall it is. */
		const meta: string[] = [];
		if (state === 'running') {
			meta.push(
				t.offline.figures({
					pct,
					done: sizeText(localBytes),
					total: sizeText(v?.sizeBytes) || '?',
				}),
			);
		} else if (state === 'queued') {
			meta.push(
				queuePos > 0 ? t.offline.queuedAt(queuePos) : t.offline.queued,
				...(v?.sizeBytes ? [sizeText(v.sizeBytes)] : []),
			);
		} else if (state === 'ready' && v?.downloadedAt) {
			meta.push(t.offline.held({ date: v.downloadedAt.slice(0, 10), size: sizeText(localBytes) }));
		} else if (state === 'paused') {
			meta.push(
				t.offline.paused({
					pct: v?.sizeBytes ? Math.round((localBytes / v.sizeBytes) * 100) : 0,
					done: sizeText(localBytes),
					total: sizeText(v?.sizeBytes) || '?',
				}),
			);
		} else if (v?.sizeBytes) {
			meta.push(sizeText(v.sizeBytes));
		}
		meta.push(...extraMeta);
		return {
			key,
			name,
			note,
			meta,
			state,
			pct,
			queuePos,
			updateAvailable: v?.updateAvailable ?? false,
			sizeBytes: v?.sizeBytes ?? null,
			error: v?.error ? t.offline.errors[v.error] : null,
			stopVerb: 'pause',
			canDownload: offlineManager && published,
			heldBytes: localBytes,
			onDownload: acts.download,
			onStop: acts.stop,
			onDelete: localBytes > 0 ? acts.remove : null,
		};
	}

	const chartRows = $derived(
		packableCharts().map((c) => {
			const def = CHART_LAYERS.find((d) => d.id === c.id);
			return packRow(
				`chart/${c.id}`,
				def?.label ?? c.id,
				def ? t.layers[def.coverageKey] : '',
				offlineCharts.packs[c.id],
				[],
				true,
				{
					download: () => downloadPack(c.id),
					stop: () => cancelPack(c.id),
					remove: () => void removePack(c.id),
				},
				packQueued(c.id),
				packRunning(c.id),
				packQueuePosition(c.id),
			);
		}),
	);

	const supLang = $derived(resolveLangPref(display.supaipLang, i18n.locale));

	/* Every HELD pack is listed, and only the OFFER follows the language
	 * preference. Listing the preferred language alone (what the Layers tab
	 * did) made a supplement pack downloaded in the other language
	 * invisible AND undeletable the moment the preference changed. */
	const docIds = $derived.by(() => {
		// docPackPublished consults a non-reactive Map, so this derived has to
		// track the signal that says it changed.
		void offlineDocs.gen;
		const ids: DocPackId[] = ['fr-vac', supPackId(supLang)];
		if (docPackPublished('fr-vac-next') || offlineDocs.packs['fr-vac-next']?.status === 'ready') {
			ids.push('fr-vac-next');
		}
		for (const d of DOC_PACKS) {
			// Held, or in the queue: a set queued in one language and then
			// demoted by a change of SUP AIP preference would otherwise keep
			// downloading with no row anywhere, while the queue's own count
			// went on including it.
			if (
				!ids.includes(d.id) &&
				((offlineDocs.packs[d.id]?.localBytes ?? 0) > 0 ||
					docPackQueued(d.id) ||
					docPackRunning(d.id))
			) {
				ids.push(d.id);
			}
		}
		return ids;
	});

	function docName(id: DocPackId): string {
		if (id === 'fr-vac') {
			return t.offline.docsVac;
		}
		if (id === 'fr-vac-next') {
			return t.offline.docsNextCycle(nextAiracString());
		}
		// A supplement pack names its OWN language, not the preference: a set
		// held in the other language is listed too, and has to say which it is.
		const lang = id === 'fr-sup-en' ? 'EN' : 'FR';
		return `${t.offline.docsSup} ${t.offline.docsSupLang(lang)}`;
	}

	const docRows = $derived(
		docIds.map((id) => {
			const v = offlineDocs.packs[id];
			const extra: string[] = [];
			if (v?.status === 'ready') {
				// The ready line already states size and date, so it REPLACES
				// the generic size rather than joining it.
				extra.push(
					t.offline.docsStored({
						files: v.files,
						size: formatPackBytes(v.localBytes),
						date: v.downloadedAt?.slice(0, 10) ?? '',
					}),
				);
				if (v.stale && v.cycle) {
					extra.push(t.offline.docsStale(v.cycle));
				}
				if (v.missing > 0) {
					extra.push(t.offline.docsMissing(v.missing));
				}
			}
			const row = packRow(
				`doc/${id}`,
				docName(id),
				id === 'fr-vac' || id === 'fr-vac-next' ? t.offline.docsVacNote : '',
				v,
				extra,
				docPackPublished(id),
				{
					download: () => downloadDocPack(id),
					stop: () => cancelDocPack(id),
					remove: () => void removeDocPack(id),
				},
				docPackQueued(id),
				docPackRunning(id),
				docPackQueuePosition(id),
			);
			if (v?.status === 'ready') {
				row.meta = extra;
			}
			return row;
		}),
	);

	const terrainTiles = $derived(plannedTileCount());
	const terrainRoutes = $derived(planRoutePoints().length);

	const terrainRow = $derived.by((): ManagerRow => {
		const running = terrainPinRunning();
		const queued = terrainPinQueued();
		const held = offlineTerrain.count > 0;
		const state: RowState = running
			? 'running'
			: queued
				? 'queued'
				: offlineTerrain.status === 'error'
					? 'error'
					: held
						? 'ready'
						: 'none';
		const pct = Math.round(offlineTerrain.progress * 100);
		const meta: string[] = [];
		if (terrainTiles > 0) {
			meta.push(
				t.offline.terrainScope({
					routes: terrainRoutes,
					radius: pinRadiusNM(),
					tiles: terrainTiles,
					size: formatPackBytes(estimateBytes(terrainTiles)),
				}),
			);
		}
		return {
			key: 'terrain/plan',
			name: t.offline.terrainSubject,
			note: terrainTiles === 0 ? t.offline.terrainNoRoute : '',
			meta: meta.filter(Boolean),
			state,
			pct,
			queuePos: terrainPinQueuePosition(),
			updateAvailable: false,
			sizeBytes: terrainTiles > 0 ? estimateBytes(terrainTiles) : null,
			error: offlineTerrain.error ? t.offline.errors[offlineTerrain.error] : null,
			// Many small fetches with replace-on-success semantics: stopping
			// keeps what it got but resumes nothing.
			stopVerb: 'cancel',
			canDownload: terrainTiles > 0,
			heldBytes: offlineTerrain.bytes,
			onDownload: () => downloadTerrainPins(),
			onStop: () => cancelTerrainPins(),
			onDelete: held ? () => void removeTerrainPins() : null,
		};
	});

	/* A row the surface cannot serve is ABSENT, never rendered dead (the
	 * FlightsModal doctrine). Where the offer is gated off, a catalogue row
	 * with nothing held carries no button at all, and eleven of those are
	 * noise around the one pack the pilot actually holds. */
	const actionable = (r: ManagerRow): boolean =>
		r.canDownload ||
		r.onDelete !== null ||
		r.state === 'running' ||
		r.state === 'queued' ||
		r.state === 'error';

	const shownChartRows = $derived(chartRows.filter(actionable));
	const shownDocRows = $derived(docRows.filter(actionable));

	/** The queue's own view: the running job first, then the waiting ones. */
	const allRows = $derived([...chartRows, ...docRows, terrainRow]);
	const rowByKey = $derived(new Map(allRows.map((r) => [r.key, r])));

	function refKey(ref: JobRef): string {
		return jobKey(ref);
	}

	const runningRow = $derived(
		offlineQueue.running ? (rowByKey.get(refKey(offlineQueue.running)) ?? null) : null,
	);

	const waiting = $derived(pendingBytes());

	/* The RUNNING job's remainder belongs in the total: pendingCount counts
	 * it, so leaving its bytes out undercounts by exactly the job most likely
	 * to be the 25 GB one. The queue holds only the waiting jobs, so the
	 * figure comes from the running row. */
	const runningRemaining = $derived(
		runningRow?.sizeBytes ? Math.max(0, runningRow.sizeBytes - runningRow.heldBytes) : 0,
	);
	const remainingKnown = $derived(waiting.known + runningRemaining);
	const remainingUnknown = $derived(
		waiting.unknown + (runningRow !== null && !runningRow.sizeBytes ? 1 : 0),
	);

	/* What the header says while the queue drains: how many are outstanding,
	 * how much is left. Over-quota REPLACES that rather than adding a line,
	 * and the screen-on advice rides the title: the drain holds the wake lock
	 * for its whole run now (docs/offline-maps.md), so that note is about a
	 * pilot locking the phone by hand and does not earn space in a header
	 * narrow enough to elide the surface's own name. */
	const queueStatus = $derived.by(() => {
		if (!queueFits && free !== null) {
			return t.offline.queueOverflow(formatPackBytes(free));
		}
		return queueTotalText;
	});

	const queueTotalText = $derived.by(() => {
		const jobs = pendingCount();
		if (remainingUnknown === 0) {
			return t.offline.queueTotal({ jobs, size: formatPackBytes(remainingKnown) });
		}
		// formatPackBytes floors at "1 MB" so a small pack never claims to be
		// empty, which would turn an all-unknown queue into "1 MB remaining".
		if (remainingKnown === 0) {
			return t.offline.queueTotalUnknownOnly(jobs);
		}
		return t.offline.queueTotalUnknown({
			jobs,
			size: formatPackBytes(remainingKnown),
			unknown: remainingUnknown,
		});
	});

	/* Free space, read when the surface opens and again whenever a job
	 * finishes: the aggregate is advisory, so it never refuses anything, but
	 * a queue is a thing you walk away from and finding out an hour later
	 * that there was never room is the failure it prevents. */
	let free = $state<number | null>(null);
	let used = $state<number | null>(null);
	let tiles = $state<{ count: number; bytes: number }>({ count: 0, bytes: 0 });

	async function readStorage(): Promise<void> {
		const s = await storageSpace();
		used = s?.usage ?? null;
		free = s === null ? await freeBytes() : Math.max(0, s.quota - s.usage);
		tiles = await passiveStats();
	}
	void readStorage();

	$effect(() => {
		// Re-read whenever the queue goes quiet or a pack appears / vanishes.
		void offlineQueue.busy;
		void offlineCharts.gen;
		void offlineDocs.gen;
		void offlineTerrain.bytes;
		void readStorage();
	});

	const queueFits = $derived(free === null || remainingKnown <= free);

	const chartBytes = $derived(
		chartRows.reduce((n, r) => n + (r.state === 'ready' ? r.heldBytes : 0), 0),
	);
	const docBytes = $derived(
		docRows.reduce((n, r) => n + (r.state === 'ready' ? r.heldBytes : 0), 0),
	);
	const updatable = $derived(
		allRows.filter((r) => r.state === 'ready' && r.updateAvailable && r.canDownload),
	);
	const updateBytes = $derived(updatable.reduce((n, r) => n + (r.sizeBytes ?? 0), 0));

	let confirm = $state<{ message: string; label: string; run: () => void } | null>(null);

	function ask(message: string, label: string, run: () => void): void {
		confirm = { message, label, run };
	}

	function runConfirm(): void {
		const c = confirm;
		confirm = null;
		c?.run();
	}

	/* Scroll to the section an entry point asked for. Keyed on focusSeq, so
	 * asking twice for the same one works (a same-value write notifies
	 * nobody). Never steals focus: the surface is not modal. */
	const sections: Partial<Record<OfflineSection, HTMLElement>> = $state({});
	$effect(() => {
		const want = offlineModal.focus;
		void offlineModal.focusSeq;
		if (!want) {
			return;
		}
		sections[want]?.scrollIntoView({ block: 'start' });
	});
</script>

<SurfaceShell
	id="offline"
	onClose={closeOffline}
	label={t.offline.title}
	closeLabel={t.common.close}
	boxClass="offline-box"
	actions={offlineQueue.busy ? queueActions : undefined}
	actionsLabel={t.common.more}
>
	{#snippet header()}
		<h2>{t.offline.title}</h2>
		<!-- The one thing a row cannot say: what the whole queue still owes,
		     and whether it still fits. In the header because a download must
		     not change the SHAPE of the surface, only what its rows read. -->
		{#if offlineQueue.busy}
			<p class="sub" class:over={!queueFits} title={t.offline.wakeNote}>{queueStatus}</p>
		{/if}
	{/snippet}

	<div class="body surface-panel">
		{#if !offlineManager}
			<p class="muted">{t.offline.webOnly}</p>
		{/if}

		{#if shownChartRows.length > 0}
			<fieldset class="group" bind:this={sections.charts}>
				<legend>{t.offline.chartsLegend}</legend>
				<p class="muted">{t.offline.chartsNote}</p>
				{#if updatable.length > 0}
					<div class="pack bulk">
						<div class="pack-main">
							<p class="pack-name">{t.offline.updatesAvailable(updatable.length)}</p>
						</div>
						<div class="pack-actions">
							<button class="btn" onclick={() => updatable.forEach((r) => r.onDownload())}>
								{t.offline.updateAll({
									n: updatable.length,
									size: formatPackBytes(updateBytes),
								})}
							</button>
						</div>
					</div>
				{/if}
				{#each shownChartRows as r (r.key)}
					{@render row(r)}
				{/each}
			</fieldset>
		{/if}

		{#if shownDocRows.length > 0}
			<fieldset class="group" bind:this={sections.documents}>
				<legend>{t.offline.docsLegend}</legend>
				{#each shownDocRows as r (r.key)}
					{@render row(r)}
				{/each}
			</fieldset>
		{/if}

		<fieldset class="group" bind:this={sections.terrain}>
			<legend>{t.offline.terrainLegend}</legend>
			{@render row(terrainRow)}
			{#if offlineTerrain.count > 0}
				<p class="muted">
					{t.offline.docsStored({
						files: offlineTerrain.count,
						size: formatPackBytes(offlineTerrain.bytes),
						date: isoDay(offlineTerrain.newestTs),
					})}
				</p>
			{/if}
		</fieldset>

		<fieldset class="group" bind:this={sections.storage}>
			<legend>{t.offline.storageLegend}</legend>
			{#if used === null && free === null}
				<p class="muted">{t.offline.storageUnknown}</p>
			{:else}
				{#if used !== null}
					<p class="muted">{t.offline.storageUsed(totalText(used))}</p>
				{/if}
				{#if free !== null}
					<p class="muted">{t.offline.storageFree(formatPackBytes(free))}</p>
				{/if}
			{/if}
			<dl class="usage">
				<dt>{t.offline.storageCharts}</dt>
				<dd>{totalText(chartBytes)}</dd>
				<dt>{t.offline.storageDocs}</dt>
				<dd>{totalText(docBytes)}</dd>
				<dt>{t.offline.storageTerrain}</dt>
				<dd>{totalText(offlineTerrain.bytes)}</dd>
				<dt>{t.offline.storageTiles}</dt>
				<dd>
					{totalText(tiles.bytes)}
					{#if tiles.count > 0}
						<button
							class="btn"
							onclick={() =>
								ask(t.offline.clearTilesConfirm, t.offline.clear, () => {
									void passiveClear().then(readStorage);
								})}
						>
							{t.offline.clear}
						</button>
					{/if}
				</dd>
			</dl>
			<p class="muted">{t.offline.storageTilesNote}</p>
		</fieldset>
	</div>
</SurfaceShell>

{#snippet queueActions({ close }: { close: () => void })}
	<button
		class="item danger"
		onclick={() => {
			close();
			ask(t.offline.stopAllConfirm, t.offline.stopAll, stopOfflineQueue);
		}}
	>
		<Icon name="trash" size={14} />
		{t.offline.stopAll}
	</button>
{/snippet}

{#snippet row(r: ManagerRow)}
	<div class="pack" class:held={r.state === 'ready'}>
		<div class="pack-main">
			<p class="pack-name">
				{#if r.state === 'ready'}
					<Icon name="check" size={13} />
				{/if}
				{r.name}
			</p>
			{#if r.note}
				<p class="muted pack-note">{r.note}</p>
			{/if}
			{#if r.meta.length > 0}
				<p class="muted pack-meta">{r.meta.join(', ')}</p>
			{/if}
			{#if r.state === 'running'}
				<div
					class="progress"
					role="progressbar"
					aria-label={t.offline.progressAria(r.name)}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={r.pct}
					aria-valuetext={r.meta.join(', ')}
				>
					<div class="progress-fill" style:width="{r.pct}%"></div>
				</div>
			{/if}
			{#if r.updateAvailable && r.state === 'ready'}
				<p class="muted pack-meta">{t.offline.updateAvailable}</p>
			{/if}
			{#if r.error}
				<p class="pack-fail" role="alert">{r.error}</p>
			{/if}
		</div>
		<div class="pack-actions">
			{#if r.state === 'running'}
				<button class="btn" onclick={r.onStop}>
					{r.stopVerb === 'pause' ? t.offline.pause : t.common.cancel}
				</button>
			{:else if r.state === 'queued'}
				<button class="btn" onclick={r.onStop}>{t.offline.removeFromQueue}</button>
			{:else}
				{#if r.canDownload && (r.state !== 'ready' || r.updateAvailable)}
					<button class="btn" onclick={r.onDownload}>
						{r.state === 'ready'
							? t.offline.update
							: r.state === 'paused'
								? t.offline.resume
								: r.state === 'error'
									? t.offline.retry
									: t.offline.download}
					</button>
				{/if}
				{#if r.onDelete}
					{@const del = r.onDelete}
					<button
						class="btn"
						onclick={() =>
							ask(
								r.state === 'paused'
									? t.offline.discardConfirm({
											name: r.name,
											size: formatPackBytes(r.heldBytes),
										})
									: r.key === 'terrain/plan'
										? t.offline.terrainRemoveConfirm
										: t.offline.deleteConfirm({
												name: r.name,
												size: formatPackBytes(r.heldBytes),
											}),
								r.state === 'paused' ? t.offline.discard : t.offline.delete,
								del,
							)}
					>
						{r.state === 'paused' ? t.offline.discard : t.offline.delete}
					</button>
				{/if}
			{/if}
		</div>
	</div>
{/snippet}

{#if confirm}
	<ConfirmDialog
		message={confirm.message}
		confirmLabel={confirm.label}
		danger
		onConfirm={runConfirm}
		onCancel={() => (confirm = null)}
	/>
{/if}

<style>
	/* The surface's own name never shrinks; the caption beside it elides
	   instead, the way the profile header treats its subtitle. Without this a
	   phone-width status line reduced the title to "O...". */
	h2 {
		flex: 0 0 auto;
		margin: 0;
	}

	/* The header's own status line, the VerticalProfileModal idiom. */
	.sub {
		min-width: 0;
		margin: 0;
		overflow: hidden;
		font-size: 12px;
		color: var(--text-muted);
		text-overflow: ellipsis;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}

	.sub.over {
		color: var(--danger);
	}

	:global(.modal-box.offline-box) {
		--modal-width: min(680px, 94vw);
	}

	.body {
		/* The rows collapse against the SURFACE box, not the viewport: this
		   opens docked, paged and full, all at different widths. Screen only,
		   so containment never touches a print flow. */
		container-type: inline-size;
		flex: 1;
		overflow-y: auto;
		padding: 14px 16px 18px;
		font-size: 13px;
		line-height: 1.5;
	}

	.pack {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: start;
		gap: 4px 10px;
		padding: 8px 0;
		border-top: 1px solid var(--border);
	}

	.pack:first-of-type {
		border-top: none;
	}

	.pack-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.pack-name {
		display: flex;
		align-items: center;
		gap: 5px;
		margin: 0;
		font-weight: 600;
	}

	.pack-note,
	.pack-meta {
		margin: 0;
		font-size: var(--fs-xs);
	}


	/* Prefixed: app.css has a global .error that would restyle a bare class. */
	.pack-fail {
		margin: 0;
		font-size: var(--fs-xs);
		color: var(--danger);
	}

	.pack-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}

	.usage {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 2px 10px;
		margin: 6px 0;
		font-size: var(--fs-xs);
	}

	.usage dt {
		color: var(--text-muted);
	}

	.usage dd {
		display: flex;
		align-items: center;
		gap: 8px;
		justify-content: flex-end;
		margin: 0;
		font-variant-numeric: tabular-nums;
	}

	@container (max-width: 420px) {
		/* Two 44px buttons and the widest chart product name do not share a
		   phone's line, so the actions drop under the label. */
		.pack {
			grid-template-columns: minmax(0, 1fr);
		}

		.pack-actions {
			justify-content: flex-start;
		}
	}
</style>
