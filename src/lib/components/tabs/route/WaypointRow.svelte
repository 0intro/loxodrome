<script lang="ts">
	/* One waypoint of the Route tab's list (number disc, name, controls) plus
	 * its leg connector row (track / distance, altitude input with FL
	 * handling, reset cue, semicircular warning, level-advisor chip, W/V chip
	 * with the inline override editor). The list-level drag state stays in
	 * RouteTab (one place); the row only reports its own dragstart / dragend
	 * and wears the flags. */
	import Icon from '../../Icon.svelte';
	import WaypointWindEditor from './WaypointWindEditor.svelte';
	import type { LegView } from './legView';
	import { t } from '$lib/state/i18n.svelte';
	import { inputValue } from '$lib/ui/dom';
	import { mapState } from '$lib/state/map.svelte';
	import { flyToVisible } from '$lib/map/focus';
	import { ui } from '$lib/state/ui.svelte';
	import {
		activeRoute,
		routeSettings,
		removeWaypoint,
		reorderWaypoint,
		setWaypointAltitude,
		resetWaypointAltitudeAuto,
		setWaypointName,
		selectWaypoint,
		MAX_LEG_ALT_FT,
		type Waypoint,
	} from '$lib/state/route.svelte';
	import { effectiveTransitionAltFt } from '$lib/state/transitionAlt.svelte';
	import { legHover, hoverLeg, unhoverLeg } from '$lib/state/legHover.svelte';
	import { fmtNM, fmtTrack, isFlightLevelAt } from '$lib/route/format';
	import { formatGarminCoord } from '$lib/route/coordToken';
	import { SHEAR_ADVISORY_KT_PER_1000FT } from '$lib/route/legWind';

	interface Props {
		wp: Waypoint;
		i: number;
		/** This row is the one being dragged. */
		dragging: boolean;
		/** The list-level drop gap sits just before / after this row. */
		dropBefore: boolean;
		dropAfter: boolean;
		/** The number disc's dragstart / dragend, resolved by RouteTab's
		 *  list-level dnd (the taller leg rows must not be dead zones). */
		onDragStart: (e: DragEvent) => void;
		onDragEnd: () => void;
		/** Pointing at this row (mouse or focus), so RouteTab's list-level hover
		 *  can flash the waypoint's pin on the map; null on leaving. */
		onHover: (wp: Waypoint | null) => void;
		/** The leg leaving this waypoint; null on the last row. */
		leg: LegView | null;
	}
	const {
		wp,
		i,
		dragging,
		dropBefore,
		dropAfter,
		onDragStart,
		onDragEnd,
		onHover,
		leg,
	}: Props = $props();

	const count = $derived(activeRoute().waypoints.length);

	// Effective transition altitude: the manual override when set, else the
	// AIP-derived automatic value (state/transitionAlt.svelte.ts).
	const effTa = $derived(effectiveTransitionAltFt());

	// The leg-altitude field's unit (ft vs FL) is frozen while it has focus:
	// the oninput echo would otherwise flip the unit mid-edit (typing FL "65"
	// would reread as 65 ft) and rewrite the field under the user's caret.
	// Flight levels appear only with the semicircular option on; off keeps
	// the historical plain-feet field everywhere. Focus is exclusive, so the
	// frozen unit can live per row.
	let editFl = $state<boolean | null>(null);
	const fl = $derived(editFl ?? (routeSettings.semicircular && isFlightLevelAt(wp.alt, effTa)));

	const ROLE_FILL = { start: '#2e7d32', end: '#c62828', mid: '#1f5fbf' };
	function roleColor(idx: number, total: number): string {
		return idx === 0 ? ROLE_FILL.start : idx === total - 1 ? ROLE_FILL.end : ROLE_FILL.mid;
	}

	// Both called from the template, so their t.* reads are tracked.
	function wpTitle(w: Waypoint): string {
		return w.ident || t.route.customPoint;
	}
	function wpSub(w: Waypoint): string {
		if (w.kind === 'free') {
			return formatGarminCoord(w.lat, w.lon);
		}
		const kind = w.kind === 'airport' ? t.route.kindAirport : t.route.kindNavaid;
		return [w.label, kind].filter(Boolean).join(' · ');
	}

	function flyTo(w: Waypoint): void {
		flyToVisible(
			{ lat: w.lat, lng: w.lon },
			Math.max(mapState.map?.getZoom() ?? 10, 10),
		);
		if (ui.isMobile) {
			ui.sidebarCollapsed = true;
		}
	}

	function onSelectWaypoint(w: Waypoint): void {
		selectWaypoint(w.id);
		flyTo(w);
	}

	function onAltInput(e: Event): void {
		const v = parseFloat(inputValue(e));
		if (Number.isFinite(v) && v >= 0) {
			// Pass the leg's auto target so typing it returns the leg to auto instead
			// of pinning it (it then tracks future default / VFR changes), matching the
			// reset control. In FL mode the field carries the level's hundreds.
			setWaypointAltitude(wp.id, fl ? v * 100 : v, leg?.autoAltFt ?? undefined);
		}
	}

	// Pointing at the leg row draws its segment heavy on the map, and the map
	// pointing back marks this row (state/legHover.svelte.ts). The leg is named
	// by the waypoint it LEAVES, which is exactly this row's own waypoint.
	const legPointed = $derived(legHover.leg?.fromId === wp.id);
	let legEl = $state<HTMLLIElement | null>(null);
	$effect(() => {
		// A MAP-origin hover points at a row the reader is not looking at, so the
		// list brings it into view. 'nearest' leaves a row that is already on
		// screen alone (a PANEL hover is one by construction, and scrolling under
		// the cursor would yank the list), and .workspace clips rather than
		// scrolls, so the walk stops at the tab panel.
		const h = legHover.leg;
		if (h && h.source === 'map' && h.fromId === wp.id) {
			legEl?.scrollIntoView({ block: 'nearest' });
		}
	});

	// Inline per-leg wind override editor: one leg at a time (opening another
	// chip first blurs and commits this one; the editor's focusout closes it).
	let windOpen = $state(false);
	const windOverridden = $derived(wp.windDirDeg != null && wp.windSpeedKt != null);
</script>

<!-- The leg is its own <li class="leg"> below, so this row is exactly the
     waypoint: pointing at it flashes that pin on the map. focusin / focusout
     (they bubble, unlike focus / blur) so reaching any of the row's controls
     by keyboard counts as pointing. An HTML5 reorder drag fires no mouse
     events, so the highlight can never chase the drag. -->
<li
	class="wp"
	class:active={activeRoute().selectedWaypointId === wp.id}
	class:dragging
	class:drop-before={dropBefore}
	class:drop-after={dropAfter}
	onmouseenter={() => onHover(wp)}
	onmouseleave={() => onHover(null)}
	onfocusin={() => onHover(wp)}
	onfocusout={() => onHover(null)}
>
	<button
		class="wp-num"
		style:background={roleColor(i, count)}
		title={t.route.wpNumTip}
		draggable="true"
		onclick={() => onSelectWaypoint(wp)}
		ondragstart={onDragStart}
		ondragend={onDragEnd}
	>{i + 1}</button>
	<div class="wp-text">
		{#if wp.kind === 'free'}
			<input
				class="wp-name"
					autocapitalize="sentences"
				type="text"
				value={wp.label ?? ''}
				placeholder={t.route.customPoint}
				aria-label={t.route.waypointNameAria}
				oninput={(e) => setWaypointName(wp.id, inputValue(e))}
				onkeydown={(e) => {
					if (e.key === 'Enter') {
						e.currentTarget.blur();
					}
				}}
			/>
		{:else}
			<button class="wp-id-btn" onclick={() => onSelectWaypoint(wp)}>
				{wpTitle(wp)}
			</button>
		{/if}
		<span class="wp-sub">{wpSub(wp)}</span>
	</div>
	<div class="wp-ctrls">
		<button
			class="icon"
			title={t.route.moveUp}
			disabled={i === 0}
			onclick={() => reorderWaypoint(i, i - 1)}
		>
			<Icon name="chevron-up" size={14} />
		</button>
		<button
			class="icon"
			title={t.route.moveDown}
			disabled={i === count - 1}
			onclick={() => reorderWaypoint(i, i + 1)}
		>
			<Icon name="chevron-down" size={14} />
		</button>
		<button class="icon" title={t.route.remove} onclick={() => removeWaypoint(wp.id)}>
			<Icon name="x" size={14} />
		</button>
	</div>
</li>
{#if leg}
	<!-- Pointing at the leg (mouse or focus, the waypoint row's own rule: the
	     row holds the altitude field and the cues) draws that segment heavy on
	     the map; the map pointing back lights the rail here. -->
	<li
		class="leg"
		class:hl={legPointed}
		bind:this={legEl}
		onmouseenter={() => hoverLeg(activeRoute().id, wp.id, 'panel')}
		onmouseleave={() => unhoverLeg(wp.id)}
		onfocusin={() => hoverLeg(activeRoute().id, wp.id, 'panel')}
		onfocusout={() => unhoverLeg(wp.id)}
	>
		<div class="leg-info">
			<span class="leg-trk" title={t.route.magneticTrackTip}>{fmtTrack(leg.trackDeg)}M</span>
			<span class="leg-dist">{fmtNM(leg.distNM)} NM</span>
		</div>
		<label class="leg-alt" title={fl ? t.route.legFlTip : t.route.legAltTip}>
			{#if fl}<span class="fl-prefix">FL</span>{/if}
			<input
				class:fl
				type="number"
				min="0"
				max={fl ? MAX_LEG_ALT_FT / 100 : MAX_LEG_ALT_FT}
				step={fl ? 5 : 500}
				value={fl ? wp.alt / 100 : wp.alt}
				oninput={onAltInput}
				onfocus={() => (editFl = fl)}
				onblur={() => (editFl = null)}
			/>
			<span class="ft-suffix" class:hidden={fl}>ft</span>
		</label>
		<!-- Always laid out (space reserved); only its visibility toggles, so
		     the cue appearing / clearing never shifts the altitude field. -->
		<button
			class="leg-auto"
			class:hidden={wp.alt === (leg.autoAltFt ?? wp.alt)}
			title={t.route.resetAutoAlt}
			aria-label={t.route.resetAutoAlt}
			onclick={() => resetWaypointAltitudeAuto(wp.id)}
		>
			<Icon name="rotate-ccw" size={14} />
		</button>
		<!-- Same reserved-slot pattern as the reset cue, ALWAYS laid out
		     (warn is null while the semicircular option is off, so the
		     toggle flips visibility only and the altitude field never
		     moves): a non-compliant cruising level (click snaps to the
		     nearest lawful one) or the transition-layer advisory. -->
		<button
			class="leg-warn"
			class:hidden={!leg.warn}
			disabled={leg.warn?.kind !== 'level' || leg.warn.fixFt == null}
			title={leg.warn?.title ?? ''}
			aria-label={leg.warn?.title ?? t.route.cruisingLevelAdvisory}
			onclick={() => {
				if (leg.warn?.kind === 'level' && leg.warn.fixFt != null) {
					setWaypointAltitude(wp.id, leg.warn.fixFt, leg.autoAltFt ?? undefined);
				}
			}}
		>
			<Icon name="alert-triangle" size={14} />
		</button>
		<!-- Level-advisor cue, same always-laid-out rule (suggestions are
		     all null while the advisor is inactive): a faster usable level
		     exists for this leg by the forecast wind, click applies it.
		     ICON-ONLY on purpose: the level and gain live in the title and
		     the Apply-all summary line; chip text of any width would push
		     the altitude field off its fixed column. -->
		<button
			class="leg-best"
			class:hidden={!leg.suggestion}
			title={leg.suggestion?.title ?? ''}
			aria-label={leg.suggestion?.aria ?? t.route.noFasterLevel}
			onclick={() => {
				if (leg.suggestion) {
					setWaypointAltitude(wp.id, leg.suggestion.bestFt, leg.autoAltFt ?? undefined);
				}
			}}
		>
			<Icon name="gauge" size={14} />
		</button>
		{#if windOpen}
			<WaypointWindEditor wpId={wp.id} wind={leg.wind} onClose={() => (windOpen = false)} />
		{:else}
			<!-- W/V chip (reserved slot): the effective wind for this leg,
			     bare "279°/9" (the title carries the unit and provenance);
			     orange border = manual override, dashed underline =
			     vertical-shear advisory. -->
			<button
				class="leg-wind"
				class:override={windOverridden}
				class:shear={(leg.wind?.forecast?.shearKtPer1000Ft ?? 0) >= SHEAR_ADVISORY_KT_PER_1000FT}
				title={(leg.windTip ?? t.route.noWindPlanned) + '\n' + t.route.windChipTip}
				onclick={() => (windOpen = true)}
			>
				{leg.wind ? `${fmtTrack(leg.wind.dirDeg)}/${Math.round(leg.wind.speedKt)}` : '—'}
			</button>
		{/if}
	</li>
{/if}

<style>
	.wp {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 2px;
		border: 1px solid transparent;
		border-radius: var(--radius);
	}

	.wp.active {
		border-color: var(--accent);
		background: var(--surface-2);
	}

	/* Drag & drop reordering: dim the dragged row, draw an insertion bar (inset
	 * box-shadow, no reflow) on the edge of the hovered row where the drop lands. */
	.wp.dragging {
		opacity: 0.4;
	}

	.wp.drop-before {
		box-shadow: inset 0 2px 0 var(--accent);
	}

	.wp.drop-after {
		box-shadow: inset 0 -2px 0 var(--accent);
	}

	.wp-num {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		padding: 0;
		font-size: 11px;
		font-weight: 700;
		color: #fff;
		border: none;
		border-radius: 50%;
		cursor: grab;
	}

	.wp-num:hover {
		box-shadow: 0 0 0 2px var(--surface-3);
	}

	.wp.dragging .wp-num {
		cursor: grabbing;
	}

	.wp-text {
		display: flex;
		flex: 1;
		min-width: 0;
		flex-direction: column;
		padding-left: 4px;
	}

	.wp-id-btn {
		padding: 0;
		font: inherit;
		font-weight: 600;
		text-align: left;
		color: var(--text);
		background: transparent;
		border: none;
		cursor: pointer;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.wp-id-btn:hover {
		color: var(--accent);
	}

	.wp-name {
		width: 100%;
		padding: 2px 4px;
		font: inherit;
		font-weight: 600;
		color: var(--text);
		background: transparent;
		border: 1px solid transparent;
		border-radius: 4px;
	}

	.wp-name::placeholder {
		font-weight: 400;
		color: var(--text-muted);
	}

	.wp-name:hover {
		border-color: var(--border);
	}

	.wp-name:focus-visible {
		outline: none;
		border-color: var(--accent);
		background: var(--surface-2);
	}

	.wp-sub {
		font-size: 12px;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The leg connector between two waypoints: distance on the left, the leg's
	 * altitude input on the right. A left rail (aligned under the waypoint number)
	 * reads as the segment joining the two fixes. */
	.leg {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: -1px 0 -1px 11px;
		padding: 1px 2px 1px 13px;
		border-left: 2px solid var(--border);
	}

	/* Pointed at from either side (state/legHover.svelte.ts): the map's pointer
	 * is on this segment, or this row is pointing at it. The left rail already
	 * reads as the segment joining the two fixes, so lighting the rail IS the
	 * mark; colour and background only, never a size, since these rows must not
	 * reflow. */
	.leg.hl {
		background: var(--surface-2);
		border-left-color: var(--accent);
	}

	/* Track + distance grouped at the left; flex:1 pushes the altitude input
	 * right, so this is the one flexible row member: when the row runs out
	 * of width it is leg-info that gives, and it must CLIP (not spill over
	 * the altitude field, which is what a bare min-width: 0 did). */
	.leg-info {
		display: flex;
		flex: 1;
		min-width: 0;
		align-items: center;
		gap: 6px;
		overflow: hidden;
	}

	.leg-trk {
		flex: 0 0 auto;
		font-size: 11px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.leg-dist {
		flex: 0 0 auto;
		min-width: 0;
		font-size: 11px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.leg-alt {
		position: relative;
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 3px;
		font-size: 11px;
		color: var(--text-muted);
	}

	.leg-alt input {
		width: 70px;
		padding: 3px 5px;
		font: inherit;
		font-size: 12px;
		color: var(--text);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 4px;
	}

	/* Hands a manually-set leg back to the auto VFR Class A rule. Its visibility is
	 * the auto/manual cue: shown on a leg off its auto altitude, hidden otherwise. */
	.leg-auto {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		padding: 0 3px;
		color: var(--text-muted);
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.leg-auto:hover {
		color: var(--accent);
		background: var(--surface-2);
	}

	/* Hidden but still laid out while the leg sits at its auto altitude, so the cue
	 * appearing / clearing never nudges the altitude field sideways. */
	.leg-auto.hidden {
		visibility: hidden;
	}

	/* Flight levels read "FL 065": the FL unit paints inside the field's own
	 * left padding, out of flow, where the tight leg row cannot collide with
	 * it (leg-info's compressed text spill hides under the field, and an
	 * in-flow prefix slot would sit exactly where that spill paints); the ft
	 * suffix keeps its slot (visibility only). So crossing the transition
	 * altitude never moves the field or the cues. */
	.leg-alt .fl-prefix {
		position: absolute;
		top: 50%;
		left: 6px;
		pointer-events: none;
		transform: translateY(-50%);
	}

	.leg-alt input.fl {
		padding-left: 23px;
	}

	.leg-alt .ft-suffix.hidden {
		visibility: hidden;
	}

	/* Semicircular warning slot (same reserved-layout pattern as .leg-auto):
	 * a click snaps a non-compliant level; the transition-layer advisory is
	 * title-only (disabled). */
	.leg-warn {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		padding: 0 3px;
		color: var(--workbook-orange);
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.leg-warn:not(:disabled):hover {
		background: var(--surface-2);
	}

	.leg-warn:disabled {
		cursor: default;
	}

	.leg-warn.hidden {
		visibility: hidden;
	}

	/* Icon-only fixed slot (the .leg-warn reserved-layout pattern): any text
	 * here would resize the right-anchored group and move the altitude field;
	 * the suggested level and gain live in the title and the Apply-all
	 * summary line. */
	.leg-best {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		padding: 0 3px;
		color: var(--accent);
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.leg-best:hover {
		background: var(--surface-2);
	}

	.leg-best.hidden {
		visibility: hidden;
	}

	/* Per-leg W/V chip: the effective wind (forecast / override / global) with
	 * its provenance in the title; click opens the inline override editor. An
	 * overridden leg wears the manual-cue orange (the .leg-warn hue). Sized
	 * for "360°/999" so the resolved wind's digit count (or the placeholder)
	 * never resizes the chip: leg-info flexes, so a wider chip would push
	 * the altitude field and the cue slots left, and the leg row's width
	 * budget at the default sidebar width is exactly why the chip drops the
	 * unit (the title carries it). */
	.leg-wind {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		min-width: 62px;
		padding: 2px 3px;
		font: inherit;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
		background: transparent;
		border: 1px solid transparent;
		border-radius: 4px;
		cursor: pointer;
	}

	.leg-wind:hover {
		color: var(--text);
		background: var(--surface-2);
	}

	.leg-wind.override {
		color: var(--workbook-orange);
		border-color: var(--workbook-orange);
	}

	/* Vertical-shear advisory (>= 6 kt per 1000 ft, see the title text). */
	.leg-wind.shear {
		text-decoration: underline dashed;
		text-underline-offset: 3px;
	}

	.wp-ctrls {
		display: flex;
		flex: 0 0 auto;
	}

	.icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 0;
		color: var(--text-muted);
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.icon:hover:not(:disabled) {
		color: var(--text);
		background: var(--surface-3);
	}

	.icon:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	/* Touch hit-slop for the leg / waypoint row controls. These rows must
	   never reflow (rect-equality invariant), so the hit area grows via
	   invisible absolutely-positioned pseudo-elements: generous vertically
	   (24px controls -> ~44px effective), a few px horizontally so adjacent
	   controls barely overlap (the later sibling wins the shared strip).
	   Reserved-slot cues are visibility:hidden and take no hits, so their
	   slop is inert. The altitude input gets nothing (inputs cannot carry
	   pseudo-elements). */
	@media (pointer: coarse) {
		.wp-ctrls .icon,
		.leg-warn,
		.leg-best,
		.leg-auto,
		.leg-wind,
		.wp-num {
			position: relative;
		}

		.wp-ctrls .icon::after,
		.leg-warn::after,
		.leg-best::after,
		.leg-auto::after,
		.leg-wind::after {
			content: '';
			position: absolute;
			inset: -10px -3px;
		}

		.wp-num::after {
			content: '';
			position: absolute;
			inset: -8px -4px;
		}
	}
</style>
