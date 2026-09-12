<script lang="ts">
	import { BASE_LAYERS } from '$lib/map/baseLayers';
	import { availableChartLayers } from '$lib/map/chartOverlays';
	import {
		layers,
		toggleChartLayer,
		type AirspaceCategory,
		type ChartLayerId,
		type Publisher,
		type AirportGroup,
	} from '$lib/state/layers.svelte';
	import { AIRPORT, NAVAID, OBSTACLE_INK, SIA } from '$lib/map/palette';
	import { formatPackBytes } from '$lib/offline/packStore';
	import { ensurePackSizes, offlineCharts } from '$lib/state/offlineCharts.svelte';
	import { DOC_PACKS } from '$lib/offline/docPacks';
	import { ensureDocPackSizes, offlineDocs } from '$lib/state/offlineDocs.svelte';
	import {
		offlineManagerAvailable,
		offlineModal,
		toggleOffline,
	} from '$lib/state/offlineModal.svelte';
	import { dataState } from '$lib/state/data.svelte';
	import { vacGeoState } from '$lib/state/vacGeo.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import Segmented from '../Segmented.svelte';

	// The chart-layer list is build-dependent (production lists only layers
	// with a public source); the dev-only source radio below lets a dev
	// switch every layer between the public Worker and the local tile
	// server. import.meta.env.DEV is statically inlined, so the radio is
	// removed from production builds.
	// Key-only, so the labels stay read in the template (docs/i18n.md rule 2).
	const VAC_OPTS = [
		{ group: 'app', key: 'vacApp' },
		{ group: 'att', key: 'vacAtt' },
		{ group: 'gmc', key: 'vacGmc' },
	] as const;

	const devMode = import.meta.env.DEV;
	const chartLayers = availableChartLayers();

	/* Every download now lives in the offline manager surface
	 * (docs/offline-maps.md). What stays in this tab is the one thing that is
	 * a DISPLAY fact: which chart is drawn from the device rather than the
	 * network. The size HEADs went with the offer, since only the manager
	 * needs them. */

	const heldCharts = $derived(
		availableChartLayers().filter((d) => offlineCharts.packs[d.id]?.status === 'ready'),
	);
	const heldDocs = $derived(DOC_PACKS.filter((d) => offlineDocs.packs[d.id]?.status === 'ready'));
	const heldBytes = $derived(
		heldCharts.reduce((n, d) => n + (offlineCharts.packs[d.id]?.localBytes ?? 0), 0) +
			heldDocs.reduce((n, d) => n + (offlineDocs.packs[d.id]?.localBytes ?? 0), 0),
	);
	const heldCount = $derived(heldCharts.length + heldDocs.length);
	// The door's gate is the manager's own, shared with the toolbar and the
	// palette so the three cannot drift.
	const offlineEntry = $derived(offlineManagerAvailable());

	/* The size HEADs are also what compute `updateAvailable`, so they have to
	 * run wherever a NEW EDITION is announced and not only where it is acted
	 * on. Moving them into the manager alone left a pilot who never opens it
	 * unable to learn a chart had been re-published, which for an
	 * aeronautical chart is not a cosmetic loss. Idempotent: each archive is
	 * HEADed once per session. */
	$effect(() => {
		if (offlineEntry) {
			void ensurePackSizes();
			void ensureDocPackSizes();
		}
	});

	const updatesWaiting = $derived(
		heldCharts.filter((d) => offlineCharts.packs[d.id]?.updateAvailable).length +
			heldDocs.filter((d) => offlineDocs.packs[d.id]?.updateAvailable).length,
	);

	function packDate(id: ChartLayerId): string {
		return offlineCharts.packs[id]?.downloadedAt?.slice(0, 10) ?? '';
	}

	// Key-only structures; the labels live in t.layers and are read in the
	// template so a locale switch re-renders them (docs/i18n.md rule 2).
	// Legend swatches take the map symbols' own palette inks; the CSS
	// classes keep only shape hints. `closed` stays on the neutral UI grey:
	// the true closed ink (AIRPORT.closedInk) would vanish on night panels,
	// while ContextMenu's per-row airportSwatchColor keeps showing it.
	const SWATCH_INK: Record<string, string> = {
		airport: AIRPORT.civil,
		heliport: AIRPORT.civil,
		seaplane: AIRPORT.civil,
		balloon: AIRPORT.civil,
		'obstacle-wind': OBSTACLE_INK,
		'obstacle-other': OBSTACLE_INK,
		navaid: NAVAID.radionav,
		'navaid-ils': NAVAID.ils,
		'navaid-waypoint': NAVAID.waypoint,
		'navaid-reporting': NAVAID.radionav,
		nature: SIA.zone,
		sensitive: SIA.zone,
	};

	const AIRPORT_OPTS: { group: AirportGroup; sw: string }[] = [
		{ group: 'airports', sw: 'airport' },
		{ group: 'heliports', sw: 'heliport' },
		{ group: 'seaplane', sw: 'seaplane' },
		{ group: 'balloon', sw: 'balloon' },
		{ group: 'closed', sw: 'closed' },
	];

	const AIRSPACE_OPTS: AirspaceCategory[] = [
		'controlled',
		'restricted',
		'activity',
		'trafficmgmt',
		'transit',
		'siv',
		'fir',
	];

	// The dataset names (sub) are locale-invariant publisher vocabulary.
	const PUBLISHER_OPTS: { src: Publisher; sub: string }[] = [
		{ src: 'fr', sub: 'SIA AIXM 4.5' },
		{ src: 'uk', sub: 'NATS AIXM 5.1' },
		{ src: 'es', sub: 'ENAIRE AIXM 5.1' },
		// i18n-ignore: locale-invariant publisher + product name
		{ src: 'be', sub: 'skeyes eAIP' },
		// i18n-ignore: locale-invariant publisher + product name
		{ src: 'de', sub: 'DFS AIXM 5.1.1' },
		// i18n-ignore: locale-invariant publisher + product names
		{ src: 'at', sub: 'Austro Control KML + AIXM 5.1.1' },
		{ src: 'pruatlas', sub: 'EUROCONTROL pruatlas' },
		{ src: 'faa', sub: 'FAA Boundary + Class + SUA + NAVAID + DOF' },
		// i18n-ignore: upstream product name, invariant
		{ src: 'ge', sub: 'Sakaeronavigatsia AIXM 5.1.1' },
		// i18n-ignore: upstream product name, invariant
		{ src: 'nl', sub: 'LVNL open data' },
		// i18n-ignore: upstream product name, invariant
		{ src: 'ch', sub: 'FOCA obstacle register (AIXM)' },
		// i18n-ignore: upstream product name, invariant
		{ src: 'fi', sub: 'Fintraffic ANS obstacle register (Area 1)' },
		// i18n-ignore: upstream product name, invariant
		{ src: 'it', sub: 'open flightmaps OFMX (community)' },
		// i18n-ignore: upstream product name, invariant
		{ src: 'sk', sub: 'LPS SR eAIP' },
		// i18n-ignore: upstream product name, invariant
		{ src: 'ie', sub: 'AirNav Ireland eAIP' },
		// i18n-ignore: upstream product name, invariant
		{ src: 'rs', sub: 'SMATSA eAIP' },
		// i18n-ignore: upstream product name, invariant
		{ src: 'xk', sub: 'KANS eAIP' },
	];
</script>

<div class="tab-panel">
	<h2>{t.layers.title}</h2>

	<fieldset class="group">
		<legend>{t.layers.baseMap}</legend>
		{#each BASE_LAYERS as base (base.id)}
			<label class="check">
				<input
					type="radio"
					name="base-layer"
					value={base.id}
					checked={layers.baseLayer === base.id}
					onchange={() => (layers.baseLayer = base.id)}
				/>
				<span>{base.label}</span>
			</label>
		{/each}
	</fieldset>

	<fieldset class="group">
		<legend>{t.layers.aeroChart}</legend>
		{#if devMode}
			<!-- i18n-ignore-start: dev-only source selector, stripped from production
			     builds. -->
			<div class="source-grid">
				<span title="Where the chart tiles come from">Tile source</span>
				<Segmented
					options={[
						{ value: 'public', label: 'Public', title: 'Public Cloudflare Worker' },
						{ value: 'local', label: 'Local', title: 'Local oaci-wmts (:8080)' },
					]}
					value={layers.chartSource}
					onSelect={(v) => (layers.chartSource = v as 'public' | 'local')}
					ariaLabel="Tile source"
				/>
			</div>
			<!-- i18n-ignore-end -->
		{/if}
		{#each chartLayers as def (def.id)}
			{@const unavailable = devMode && !def.sources[layers.chartSource]}
			{@const held = offlineCharts.packs[def.id]?.status === 'ready'}
			<label class="check" class:muted={unavailable}>
				<input
					type="checkbox"
					checked={layers.chartStack.includes(def.id)}
					disabled={unavailable}
					onchange={() => toggleChartLayer(def.id)}
				/>
				<span>{def.label}</span>
				{#if held}
					<!-- Provenance, not a control: which chart is drawn from the
					     device rather than the network is a DISPLAY fact, and
					     this is the display tab. It rides the label line, so it
					     costs no height. Downloading and deleting live in the
					     offline manager. -->
					<span class="held-chip" title={t.offline.heldChipTip(packDate(def.id))}>
						{t.offline.heldChip}
					</span>
				{/if}
			</label>
			<p class="muted">{t.layers[def.coverageKey]}</p>
		{/each}
		{#if offlineEntry}
			<div class="offline-entry">
				<button
					class="btn"
					class:on={offlineModal.open}
					aria-pressed={offlineModal.open}
					onclick={() => toggleOffline()}
				>
					{t.offline.manage}
				</button>
				<span class="muted">
					{heldCount > 0
						? t.offline.heldSummary({
								packs: heldCount,
								size: formatPackBytes(heldBytes),
							})
						: t.offline.nothingHeld}
				</span>
				{#if updatesWaiting > 0}
					<!-- The passive signal a new chart edition exists, at the
					     place a pilot looks at their charts. Acting on it is
					     the manager's job; saying so is this tab's. -->
					<span class="updates-chip">{t.offline.updatesAvailable(updatesWaiting)}</span>
				{/if}
			</div>
		{/if}
	</fieldset>

	<fieldset class="group">
		<legend>{t.layers.vacLegend}</legend>
		{#each VAC_OPTS as opt (opt.group)}
			<label class="check">
				<input type="checkbox" bind:checked={layers.vac[opt.group]} />
				<span>{t.layers[opt.key]}</span>
			</label>
		{/each}
		{#if vacGeoState.loading}
			<p class="status">{t.layers.loading}</p>
		{:else if vacGeoState.error}
			<p class="status error" role="alert">{t.layers.vacFailed}</p>
		{:else if vacGeoState.aerodromes > 0}
			<p class="muted">{t.layers.vacCoverage(vacGeoState.aerodromes)}</p>
		{/if}
		<p class="muted">{t.layers.vacNote}</p>
	</fieldset>

	<fieldset class="group">
		<legend>{t.layers.airports}</legend>
		{#each AIRPORT_OPTS as opt (opt.group)}
			<label class="check">
				<input type="checkbox" bind:checked={layers.airportTypes[opt.group]} />
				<span class="swatch swatch--{opt.sw}" style:background={SWATCH_INK[opt.sw]}></span>
				<span>{t.layers.airportGroups[opt.group]}</span>
			</label>
		{/each}
		{#if dataState.airportsLoading}
			<p class="status">{t.layers.loadingAirports}</p>
		{:else if dataState.airportsError}
			<p class="status error" role="alert">{t.layers.airportsFailed}</p>
		{/if}
	</fieldset>

	<fieldset class="group">
		<legend>{t.layers.airspaces}</legend>
		{#each AIRSPACE_OPTS as cat (cat)}
			<label class="check">
				<input type="checkbox" bind:checked={layers.airspace[cat]} />
				<span class="swatch swatch--{cat}"></span>
				<span>{t.layers.airspaceCategories[cat]}</span>
			</label>
		{/each}
		<label class="check labels-row">
			<input type="checkbox" bind:checked={layers.airspaceLabels} />
			<span>{t.layers.designatorLabels}</span>
		</label>
		{#if dataState.airspacesLoading}
			<p class="status">{t.layers.loadingAirspaces}</p>
		{:else if dataState.airspacesError}
			<p class="status error" role="alert">{t.layers.airspacesFailed}</p>
		{/if}
	</fieldset>

	<fieldset class="group">
		<legend>{t.layers.obstacles}</legend>
		<label class="check">
			<input type="checkbox" bind:checked={layers.obstacles.windturbines} />
			<span class="swatch swatch--obstacle-wind" style:background={SWATCH_INK['obstacle-wind']}></span>
			<span>{t.layers.windTurbines}</span>
		</label>
		<label class="check">
			<input type="checkbox" bind:checked={layers.obstacles.other} />
			<span class="swatch swatch--obstacle-other" style:background={SWATCH_INK['obstacle-other']}></span>
			<span>{t.layers.otherObstacles}</span>
		</label>
		{#if dataState.obstaclesLoading}
			<p class="status">{t.layers.loadingObstacles}</p>
		{:else if dataState.obstaclesError}
			<p class="status error" role="alert">{t.layers.obstaclesFailed}</p>
		{/if}
		<p class="muted">{t.layers.visibleFromZoom(9)}</p>
	</fieldset>

	<fieldset class="group">
		<legend>{t.layers.navaids}</legend>
		<label class="check">
			<input type="checkbox" bind:checked={layers.navaids.navaids} />
			<span class="swatch swatch--navaid" style:background={SWATCH_INK['navaid']}></span>
			<span>{t.layers.navaidsAll}</span>
		</label>
		<label class="check">
			<input type="checkbox" bind:checked={layers.navaids.ils} />
			<span class="swatch swatch--navaid-ils" style:background={SWATCH_INK['navaid-ils']}></span>
			<span>ILS / LOC</span>
		</label>
		<label class="check">
			<input type="checkbox" bind:checked={layers.navaids.waypoints} />
			<span class="swatch swatch--navaid-waypoint" style:background={SWATCH_INK['navaid-waypoint']}></span>
			<span>{t.layers.waypoints}</span>
		</label>
		<label class="check">
			<input type="checkbox" bind:checked={layers.navaids.reporting} />
			<span class="swatch swatch--navaid-reporting" style:background={SWATCH_INK['navaid-reporting']}></span>
			<span>{t.layers.reportingPoints}</span>
		</label>
		{#if dataState.navaidsLoading}
			<p class="status">{t.layers.loadingNavaids}</p>
		{:else if dataState.navaidsError}
			<p class="status error" role="alert">{t.layers.navaidsFailed}</p>
		{/if}
		<p class="muted">{t.layers.navaidZoomNote}</p>
	</fieldset>

	<fieldset class="group">
		<legend>{t.layers.natureLegend}</legend>
		<label class="check">
			<input type="checkbox" bind:checked={layers.nature.nature} />
			<span class="swatch swatch--nature" style:background={SWATCH_INK.nature}></span>
			<span>{t.data.natureTypes.NATURE}</span>
		</label>
		<label class="check">
			<input type="checkbox" bind:checked={layers.nature.bird} />
			<span class="swatch swatch--nature" style:background={SWATCH_INK.nature}></span>
			<span>{t.data.natureTypes.BIRD}</span>
		</label>
		{#if dataState.natureLoading}
			<p class="status">{t.layers.loading}</p>
		{:else if dataState.natureError}
			<p class="status error" role="alert">{t.layers.loadFailed}</p>
		{/if}
		<p class="muted">{t.layers.visibleFromZoom(7)}</p>
	</fieldset>

	<fieldset class="group">
		<legend>{t.layers.sensitiveSites}</legend>
		<label class="check">
			<input type="checkbox" bind:checked={layers.nature.sensitive} />
			<span class="swatch swatch--sensitive" style:background={SWATCH_INK['sensitive']}></span>
			<span>{t.data.natureTypes.SENSITIVE}</span>
		</label>
	</fieldset>

	<fieldset class="group">
		<legend>SUP AIP</legend>
		<label class="check">
			<input type="checkbox" bind:checked={layers.supaip} />
			<span class="swatch swatch--supaip"></span>
			<span>{t.layers.supaipAreas}</span>
		</label>
		{#if dataState.supaipLoading}
			<p class="status">{t.layers.loadingSupaip}</p>
		{:else if dataState.supaipError}
			<p class="status error" role="alert">{t.layers.supaipFailed}</p>
		{/if}
		<p class="muted">{t.layers.supaipNote}</p>
	</fieldset>

	<fieldset class="group">
		<legend>{t.layers.publishers}</legend>
		{#each PUBLISHER_OPTS as opt (opt.src)}
			<label class="check">
				<input
					type="checkbox"
					bind:checked={layers.publisher[opt.src]}
				/>
				<span class="src-label">
					{t.layers.publisherNames[opt.src]}
					<span class="src-sub">{opt.sub}</span>
				</span>
			</label>
		{/each}
	</fieldset>
</div>

<style>
	/* The offline chip: provenance on the label line, never a control. */
	.held-chip {
		flex: 0 0 auto;
		padding: 0 5px;
		font-size: var(--fs-2xs);
		line-height: 1.5;
		color: var(--text-muted);
		border: 1px solid var(--border);
		border-radius: 999px;
	}

	.updates-chip {
		padding: 0 5px;
		font-size: var(--fs-2xs);
		line-height: 1.5;
		color: var(--accent);
		border: 1px solid var(--accent);
		border-radius: 999px;
	}

	.offline-entry {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 8px;
		margin-top: 6px;
		font-size: var(--fs-xs);
	}

	.swatch {
		flex: 0 0 auto;
		width: 11px;
		height: 11px;
		border-radius: 2px;
	}

	/* A document set's name, sitting where a chart layer's checkbox label
	   does: these rows have nothing to toggle, only to download. */

	/* The designator-labels toggle sits apart from the category list. */
	.labels-row {
		margin-top: 4px;
		padding-top: 8px;
		border-top: 1px solid var(--border);
	}

	.swatch--controlled {
		background: var(--airspace-controlled);
	}

	.swatch--restricted {
		background: var(--airspace-restricted);
	}

	.swatch--activity {
		background: var(--airspace-activity);
	}

	.swatch--trafficmgmt {
		background: var(--airspace-trafficmgmt);
	}

	.swatch--transit {
		background: var(--airspace-transit);
	}

	.swatch--siv {
		background: var(--airspace-siv);
	}

	.swatch--fir {
		background: var(--airspace-fir);
	}

	/* Obstacle / navaid / nature / airport swatch INKS come inline from the
	   palette (SWATCH_INK above), so the legend can no longer drift from
	   the canvas; only shape hints stay here: round hints the park/reserve
	   circle glyph, square the sensitive-site one. */
	.swatch--nature {
		border-radius: 50%;
	}

	.swatch--sensitive {
		border-radius: 1px;
	}

	.swatch--supaip {
		background: var(--supaip);
	}

	/* Deliberate deviation: the closed-aerodrome chip keeps the neutral UI
	   grey (the true closed ink #1D1D1B would vanish on night panels). */
	.swatch--closed {
		background: var(--status-neutral);
	}

	.status {
		margin: 4px 0 0;
		font-size: 12px;
		color: var(--text-muted);
	}

	.status.error {
		color: var(--danger);
	}

	.src-label {
		display: flex;
		flex-direction: column;
		line-height: 1.2;
	}

	.src-sub {
		font-size: 10px;
		color: var(--text-muted);
	}

	/* Dev-only tile-source selector row. */
	.source-grid {
		display: grid;
		grid-template-columns: auto auto;
		align-items: center;
		justify-content: start;
		gap: 8px;
		padding: 4px 0;
	}

	.source-grid :global(.seg) {
		justify-self: end;
	}
</style>
