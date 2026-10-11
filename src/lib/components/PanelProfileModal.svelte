<script lang="ts">
	/* The `airspaceProfile` surface: a detail panel's own altitude profile,
	 * opened from the inline chart in the panel and mounted ONCE per app,
	 * outside any panel (the MapProfileModal shape). Why it left the panel is
	 * state/airspaceProfileModal.svelte.ts: on a phone the panel is a surface
	 * in the same pane, so a chart mounted inside it went the moment it opened.
	 *
	 * Everything it draws comes from the subject the panel published, through
	 * the derivation the inline chart shares (detail/altitudeProfileModel), so
	 * the thumbnail and the chart it opens compute one answer. */
	import { t } from '$lib/state/i18n.svelte';
	import {
		airspaceProfileModal,
		closeAirspaceProfile,
		detachAirspaceProfile,
	} from '$lib/state/airspaceProfileModal.svelte';
	import VerticalProfileModal from './VerticalProfileModal.svelte';
	import { altitudeProfileModel } from './detail/altitudeProfileModel.svelte';
	import { airspaceNavigator, useAirspaceHover } from './featureHover.svelte';

	// Null while the surface is closed, so nothing here re-profiles the last
	// panel on every dataset or filter change once the chart is gone.
	const subject = $derived(airspaceProfileModal.subject);
	const model = altitudeProfileModel(() => subject);

	// Detached FIRST: the navigation replaces or re-targets the panel that
	// opened the chart, and the chart must not follow it.
	const navigate = airspaceNavigator('airspaceProfile', closeAirspaceProfile);
	function navigateToColumn(key: string): void {
		detachAirspaceProfile();
		navigate(key);
	}

	/* Flash the hovered column's airspace on the map, then fall back to the
	 * panel's current airspace selection (or nothing): a profile column is
	 * just another way to point at an airspace, and useAirspaceHover holds the
	 * assert-and-restore effect (the chart can unmount under the pointer). */
	const hover = useAirspaceHover(() => model.scope.shown);
</script>

<VerticalProfileModal
	id="airspaceProfile"
	title={t.detail.altitudeProfile}
	subtitle={subject?.heading}
	columns={model.columns}
	overlays={model.overlays}
	fitFloorFt={model.win.floorFt}
	fitCeilingFt={model.win.ceilingFt}
	groundFt={model.groundFt}
	hiddenCounts={model.scope}
	aboveComplete={model.aboveComplete}
	onColumnClick={navigateToColumn}
	onColumnHover={hover.set}
	viewKey={airspaceProfileModal.viewKey}
	onClose={closeAirspaceProfile}
/>
