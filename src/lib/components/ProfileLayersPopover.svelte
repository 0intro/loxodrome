<script lang="ts">
	/* The profile modals' Layers popover: which overlays the chart draws,
	 * over the persisted profileLayers state, which is shared across both
	 * profile modals so a preference follows the user between them. The
	 * chrome (anchoring, backdrop, rows) is TogglesPopover's; what lives
	 * here is the label table and the state binding. */
	import { t } from '$lib/state/i18n.svelte';
	import {
		profileLayers,
		setProfileLayer,
		type ProfileLayerKey,
	} from '$lib/state/profileLayers.svelte';
	import TogglesPopover from './TogglesPopover.svelte';

	interface Props {
		/** The layer rows this surface offers, in display order (the route
		 *  profile lists all seven, the trace profile its three). */
		rows: ProfileLayerKey[];
		/** The header button the panel anchors to. */
		anchorEl: HTMLElement | undefined;
		/** Backdrop dismissal; the caller flips its open flag. */
		onClose: () => void;
	}
	const { rows, anchorEl, onClose }: Props = $props();

	// Label + tooltip per layer key. "MSA" is the ICAO Doc 8400 literal,
	// locale-invariant.
	const texts: Record<ProfileLayerKey, { label: string; tip: string }> = $derived({
		windBarbs: { label: t.route.windBarbs, tip: t.route.windBarbsTip },
		freezing: { label: t.route.freezingLevel, tip: t.route.freezingLevelTip },
		clouds: { label: t.route.clouds, tip: t.route.cloudsTip },
		obstacles: { label: t.route.obstacles, tip: t.route.obstaclesTip },
		msa: { label: 'MSA', tip: t.route.msaTip },
		notams: { label: t.route.notams, tip: t.route.notamsTip },
		terrainTint: { label: t.route.terrainTint, tip: t.route.terrainTintTip },
	});
</script>

<TogglesPopover
	rows={rows.map((key) => ({
		key,
		label: texts[key].label,
		tip: texts[key].tip,
		checked: profileLayers[key],
	}))}
	onToggle={setProfileLayer}
	{anchorEl}
	{onClose}
/>
