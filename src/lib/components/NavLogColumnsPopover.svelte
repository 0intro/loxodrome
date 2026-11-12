<script lang="ts">
	/* The nav-log surface's Columns popover: which content the sheet carries,
	 * over the persisted routeSettings nav-log toggles (airport frequencies,
	 * enroute frequencies, VOR radials), which configure the sheet, its
	 * prints and the route-file save. The chrome is TogglesPopover's; what
	 * lives here is the label table and the state binding. */
	import { t } from '$lib/state/i18n.svelte';
	import { routeSettings } from '$lib/state/route.svelte';
	import TogglesPopover from './TogglesPopover.svelte';

	interface Props {
		/** The header button the panel anchors to. */
		anchorEl: HTMLElement | undefined;
		/** Backdrop dismissal; the caller flips its open flag. */
		onClose: () => void;
	}
	const { anchorEl, onClose }: Props = $props();

	type ColumnKey = 'airportFreqsInNavlog' | 'enrouteFreqsInNavlog' | 'vorRadialsInNavlog';

	const rows = $derived([
		{
			key: 'airportFreqsInNavlog' as const,
			label: t.navlog.airportFreqs,
			tip: t.navlog.airportFreqsTip,
			checked: routeSettings.airportFreqsInNavlog,
		},
		{
			key: 'enrouteFreqsInNavlog' as const,
			label: t.navlog.enrouteFreqs,
			tip: t.navlog.enrouteFreqsTip,
			checked: routeSettings.enrouteFreqsInNavlog,
		},
		{
			key: 'vorRadialsInNavlog' as const,
			label: t.navlog.vorRadials,
			tip: t.navlog.vorRadialsTip,
			checked: routeSettings.vorRadialsInNavlog,
		},
	]);
</script>

<TogglesPopover
	{rows}
	onToggle={(key: ColumnKey, on: boolean) => (routeSettings[key] = on)}
	{anchorEl}
	{onClose}
/>
