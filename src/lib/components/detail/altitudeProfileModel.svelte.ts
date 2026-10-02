/* The derivation behind a detail panel's altitude profile, shared by the two
 * places that draw it: the inline chart in the panel (AltitudeProfile.svelte)
 * and the surface it opens (PanelProfileModal.svelte, mounted once per app,
 * see state/airspaceProfileModal.svelte.ts for why the surface left the
 * panel). One code path for both, so the thumbnail and the chart it opens
 * cannot disagree about what is above the point.
 *
 * Called during a component's initialisation: it creates the terrain effect
 * and the deriveds in that component's context, and hands back getters. The
 * input is a function so the deriveds track it; null means nothing to plot,
 * and short-circuits rather than running over an empty list, since the scope
 * subscribes to the filter rows, the level band and the layer records and a
 * closed surface is meant to be inert. */

import { groundBandAtPoint } from '$lib/vertical/limits';
import type { Airspace } from '$lib/data/airspaces';
import { t } from '$lib/state/i18n.svelte';
import { activeAltitudeBand } from '$lib/state/filter.svelte';
import { profileScope, type ProfileScope } from '$lib/state/profile.svelte';
import { elevationFtAt } from '$lib/map/terrain';
import {
	aboveIsComplete,
	airspaceAbove,
	airspaceColumns,
	profileWindow,
	type VerticalColumn,
	type VerticalOverlay,
} from '$lib/components/verticalProfile';

export interface AltitudeProfileInput {
	airspaces: Airspace[];
	highlightKey: string | null;
	overlays: VerticalOverlay[];
	/** A known ground wins; otherwise the terrain at lat/lon is read. */
	groundFt: number | null;
	lat: number | undefined;
	lon: number | undefined;
}

const EMPTY_SCOPE: ProfileScope = { shown: [], hiddenRows: 0, hiddenBand: 0, hiddenScope: 0 };

export function altitudeProfileModel(input: () => AltitudeProfileInput | null) {
	// Terrain ground for the profile's point. An explicit groundFt (an airport's
	// field elevation) wins; otherwise fetch the terrain at lat/lon once.
	let fetchedGroundFt = $state<number | null>(null);
	$effect(() => {
		const i = input();
		if (!i || i.groundFt != null || i.lat == null || i.lon == null) {
			fetchedGroundFt = null;
			return;
		}
		let stale = false;
		void elevationFtAt(i.lat, i.lon)
			.then((ft) => {
				if (!stale) fetchedGroundFt = ft;
			})
			.catch(() => {
				if (!stale) fetchedGroundFt = null;
			});
		return () => {
			stale = true;
		};
	});
	const groundFt = $derived(input()?.groundFt ?? fetchedGroundFt);

	// Apply the filter rows, the level band and the global "all airspaces vs
	// only those on the map" scope, keeping WHAT EACH ONE DROPPED so the chart
	// can say so rather than reading as an empty sky. The highlighted airspace
	// (the airspace panel's own subject) is exempt from all three.
	const scope = $derived.by(() => {
		const i = input();
		return i ? profileScope(i.airspaces, i.highlightKey) : EMPTY_SCOPE;
	});

	const filterBand = $derived(activeAltitudeBand());

	// One shared column build (components/verticalProfile.ts airspaceColumns);
	// the vocab is read here, inside the $derived, so tooltips follow the
	// locale, and highlightKey marks this panel's own subject column.
	//
	// Built over the WHOLE stack and then filtered, rather than built over the
	// filtered set: one pass instead of two, and it is what lets the header ask
	// whether hiding any of them actually moved the airspace-above answer.
	const allColumns = $derived.by<VerticalColumn[]>(() => {
		const i = input();
		if (!i) {
			return [];
		}
		return airspaceColumns(
			i.airspaces,
			// A single probed point, so the band's two ends are one reading.
			groundBandAtPoint(groundFt),
			{
				unknownLimit: t.detail.unknownLimit,
				airspaceTypes: t.data.airspaceTypes,
			},
			i.highlightKey,
		);
	});
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a fresh lookup per derive, never mutated
	const shownKeys = $derived(new Set(scope.shown.map((a) => a.key)));
	const columns = $derived(allColumns.filter((c) => shownKeys.has(c.id)));

	// The axis is the band being flown, not the tallest column: one shared rule
	// (components/verticalProfile.ts). The panel's own overlays are must-show
	// bands, since on the NOTAM panel that F)/G) band IS the subject and its
	// floor can be FL 095. The inline chart draws this fitted window; the
	// surface owns the live one it can be zoomed to.
	const win = $derived(
		profileWindow({
			columns,
			band: filterBand,
			mustShow: input()?.overlays ?? [],
			groundFt,
		}),
	);

	// The actionable number the chart implies, over the FILTERED stack and not
	// the window-cropped one: what is above you cannot depend on how far a
	// chart happens to be zoomed in, the rule the surface states for its own
	// figure. A window note beside it can therefore say a column is not drawn
	// while the figure names it, which is both of them being right. Suppressed
	// without a ground (the NOTAM panel), where the reference would be sea level.
	const above = $derived(airspaceAbove(columns, groundFt));
	// And whether the filters moved that answer. Not "was anything hidden": a
	// UTA at FL 195 hidden by the level band over a field under a 1500 ft CTR
	// changes nothing, and asking the cheaper question cost the figure over
	// every French aerodrome.
	const aboveComplete = $derived(aboveIsComplete(above, airspaceAbove(allColumns, groundFt)));

	// The caller's overlays plus the active altitude filter window, drawn as a
	// dashed outline so it stays legible over any fill overlay. The chart drops
	// it while the band spans its whole window, which it does whenever the axis
	// IS the band.
	const overlays = $derived.by<VerticalOverlay[]>(() => {
		const out: VerticalOverlay[] = [...(input()?.overlays ?? [])];
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

	return {
		get groundFt() {
			return groundFt;
		},
		get scope() {
			return scope;
		},
		get columns() {
			return columns;
		},
		get win() {
			return win;
		},
		get above() {
			return above;
		},
		get aboveComplete() {
			return aboveComplete;
		},
		get overlays() {
			return overlays;
		},
	};
}
