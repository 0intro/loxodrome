<script lang="ts">
	/* The NOTAM data filters (flight rules, the route corridor, kind), opened
	 * from the funnel button in the NOTAMs tab head. What is left here is
	 * NOTAM-only: the period and the level band govern the whole map, so they
	 * are toolbar chrome (ViewConditions) rather than a briefing filter, and
	 * the popover opens by saying so. Every control writes through its setter
	 * (state/filter.svelte.ts), which is what persists it. Presentation
	 * (anchored popup / phone bottom sheet) is HeadOverlay's. */
	import {
		filter,
		followTrafficRoute,
		setNotamKind,
		setNotamsOnRouteOnly,
		setTrafficMode,
		trafficChoice,
		type TrafficMode,
	} from '$lib/state/filter.svelte';
	import { planScope } from '$lib/state/planScope.svelte';
	import { inputChecked } from '$lib/ui/dom';
	import { t } from '$lib/state/i18n.svelte';
	import { notamState } from '$lib/state/notam.svelte';
	import HeadOverlay from './HeadOverlay.svelte';
	import Icon from './Icon.svelte';
	import Segmented from './Segmented.svelte';

	let {
		open,
		x,
		y,
		onClose,
		fromRoute = false,
		routeScope = false,
	}: {
		open: boolean;
		x: number;
		y: number;
		onClose: () => void;
		/** Does the flight-rules filter currently mirror a planned route? Purely
		 *  informative, and false wherever there is no plan to mirror. */
		fromRoute?: boolean;
		/** Is there a routed plan for the route corridor to apply to? Without
		 *  one the switch is inert and its row absent (the NOTAM Viewer has no
		 *  plan at all). */
		routeScope?: boolean;
	} = $props();

	const total = $derived(notamState.notams.length);

	/* Route: the "follow it" state the flight rules' control offers
	 * (docs/preferences.md rule 2), while a routed plan exists: the
	 * condition the Corridor row and the chip's "set by your route" read, so
	 * the popover never offers a route the rest of the tab says is not there
	 * (the NOTAM Viewer, which has no plan, never). Which option reads as
	 * selected is the filter module's (trafficChoice). */
	const routeRules = $derived(routeScope ? (planScope.flightRules?.() ?? null) : null);
	const rulesValue = $derived(trafficChoice(routeRules));
	const rulesOptions = $derived([
		...(routeRules !== null
			? [{ value: 'route', label: t.filter.modeRoute, title: t.filter.modeRouteTip }]
			: []),
		{ value: 'all', label: t.filter.modeAll },
		{ value: 'vfr', label: 'VFR' },
		{ value: 'ifr', label: 'IFR' },
	]);

	function pickRules(v: string): void {
		if (v === 'route') {
			if (routeRules !== null) {
				followTrafficRoute(routeRules);
			}
		} else {
			setTrafficMode(v as TrafficMode);
		}
	}

</script>

<HeadOverlay {open} {x} {y} title={t.filter.open} {onClose}>
	<div class="filters popover-panel">
		<!-- A funnel states its reach: the period and the level band left for
		     the toolbar, so everything here really is NOTAM-only. -->
		<p class="muted small scope">{t.filter.scopeNote}</p>

		<fieldset class="group">
			<legend>
				{t.filter.flightRulesLegend}
				{#if fromRoute}
					<span class="prov" title={t.filter.setByRoute}><Icon name="route" size={11} /></span>
				{/if}
			</legend>
			<Segmented
				options={rulesOptions}
				value={rulesValue}
				onSelect={pickRules}
				ariaLabel={t.filter.flightRulesLegend}
				title={fromRoute ? t.filter.setByRoute : undefined}
			/>
			<p class="muted small">{t.filter.flightRulesNote}</p>
		</fieldset>

		{#if routeScope}
			<!-- The Route tab's own switch, dual-homed here with the filters it
			     belongs to, in the Route tab's words. -->
			<fieldset class="group">
				<legend>
					{t.filter.routeLegend}
					<span class="prov"><Icon name="route" size={11} /></span>
				</legend>
				<label class="check" title={t.filter.routeOnlyTip}>
					<input
						type="checkbox"
						checked={filter.notamsOnRouteOnly}
						onchange={(e) => setNotamsOnRouteOnly(inputChecked(e))}
					/>
					<span>{t.route.notamsOnRouteOnly}</span>
				</label>
			</fieldset>
		{/if}

		{#if total === 0}
			<p class="muted">{t.filter.noNotams}</p>
		{:else}
			<fieldset class="group">
				<legend>{t.filter.kindLegend}</legend>
				<label class="check">
					<input
						type="checkbox"
						checked={filter.kind.position}
						onchange={(e) => setNotamKind('position', inputChecked(e))}
					/>
					<span>{t.filter.kindPositions}</span>
				</label>
				<label class="check">
					<input
						type="checkbox"
						checked={filter.kind.area}
						onchange={(e) => setNotamKind('area', inputChecked(e))}
					/>
					<span>{t.filter.kindAreas}</span>
				</label>
				<label class="check">
					<input
						type="checkbox"
						checked={filter.kind.qualifierLine}
						onchange={(e) => setNotamKind('qualifierLine', inputChecked(e))}
					/>
					<span>{t.filter.kindQline}</span>
				</label>
			</fieldset>

		{/if}
	</div>
</HeadOverlay>

<style>
	.filters {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 6px;
	}

	/* The legend carries an inline provenance mark, so it lays its content
	   out; everything else about it is the shared chrome. */
	legend {
		display: flex;
		align-items: center;
		gap: 5px;
	}

	/* The "set by your route" provenance mark on the flight-rules group. */
	.prov {
		display: inline-flex;
		color: var(--accent);
	}

	.scope {
		margin: 0 2px;
	}

	.small {
		font-size: 11px;
	}

</style>
