<script lang="ts">
	import {
		mapProfileModal,
		closeMapProfile,
	} from '$lib/state/mapProfileModal.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { airspacesOver } from '$lib/data/airspaces';
	import { activeAltitudeBand } from '$lib/state/filter.svelte';
	import { getAirspaces } from '$lib/state/data.svelte';
	import { elevationFtAt } from '$lib/map/terrain';
	import { formatCoordShort } from '$lib/format/coord';
	import { profileAirspaces } from '$lib/state/profile.svelte';
	import VerticalProfileModal from './VerticalProfileModal.svelte';
	import type { VerticalOverlay } from './verticalProfile';
	import { airspaceColumns, profileWindow } from './verticalProfile';
	import { airspaceNavigator, useAirspaceHover } from './featureHover.svelte';

	// Thin adapter: the map's "Altitude profile here" action stores the
	// picked point (which the on-map marker then drags); this component
	// derives the airspace stack there (honouring the global all-vs-on-map
	// setting), turns it into the generic VerticalProfile shape, and renders
	// the singleton modal. Mounted once in App.svelte.

	const filterBand = $derived(activeAltitudeBand());

	// Null while the surface is closed, so nothing here re-profiles the last
	// point on every dataset or filter change once the chart is gone.
	const point = $derived(mapProfileModal.point);

	// Terrain ground at the picked point, fetched while the surface is open. The
	// previous value stays on screen until the new one lands, so a drag reads
	// the last known ground rather than flickering through null.
	let groundFt = $state<number | null>(null);
	$effect(() => {
		if (!point) {
			groundFt = null;
			return;
		}
		const { lat, lng } = point;
		let stale = false;
		void elevationFtAt(lat, lng)
			.then((ft) => {
				if (!stale) groundFt = ft;
			})
			.catch(() => {
				if (!stale) groundFt = null;
			});
		return () => {
			stale = true;
		};
	});

	// The airspace stack at the picked point, ordered highest-band first,
	// filtered by the global "all airspaces vs only those on the map" toggle.
	const airspaces = $derived(
		point
			? profileAirspaces(airspacesOver(getAirspaces() ?? [], point.lat, point.lng))
			: [],
	);

	// One shared column build (./verticalProfile.ts airspaceColumns); the
	// vocab is read here, inside the $derived, so tooltips follow the locale.
	const columns = $derived(
		airspaceColumns(airspaces, groundFt, {
			unknownLimit: t.detail.unknownLimit,
			airspaceTypes: t.data.airspaceTypes,
		}),
	);

	// One shared window rule (./verticalProfile.ts) instead of the ceiling
	// derived this file and detail/AltitudeProfile each carried: the axis is the
	// band being flown, not the tallest column. This is the FIT; the surface owns
	// the live window it can be zoomed to.
	const fit = $derived(profileWindow({ columns, band: filterBand, groundFt }));

	const overlays = $derived.by<VerticalOverlay[]>(() => {
		const out: VerticalOverlay[] = [];
		// No NOTAM band on the map use case; this is a free-form query
		// "what's stacked above this point?", not a NOTAM context. The chart drops
		// the filter outline while the band spans its whole window, which it does
		// whenever the window IS the band.
		if (filterBand) {
			out.push({
				kind: 'outline',
				floorFt: filterBand.floor,
				ceilingFt: filterBand.ceiling,
				color: 'var(--text-muted)',
				label: t.detail.activeAltitudeFilter,
			});
		}
		return out;
	});

	/* Just the name. The count belongs on the context-menu action, which says how
	 * many the point holds BEFORE the chart is opened; once it is open the
	 * columns are there to be counted, and the count of the whole stack disagrees
	 * with the drawn set whenever the window leaves one out. */
	const title = $derived(t.detail.altitudeProfile);

	/* Where the chart is taken, at the precision a title bar can spare (whole
	 * seconds, about 30 m; the cursor badge and "Copy coordinates" keep the full
	 * figure). The ground is not repeated here: the chart labels its own terrain
	 * band with it. */
	const subtitle = $derived(point ? formatCoordShort(point.lat, point.lng) : undefined);

	/* Hovering a column flashes that airspace on the map, the rule the inline
	 * chart and the airspace lists already follow; useAirspaceHover holds the
	 * assert-and-restore effect (the marker drag can move the stack under a
	 * still pointer). Click navigation shares airspaceNavigator: docked, the
	 * chart, the map and the marker are all on screen at once. */
	const hover = useAirspaceHover(() => airspaces);
	const navigateToColumn = airspaceNavigator('mapProfile', closeMapProfile);
</script>

<VerticalProfileModal
	id="mapProfile"
	{title}
	{subtitle}
	{columns}
	{overlays}
	fitFloorFt={fit.floorFt}
	fitCeilingFt={fit.ceilingFt}
	{groundFt}
	onColumnClick={navigateToColumn}
	onColumnHover={hover.set}
	onClose={closeMapProfile}
/>
