/* featureHover.svelte.ts: the row / column interactions that point at the map,
 * shared by the point profile's columns (MapProfileModal,
 * detail/AltitudeProfile) and the nav log's two tables (NavLogSheet's waypoint
 * idents, NavLogSchedule's crossing rows): pointing at one flashes its feature
 * on the map (the rule the airspace lists and the map context menu follow,
 * map/selectionHighlight.ts), and clicking one opens its panel. */

import type { Airspace } from '$lib/data/airspaces';
import { clearHover, hoverFeatures, type HoverKind } from '$lib/map/selectionHighlight';
import type { EnrouteFreqLine } from '$lib/route/airspaces';
import type { Waypoint } from '$lib/state/route.svelte';
import { navigateToAirspace } from '$lib/state/ui.svelte';
import { surfaceKeepsMapVisible } from '$lib/state/workspace.svelte';
import type { SurfaceId } from '$lib/surfaces';

/** The hover machine both flavours share. Call during component init (the
 *  $effect needs the component's own context). The hovered row is held as a
 *  KEY in state and resolved by an effect rather than highlighted straight
 *  through: the drawn set can move under a still pointer (the map marker
 *  dragged, a route or altitude edit and a landing terrain sample recomputing
 *  the schedule) and a chart keys its columns by index, so the column or row
 *  under the cursor can come to hold another feature with no leave event; the
 *  surface can also close mid-hover, and an element removed under the pointer
 *  fires no mouseleave at all. Either would strand the highlight on a feature
 *  nobody is pointing at. `resolve` reads the drawn set reactively and returns
 *  null for a key that is gone (or never had a feature: a free waypoint),
 *  which drops the hover; the teardown is clearHover, which re-applies the
 *  panel's own selection whatever ended the hover. */
function useHover(resolve: (key: string) => { kind: HoverKind; ids: readonly string[] } | null): {
	set: (key: string | null) => void;
} {
	let hoverKey = $state<string | null>(null);
	$effect(() => {
		const key = hoverKey;
		if (key === null) {
			return;
		}
		const target = resolve(key);
		if (!target) {
			hoverKey = null;
			return;
		}
		hoverFeatures(target.kind, target.ids);
		return clearHover;
	});
	return {
		set: (key: string | null): void => {
			hoverKey = key;
		},
	};
}

/** Hovering an airspace column / schedule row flashes that zone. `list` is the
 *  set the caller draws; only the keys are read, so a chart passes its
 *  airspaces and the schedule its crossing events (both carry Airspace.key). */
export function useAirspaceHover(list: () => readonly Pick<Airspace, 'key'>[]): {
	set: (key: string | null) => void;
} {
	return useHover((key) =>
		list().some((a) => a.key === key) ? { kind: 'airspace', ids: [key] } : null,
	);
}

/** Hovering a nav-log enroute frequency line flashes EVERY airspace that line
 *  covers: a line is a UNIT, and one unit commonly works several of the
 *  sectors a leg crosses ("SEINE - INFORMATION" over SIV SEINE 1 / 2 / 3), so
 *  EnrouteFreqLine.keys names them all and flashing the first would point at
 *  the wrong sector two times in three. Keyed on label + freq, the identity
 *  the caller's {#each} already uses. */
export function useEnrouteFreqHover(list: () => readonly EnrouteFreqLine[]): {
	set: (line: EnrouteFreqLine | null) => void;
} {
	const hover = useHover((key) => {
		const line = list().find((l) => lineKey(l) === key);
		return line ? { kind: 'airspace', ids: line.keys } : null;
	});
	return {
		set: (line: EnrouteFreqLine | null): void => {
			hover.set(line ? lineKey(line) : null);
		},
	};
}

function lineKey(l: EnrouteFreqLine): string {
	return `${l.label}|${l.freq}`;
}

/** Hovering a row that names one navaid (the nav log's VOR radial line). The
 *  pin rule in hoverFeature swaps to the waypoint's pin when the station IS
 *  that waypoint; an on-field VOR keeps its own symbol. `list` is the set of
 *  station ids the caller draws. */
export function useNavaidHover(list: () => readonly string[]): {
	set: (id: string | null) => void;
} {
	return useHover((id) => (list().includes(id) ? { kind: 'navaid', ids: [id] } : null));
}

/** Hovering a waypoint row (a nav-log ident, a Route-tab row) flashes that
 *  waypoint's own PIN, not the aerodrome / navaid it is anchored to: the two
 *  are concentric and the pin is drawn far above, so a feature highlight there
 *  is invisible (see highlightWaypoint in map/routeLayer.ts). Free points get
 *  the same flash, having a pin like any other waypoint. `list` is the set the
 *  caller draws. */
export function useWaypointHover(list: () => readonly Waypoint[]): {
	set: (wp: Waypoint | null) => void;
} {
	const hover = useHover((id) =>
		list().some((w) => w.id === id) ? { kind: 'waypoint', ids: [id] } : null,
	);
	return {
		set: (wp: Waypoint | null): void => {
			hover.set(wp?.id ?? null);
		},
	};
}

/** Row / column click: open the airspace panel. Docked, the surface, the map
 *  and the panel are all on screen at once, which is what docking is for; a
 *  page / full surface covers the map and steps aside
 *  (docs/workspace-surfaces.md). No breadcrumb is stamped:
 *  ui.detailFromProfile names the route and trace charts only, and
 *  navigateToAirspace clears it. */
export function airspaceNavigator(surface: SurfaceId, close: () => void): (key: string) => void {
	return (key: string): void => {
		navigateToAirspace(key);
		if (!surfaceKeepsMapVisible(surface)) {
			close();
		}
	};
}
