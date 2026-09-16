<script lang="ts">
	/* The detail's body: one kind component for whatever ui.detail names,
	 * rendered by the desktop panel and the phone pane alike. */
	import NotamDetail from './NotamDetail.svelte';
	import AirportDetail from './AirportDetail.svelte';
	import AirspaceDetail from './AirspaceDetail.svelte';
	import ObstacleDetail from './ObstacleDetail.svelte';
	import NavaidDetail from './NavaidDetail.svelte';
	import NatureDetail from './NatureDetail.svelte';
	import SupAipDetail from './SupAipDetail.svelte';
	import SigmetDetail from './SigmetDetail.svelte';
	import MetarStationDetail from './MetarStationDetail.svelte';
	import type { DetailSelection } from './detailHead.svelte';

	const { selection }: { selection: DetailSelection } = $props();
</script>

{#if selection.notam}
	<NotamDetail notam={selection.notam} />
{:else if selection.airport}
	<AirportDetail airport={selection.airport} />
{:else if selection.airspace}
	<AirspaceDetail airspace={selection.airspace} />
{:else if selection.obstacle}
	<ObstacleDetail obstacle={selection.obstacle} />
{:else if selection.navaid}
	<NavaidDetail navaid={selection.navaid} />
{:else if selection.nature}
	<NatureDetail nature={selection.nature} />
{:else if selection.supaip}
	<SupAipDetail supaip={selection.supaip} zoneIndex={selection.supaipZone} />
{:else if selection.sigmet}
	<SigmetDetail sigmet={selection.sigmet} />
{:else if selection.station}
	<MetarStationDetail station={selection.station} />
{/if}
