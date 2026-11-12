/* State for a detail panel's own altitude profile: WHICH airspaces it plots.
 * The singleton surface (PanelProfileModal, mounted once per app) derives the
 * chart from this subject, the mapProfileModal idiom one step further: that
 * surface keeps a point, this one keeps what the panel handed it. Open-ness is
 * the workspace slot.
 *
 * WHY THE CHART LEFT THE PANEL. It used to be mounted inside
 * detail/AltitudeProfile, the component that draws the inline chart, and on a
 * PHONE the detail is itself a surface: the pane's occupant, beside the nav log
 * and the profiles (docs/workspace-surfaces.md "Phones"). Opening the chart
 * therefore evicted the panel the chart was mounted in. The panel's body
 * unmounted, the chart's shell went with it, and the inline component's own
 * teardown closed the surface that had just opened: a tap on the chart left a
 * bare map, the pane still claimed by a surface nothing rendered. Measured in
 * the real app on the phone layout, and it was as old as the phone pane.
 *
 * So the chart lives here, independent of any panel, and the panel PUBLISHES
 * into it: the subject at open, then every change while that panel lives (a
 * terrain read landing, a dataset merging, a filter moving). The owner is the
 * panel instance that opened it; only it publishes, and only it releases. */

import type { Airspace } from '$lib/data/airspaces';
import type { VerticalOverlay } from '$lib/components/verticalProfile';
import { closeSurface, isOpen, openSurface, surfaceKeepsMapVisible } from './workspace.svelte';
import { ui } from './ui.svelte';

/** What a panel's chart plots: the inline component's own inputs. */
export interface AirspaceProfileSubject {
	/** Airspaces to plot, highest-band first (see airspacesOver). */
	airspaces: Airspace[];
	/** The panel's own heading, the surface's subtitle; undefined for none. */
	heading: string | undefined;
	/** The airspace drawn as the focus column, null for none. */
	highlightKey: string | null;
	/** The panel's extra overlay bands (a NOTAM's F)/G) band). */
	overlays: VerticalOverlay[];
	/** A known ground (an aerodrome's elevation), else null and lat/lon. */
	groundFt: number | null;
	lat: number | undefined;
	lon: number | undefined;
}

const local = $state<{ subject: AirspaceProfileSubject | null; view: number }>({
	subject: null,
	view: 0,
});

/* The panel instance whose airspaces are plotted. Plain, not reactive: it is a
 * guard the publish path reads, and an effect that read it reactively would
 * re-run on its own open (docs: the effect-writes-subscribe trap). */
let owner: object | null = null;
/* The last panel that OPENED the chart, which survives the release: it is what
 * tells a reopen by the same panel from a new panel. */
let lastOpener: object | null = null;

export const airspaceProfileModal = {
	get open(): boolean {
		return isOpen('airspaceProfile');
	},
	/** The plotted subject, null while the surface is not up, gated on
	 *  open-ness like mapProfileModal.point: an eviction that lands before the
	 *  shell registered its handler, and reflowSurfaces' own close, both go
	 *  through closeSurface directly and never through a function here. */
	get subject(): AirspaceProfileSubject | null {
		return isOpen('airspaceProfile') ? local.subject : null;
	},
	/** Moves when a DIFFERENT panel opens the chart: the surface's viewKey, so
	 *  a new panel starts from the fit while the same panel keeps a window the
	 *  pilot zoomed, which is the granularity the chart had while it was
	 *  mounted inside the panel (one instance per panel). */
	get viewKey(): number {
		return local.view;
	},
};

/** Open the chart over a panel's airspaces. `by` is the panel instance, the
 *  token its later publish and release calls must present. */
export function openAirspaceProfile(by: object, subject: AirspaceProfileSubject): void {
	if (by !== lastOpener) {
		lastOpener = by;
		local.view++;
	}
	owner = by;
	local.subject = subject;
	openSurface('airspaceProfile');
}

/** Keep an open chart in step with its panel. Inert unless `by` opened it and
 *  it is still up, so a second panel (a desktop re-render, a list row) cannot
 *  re-target a chart it never opened. */
export function publishAirspaceProfile(by: object, subject: AirspaceProfileSubject): void {
	if (owner === by && isOpen('airspaceProfile')) {
		local.subject = subject;
	}
}

/** The panel `by` is going. On a DESKTOP a DOCKED chart goes with it, since
 *  the panel is an overlay beside it and a chart that outlived the panel it
 *  plots would be answering a question nobody on screen asked. A chart
 *  maximised (a page, full) stays: maximising is what closed the panel (a
 *  page evicts the detail), and closing here took the chart down with it and,
 *  the placement being remembered, every later tap on an inline chart too. On
 *  a PHONE the panel goes BECAUSE the chart opened: one pane, so the chart is
 *  what displaced it, and closing here would undo the tap that opened it. A
 *  chart that stays keeps the last subject published, and its own close ends
 *  it. */
export function releaseAirspaceProfile(by: object): void {
	if (owner !== by) {
		return;
	}
	owner = null;
	if (ui.isMobile) {
		return;
	}
	// A microtask later, OUTSIDE the teardown this is called from. Svelte
	// answers a state read inside a teardown with the value from before the
	// flush (runtime.js get(): is_destroying_effect && old_values), so
	// closeSurface's own slot test would compare against the slots as they
	// were: it deleted the open flag and the placement and left the slot
	// claimed, which is how the phone's pane was stranded (measured). Unless
	// another panel has opened the chart since.
	queueMicrotask(() => {
		if (owner === null && isOpen('airspaceProfile') && surfaceKeepsMapVisible('airspaceProfile')) {
			closeSurface('airspaceProfile');
		}
	});
}

/** The pilot follows one of the chart's columns: the panel that opened it is
 *  navigated away (replaced, or re-targeted at the column's airspace), and
 *  neither its release nor its publishes may move the chart ("docked, nothing
 *  moves", docs/map-profile.md): a replaced panel's release closed it, and a
 *  re-targeted one re-plotted it over another point. The chart keeps its
 *  subject until it is closed or a panel opens it again. */
export function detachAirspaceProfile(): void {
	owner = null;
}

export function closeAirspaceProfile(): void {
	closeSurface('airspaceProfile');
}
