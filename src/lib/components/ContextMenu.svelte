<script lang="ts">
	import { decodeQ, t } from '$lib/state/i18n.svelte';

	function airspaceTypeName(type: string): string {
		return (t.data.airspaceTypes as Record<string, string>)[type] ?? type;
	}

	// Same widened lookup for the open airport-type field, falling back to
	// the canonical English helper (the AirportDetail pattern).
	function airportTypeName(type: string): string {
		return (t.data.airportTypes as Record<string, string>)[type] ?? prettyAirportType(type);
	}
	import { contextMenu, closeContextMenu } from '$lib/state/contextMenu.svelte';
	import { pinVacChart, previewVacChart, vacPin } from '$lib/state/vacPin.svelte';
	import { hoverFeature, clearHover } from '$lib/map/selectionHighlight';
	import { airportSwatchColor } from '$lib/map/airportSymbols';
	import { hoverSupaipZone } from '$lib/map/supaipLayer';
	import { hoverSigmet } from '$lib/map/sigmetLayer';
	import { sigmetRings } from '$lib/state/sigmets.svelte';
	import { HAZARD_STYLES, sigmetLabel, type Sigmet } from '$lib/weather/sigmet';
	import { NAVAID_COLOR } from '$lib/map/navaidSymbols';
	import { STATION_CAT_COLORS, STATION_NO_CAT_COLOR } from '$lib/map/metarLayer';
	import { stationName } from '$lib/weather/metar';
	import type { MapStation } from '$lib/state/metarStations.svelte';
	import {
		selectAirspace,
		selectAirport,
		selectNotam,
		selectObstacle,
		selectNavaid,
		selectSupaip,
		selectSigmet,
		selectStation,
	} from '$lib/state/ui.svelte';
	import { airspacesOver, isZoneType } from '$lib/data/airspaces';
	import { formatVLimit } from '$lib/vertical/limits';
	import { OBSTACLE_LABELS, obstacleGroup } from '$lib/data/obstacles';
	import { NAVAID_LABELS, navaidFreqLabel } from '$lib/data/navaids';
	import { unserviceableNavaids } from '$lib/state/notamNavaidLinks.svelte';
	import { prettyAirportType } from '$lib/data/airports';
	import { notamsByIdent } from '$lib/state/notam.svelte';
	import { getAirspaces } from '$lib/state/data.svelte';
	import { notamsForAirspace } from '$lib/state/notamLinks.svelte';
	import { profileAirspaces } from '$lib/state/profile.svelte';
	import { openMapProfile } from '$lib/state/mapProfileModal.svelte';
	import { formatCoord } from '$lib/format/coord';
	import { copyText } from '$lib/ui/clipboard';
	import { snapLatLng } from '$lib/map/routeLayer';
	import {
		addWaypoint,
		addWaypointFromSnap,
		insertWaypointAfter,
		removeWaypoint,
		selectWaypoint,
		type Waypoint,
	} from '$lib/state/route.svelte';
	import Icon from './Icon.svelte';
	import PopupMenu from './PopupMenu.svelte';

	// The click point, captured when the menu opened, so copying it can't
	// drift as the cursor moves up to the action.
	const coord = $derived(formatCoord(contextMenu.lat, contextMenu.lng));

	// Navaids an active NOTAM currently marks unserviceable, for the U/S badge.
	const navaidsUs = $derived(unserviceableNavaids());

	// Airspace stack at the click point for the "Altitude profile" action,
	// honouring the global all-vs-on-map toggle so the action's count matches
	// what the modal plots. Independent of the visible "Airspaces" list below.
	const profileStack = $derived(
		profileAirspaces(airspacesOver(getAirspaces() ?? [], contextMenu.lat, contextMenu.lng)),
	);

	// On mouseleave, clearHover (map/selectionHighlight) restores the
	// highlight that reflects the panel's current selection; mirrors the
	// original AirspaceMenu behaviour.

	function onSelectAirspace(key: string): void {
		selectAirspace(key);
		closeContextMenu();
	}

	function onSelectAirport(ident: string): void {
		selectAirport(ident);
		closeContextMenu();
	}

	function onSelectStation(st: MapStation): void {
		const m = st.metar;
		selectStation({ id: m.icaoId, lat: m.lat, lon: m.lon, name: m.name ?? undefined });
		closeContextMenu();
	}

	/** A chart is not a selection: it has no detail panel, only a place in
	 *  the stack. The row brings it to the top, or lets go if it is already
	 *  the one pinned. */
	function onPinChart(ident: string): void {
		pinVacChart(ident);
		closeContextMenu();
	}

	// The preview follows the pointer down the rows, and the MENU CLOSING is
	// what ends it. A row leaving is not enough: the menu can go on Escape or
	// on a click outside without the pointer ever leaving a row, and an
	// element removed under a still pointer fires no mouseleave, which would
	// strand the wrong chart on top of the map for good.
	$effect(() => {
		if (!contextMenu.open) {
			previewVacChart(null);
		}
	});

	function onSelectNotam(index: number): void {
		selectNotam(index);
		closeContextMenu();
	}

	function onSelectObstacle(id: string): void {
		selectObstacle(id);
		closeContextMenu();
	}

	function onSelectNavaid(id: string): void {
		selectNavaid(id);
		closeContextMenu();
	}

	function onSelectSupaip(id: string, zone: number): void {
		selectSupaip(id, zone);
		hoverSupaipZone(null);
		closeContextMenu();
	}

	function onSelectSigmet(s: Sigmet): void {
		selectSigmet(s.id);
		hoverSigmet(null);
		closeContextMenu();
	}

	function onShowProfile(): void {
		openMapProfile(contextMenu.lat, contextMenu.lng);
		closeContextMenu();
	}

	function onCopyCoords(): void {
		void copyText(coord.decimal);
		closeContextMenu();
	}

	function onAddWaypoint(): void {
		const snap = snapLatLng(contextMenu.lat, contextMenu.lng);
		if (snap) {
			addWaypointFromSnap(snap);
		} else {
			addWaypoint(contextMenu.lat, contextMenu.lng);
		}
		closeContextMenu();
	}

	function onInsertWaypoint(index: number | null): void {
		if (index === null) {
			return;
		}
		const snap = snapLatLng(contextMenu.lat, contextMenu.lng);
		const wp = insertWaypointAfter(
			index,
			snap ?? { lat: contextMenu.lat, lon: contextMenu.lng, kind: 'free' },
		);
		selectWaypoint(wp.id);
		closeContextMenu();
	}

	function onRemoveWaypoint(id: string): void {
		removeWaypoint(id);
		closeContextMenu();
	}

	// Label the remove row by the waypoint's ident / name when it has one
	// (anchored or user-named); a bare free point is just "Remove waypoint".
	function removeLabel(wp: Waypoint): string {
		const name = wp.ident ?? wp.label;
		return name ? t.map.removeWaypointNamed(name) : t.map.removeWaypoint;
	}
</script>

<PopupMenu
	open={contextMenu.open}
	x={contextMenu.x}
	y={contextMenu.y}
	onClose={closeContextMenu}
>
		<button
			class="item action"
			onclick={onCopyCoords}
			title={t.map.copyCoordsTip}
		>
			<Icon name="crosshair" size={14} />
			<span class="action-label">{t.map.copyCoords}</span>
			<span class="coord-val">{coord.decimal}</span>
		</button>
		<button
			class="item action"
			onclick={onAddWaypoint}
			title={t.map.addWaypointTip}
		>
			<Icon name="route" size={14} />
			<span class="action-label">{t.map.addWaypoint}</span>
		</button>
		{#if contextMenu.leg !== null}
			<button
				class="item action"
				onclick={() => onInsertWaypoint(contextMenu.leg)}
				title={t.map.insertWaypointTip}
			>
				<Icon name="route" size={14} />
				<span class="action-label">{t.map.insertWaypoint}</span>
			</button>
		{/if}
		{#each contextMenu.waypoints as wp (wp.id)}
			<button
				class="item action danger"
				onclick={() => onRemoveWaypoint(wp.id)}
				title={t.map.removeWaypointTip}
			>
				<Icon name="trash" size={14} />
				<span class="action-label">{removeLabel(wp)}</span>
			</button>
		{/each}
		{#if profileStack.length > 0}
			<button
				class="item action"
				onclick={onShowProfile}
				title={t.map.altitudeProfileTip}
			>
				<Icon name="profile" size={14} />
				<span class="action-label">{t.map.altitudeProfile(profileStack.length)}</span>
			</button>
		{/if}
		{#if contextMenu.notams.length > 0}
			<div class="section-title">
				{t.map.notamsHeading(contextMenu.notams.length)}
			</div>
			{#each contextMenu.notams as it (it.index)}
				{@const decoded = decodeQ(it.notam.qCode)}
				<button
					class="item"
					onmouseenter={() => hoverFeature('notam', it.index)}
					onmouseleave={clearHover}
					onclick={() => onSelectNotam(it.index)}
					title={it.notam.fullContent.slice(0, 240)}
				>
					<span class="id">{it.notam.id}</span>
					{#if it.notam.qCode}
						<span class="qcode">{it.notam.qCode}</span>
					{/if}
					<span class="decoded">{decoded || '–'}</span>
				</button>
			{/each}
		{/if}
		{#if contextMenu.stations.length > 0}
			<div class="section-title">
				{t.map.stationsHeading(contextMenu.stations.length)}
			</div>
			{#each contextMenu.stations as st (st.metar.icaoId)}
				<button class="item" onclick={() => onSelectStation(st)}>
					<span
						class="swatch swatch--station"
						style:background={st.cat ? STATION_CAT_COLORS[st.cat] : STATION_NO_CAT_COLOR}
					></span>
					<span class="id">{st.metar.icaoId}</span>
					{#if st.cat}
						<span class="type">{st.cat}</span>
					{/if}
					<span class="name">{stationName(st.metar.name)}</span>
				</button>
			{/each}
		{/if}
		{#if contextMenu.charts.length > 0}
			<div class="section-title">
				{t.map.chartsHeading(contextMenu.charts.length)}
			</div>
			{#each contextMenu.charts as ch (ch.ident)}
				<button
					class="item"
					onmouseenter={() => previewVacChart(ch.ident)}
					onmouseleave={() => previewVacChart(null)}
					onclick={() => onPinChart(ch.ident)}
				>
					<span class="swatch swatch--chart"></span>
					<span class="id">{ch.ident}</span>
					<span class="type">{ch.kinds.join(' ')}</span>
					<span class="name">
						{vacPin.ident === ch.ident ? t.map.unpinChart : t.map.pinChart}
					</span>
				</button>
			{/each}
		{/if}
		{#if contextMenu.airports.length > 0}
			<div class="section-title">
				{t.map.airportsHeading(contextMenu.airports.length)}
			</div>
			{#each contextMenu.airports as ap (ap.ident)}
				{@const notamCount =
					notamsByIdent().get(ap.ident.toUpperCase())?.length ?? 0}
				{@const dot = airportSwatchColor(ap)}
				<button
					class="item"
					onmouseenter={() => hoverFeature('airport', ap.ident)}
					onmouseleave={clearHover}
					onclick={() => onSelectAirport(ap.ident)}
				>
					<span
						class="swatch swatch--airport"
						style:background={dot}
						style:border-color={dot}
					></span>
					<span class="id">{ap.ident}</span>
					<span class="type">{airportTypeName(ap.type)}</span>
					{#if notamCount > 0}
						<span
							class="notam-count"
							title={t.map.notamCount(notamCount)}
						>{notamCount}</span>
					{/if}
					<span class="name">{ap.name}</span>
				</button>
			{/each}
		{/if}
		{#if contextMenu.navaids.length > 0}
			<div class="section-title">
				{t.map.navaidsHeading(contextMenu.navaids.length)}
			</div>
			{#each contextMenu.navaids as n (n.id)}
				<button
					class="item"
					onmouseenter={() => hoverFeature('navaid', n.id)}
					onmouseleave={clearHover}
					onclick={() => onSelectNavaid(n.id)}
				>
					<span class="swatch" style:background={NAVAID_COLOR[n.type]}></span>
					<span class="id">{n.ident}</span>
					<span class="type">{NAVAID_LABELS[n.type] ?? n.type}</span>
					{#if navaidsUs.has(n.id)}
						<span class="us-badge" title={t.map.unserviceable}>U/S</span>
					{/if}
					{#if navaidFreqLabel(n)}
						<span class="band">{navaidFreqLabel(n)}</span>
					{/if}
					<span class="name">{n.name}</span>
				</button>
			{/each}
		{/if}
		{#if contextMenu.airspaces.length > 0}
			<div class="section-title">
				{t.map.airspacesHeading(contextMenu.airspaces.length)}
			</div>
			{#each contextMenu.airspaces as a, i (i)}
				{@const notamCount = notamsForAirspace(a.id).length}
				<button
					class="item"
					onmouseenter={() => hoverFeature('airspace', a.key)}
					onmouseleave={clearHover}
					onclick={() => onSelectAirspace(a.key)}
				>
					<span class="swatch swatch--{a.category}"></span>
					<span class="id">{a.id}</span>
					{#if a.airClass}
						<span class="cls">{a.airClass}</span>
					{/if}
					{#if isZoneType(a.type)}
						<span class="zone-badge" title={airspaceTypeName(a.type)}>{a.type}</span>
					{:else}
						<span class="type">{a.type}</span>
					{/if}
					{#if notamCount > 0}
						<span
							class="notam-count"
							title={t.map.notamCount(notamCount)}
						>{notamCount}</span>
					{/if}
					<span class="name">{a.name}</span>
					<span class="band">
						{formatVLimit(a.vLower)} – {formatVLimit(a.vUpper)}
					</span>
				</button>
			{/each}
		{/if}
		{#if contextMenu.obstacles.length > 0}
			<div class="section-title">
				{t.map.obstaclesHeading(contextMenu.obstacles.length)}
			</div>
			{#each contextMenu.obstacles as o (o.id)}
				<button
					class="item"
					onmouseenter={() => hoverFeature('obstacle', o.id)}
					onmouseleave={clearHover}
					onclick={() => onSelectObstacle(o.id)}
				>
					<span class="swatch swatch--obstacle-{obstacleGroup(o.type)}"></span>
					<span class="id">{o.name}</span>
					<span class="type">{OBSTACLE_LABELS[o.type]}</span>
					{#if o.hgt != null}
						<span class="band">{o.hgt} ft AGL</span>
					{/if}
				</button>
			{/each}
		{/if}
		{#if contextMenu.supaips.length > 0}
			<div class="section-title">
				{t.map.supaipHeading(contextMenu.supaips.length)}
			</div>
			{#each contextMenu.supaips as it (it.sup.id + ':' + it.zoneIndex)}
				<button
					class="item"
					onmouseenter={() => hoverSupaipZone(it.zone.geometry)}
					onmouseleave={() => hoverSupaipZone(null)}
					onclick={() => onSelectSupaip(it.sup.id, it.zoneIndex)}
				>
					<span class="swatch swatch--supaip"></span>
					<span class="id">{it.sup.title}</span>
					<span class="name">{it.zone.name || it.sup.region}</span>
					{#if it.zone.vLower || it.zone.vUpper}
						<span class="band">
							{formatVLimit(it.zone.vLower)} – {formatVLimit(it.zone.vUpper)}
						</span>
					{/if}
				</button>
			{/each}
		{/if}
		{#if contextMenu.sigmets.length > 0}
			<div class="section-title">
				{t.map.sigmetsHeading(contextMenu.sigmets.length)}
			</div>
			{#each contextMenu.sigmets as s (s.id)}
				<button
					class="item"
					onmouseenter={() => hoverSigmet({ sigmet: s, rings: sigmetRings(s) })}
					onmouseleave={() => hoverSigmet(null)}
					onclick={() => onSelectSigmet(s)}
				>
					<span class="swatch" style:background={HAZARD_STYLES[s.hazard].color}></span>
					<span class="id">{sigmetLabel(s, t.weather.sigmet)}</span>
					<span class="name">{s.firName ?? s.fir ?? ''}</span>
				</button>
			{/each}
		{/if}
</PopupMenu>

<style>
	/* Every section opens with its own divider line: the action rows always
	   precede the first section, so the rule needs no sibling conditions. */
	.section-title {
		margin: 4px 4px 0;
		padding: 8px 4px 6px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
		border-top: 1px solid var(--border);
	}

	/* "Altitude profile" action row at the top of the menu when there
	 * are airspaces at the click point. Accent colour distinguishes it
	 * from the regular selection rows below. */
	.item.action {
		color: var(--accent);
		font-weight: 600;
	}

	/* Destructive variant for the "Remove waypoint" action row. More specific
	 * than .item.action, so it overrides the accent colour; the Icon inherits
	 * currentColor and turns red too. */
	.item.action.danger {
		color: var(--danger);
	}

	.action-label {
		font-size: 12px;
	}

	/* The clicked coordinate, right-aligned on the copy row. Muted and
	 * normal-weight to read as a value, not part of the accent action label. */
	.coord-val {
		flex: 1;
		text-align: right;
		font-family: ui-monospace, monospace;
		font-size: 11px;
		font-weight: 400;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	.swatch {
		flex: 0 0 auto;
		width: 10px;
		height: 10px;
		border-radius: 2px;
	}

	.swatch--controlled {
		background: var(--airspace-controlled);
	}

	.swatch--restricted {
		background: var(--airspace-restricted);
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

	.swatch--activity {
		background: var(--airspace-activity);
	}

	.swatch--trafficmgmt {
		background: var(--airspace-trafficmgmt);
	}

	.swatch--obstacle-windturbines {
		background: var(--obstacle-windturbines);
	}

	.swatch--obstacle-other {
		background: var(--obstacle-other);
	}

	.swatch--supaip {
		background: var(--supaip);
	}

	/* A sheet of paper: the chart rows are the only ones that stand for a
	   drawn document rather than a feature of the airspace. */
	.swatch--chart {
		background: var(--surface);
		border: 1px solid var(--text-muted);
	}

	/* Round swatch for airports; fill + border come from inline style
	   so each row renders in its own airportSwatchColor() status colour. */
	.swatch--airport {
		border-radius: 50%;
		border-style: solid;
		border-width: 1px;
	}

	/* Round dot for METAR stations, filled with the flight-category colour. */
	.swatch--station {
		border-radius: 50%;
	}

	.id {
		flex: 0 0 auto;
		font-family: ui-monospace, monospace;
		font-size: 12px;
		font-weight: 700;
	}

	.type {
		font-weight: 600;
		font-size: 12px;
		color: var(--text-muted);
	}

	.qcode {
		flex: 0 0 auto;
		padding: 1px 5px;
		font-family: ui-monospace, monospace;
		font-size: 11px;
		font-weight: 600;
		background: var(--surface-3);
		border-radius: 3px;
	}

	.decoded {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		color: var(--text-muted);
	}

	.cls,
	.zone-badge {
		flex: 0 0 auto;
		min-width: 16px;
		padding: 1px 4px;
		font-size: 11px;
		font-weight: 700;
		text-align: center;
		color: var(--accent-text);
		border-radius: 3px;
	}

	.cls {
		background: var(--accent);
	}

	/* R / D / P special-use zones: the designator as a letter in the
	 * restricted-airspace red, matching the vertical-profile column badge. */
	.zone-badge {
		background: var(--airspace-restricted);
	}

	.notam-count {
		flex: 0 0 auto;
		min-width: 16px;
		padding: 1px 5px;
		font-size: 11px;
		font-weight: 700;
		text-align: center;
		color: #fff;
		background: var(--notam-cue, #d35400);
		border-radius: 999px;
	}

	.us-badge {
		flex: 0 0 auto;
		padding: 1px 5px;
		font-size: 10px;
		font-weight: 700;
		color: #fff;
		background: var(--danger);
		border-radius: 999px;
	}

	.name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
	}

	.band {
		flex: 0 0 auto;
		font-size: 11px;
		color: var(--text-muted);
	}
</style>
