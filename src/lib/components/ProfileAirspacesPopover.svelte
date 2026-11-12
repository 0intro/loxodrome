<script lang="ts">
	/* The profiles' Airspaces popover: which KINDS of airspace the chart
	 * plots, the Garmin navigators' Airspace page ported to this data's own
	 * vocabulary (docs/route-profile.md "Airspace filter"). The chrome
	 * (anchoring, backdrop, rows, the touch floor) is TogglesPopover's; what
	 * lives here is the label table and the state binding, the
	 * ProfileLayersPopover shape exactly.
	 *
	 * A row means the same thing on every surface, but a surface offers only
	 * the rows it can serve (the ProfileLayersPopover idiom, where the route
	 * profile passes seven layer rows and the trace profile three). Three
	 * sets: the COLUMN profiles pass all of AIRSPACE_FILTER_GROUPS, being the
	 * only ones that draw the structural background; the ROUTE chart passes
	 * PROFILE_BAND_FILTER_GROUPS, whose walk produces no FIR; and the TRACE
	 * chart passes TRACE_BAND_FILTER_GROUPS, which drops FIS as well, its
	 * vertices carrying no planned altitude for the contact ladder to read
	 * (docs/route-profile.md "Airspace filter"). */
	import type { AirspaceFilterGroup } from '$lib/data/airspaces';
	import { t } from '$lib/state/i18n.svelte';
	import {
		profileAirspaceGroups,
		setProfileAirspaceGroup,
	} from '$lib/state/profileAirspaceFilter.svelte';
	import TogglesPopover from './TogglesPopover.svelte';

	interface Props {
		/** The rows this surface offers, in display order. */
		rows: readonly AirspaceFilterGroup[];
		/** The header button the panel anchors to. */
		anchorEl: HTMLElement | undefined;
		/** Backdrop dismissal; the caller flips its open flag. */
		onClose: () => void;
	}
	const { rows, anchorEl, onClose }: Props = $props();

	// The five class rows explain themselves with the ICAO Annex 11 summary
	// the app already carries in both languages; every other row carries its
	// own note. Read inside a $derived, never a module const, so the table
	// follows the locale (docs/i18n.md rule 2).
	const texts: Record<AirspaceFilterGroup, { label: string; tip: string }> = $derived({
		classA: { label: t.layers.airspaceFilterGroups.classA, tip: t.data.airspaceClasses.A },
		classB: { label: t.layers.airspaceFilterGroups.classB, tip: t.data.airspaceClasses.B },
		classC: { label: t.layers.airspaceFilterGroups.classC, tip: t.data.airspaceClasses.C },
		classD: { label: t.layers.airspaceFilterGroups.classD, tip: t.data.airspaceClasses.D },
		classE: { label: t.layers.airspaceFilterGroups.classE, tip: t.data.airspaceClasses.E },
		restricted: {
			label: t.layers.airspaceFilterGroups.restricted,
			tip: t.layers.airspaceFilterTips.restricted,
		},
		military: {
			label: t.layers.airspaceFilterGroups.military,
			tip: t.layers.airspaceFilterTips.military,
		},
		other: { label: t.layers.airspaceFilterGroups.other, tip: t.layers.airspaceFilterTips.other },
		// These four reuse the Layers tab's own category wording rather
		// than carrying a second name for the same thing.
		activity: {
			label: t.layers.airspaceCategories.activity,
			tip: t.layers.airspaceFilterTips.activity,
		},
		trafficmgmt: {
			label: t.layers.airspaceCategories.trafficmgmt,
			tip: t.layers.airspaceFilterTips.trafficmgmt,
		},
		fir: { label: t.layers.airspaceCategories.fir, tip: t.layers.airspaceFilterTips.fir },
		siv: { label: t.layers.airspaceCategories.siv, tip: t.layers.airspaceFilterTips.siv },
	});
</script>

<TogglesPopover
	rows={rows.map((key) => ({
		key,
		label: texts[key].label,
		tip: texts[key].tip,
		checked: profileAirspaceGroups[key],
	}))}
	onToggle={setProfileAirspaceGroup}
	{anchorEl}
	{onClose}
	footer={foot}
/>

<!-- The one rule no row can state: a prohibited area answers to none of
	 them. Garmin's own "Restore Defaults" is deliberately NOT carried over
	 (user-decided): the rows are their own reset, and one more control that
	 appears and vanishes with the state costs more attention in the cockpit
	 than the taps it saves. -->
{#snippet foot()}
	<span>{t.layers.airspaceFilterProhibited}</span>
{/snippet}
