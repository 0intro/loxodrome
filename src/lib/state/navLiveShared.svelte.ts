/* navLiveShared.svelte.ts: the live navigation state, evaluated once per
 * change whoever reads it.
 *
 * navLiveFor (navLive.svelte.ts) is a plain function, and the band, the
 * Navigation tab, the map's contact and progress effects, the route profile
 * and the nav log each ran it per tick, a replay ticking at 10 Hz: up to six
 * full evaluations of one answer (docs/performance-2026-09.md). Its readers
 * ask one of two questions, and each is one derived here: the route being
 * FLOWN (navLiveNow: the band, the tab, the map), and the route ACTIVE on the
 * planning surfaces (navLiveActive: the nav log and the route profile), which
 * is the flown one until the pilot pages elsewhere, and then the one answer
 * computed a second time.
 *
 * Both are declared at module scope on purpose: a derived made there belongs
 * to no effect, so no reader's teardown or pause can leave it answering an
 * old value. The registry these replace made one derived per route inside an
 * effect root of its own, parented to whichever reader asked first, and
 * disposed them all past eight route ids; a disposed derived answers its last
 * value forever, and a reader whose only tracked input it was never ran
 * again, which froze the nav log's and the route profile's live overlays
 * after the ninth route of a session (a Direct-To or a plan load makes one).
 *
 * A one-off question about a given route (the nav log's print, for the route
 * it captured) calls navLiveFor itself: nothing would share it. */

import { navLiveFor, type NavLiveInfo } from './navLive.svelte';
import { navRouteId } from './navRoute.svelte';
import { activeRoute } from './route.svelte';

const flown = $derived(navLiveFor(navRouteId()));

const active = $derived.by(() => {
	const id = activeRoute().id;
	return id === navRouteId() ? flown : navLiveFor(id);
});

/** The merged live state for the route being flown, at the current pose, or
 *  null while it has fewer than two waypoints. There is no master toggle: a
 *  planned route always has a live layer, and without a trace it simply has
 *  nothing to stamp (the estimate chain still briefs off an explicit ETD).
 *  Reads reactive state: call inside $derived / $effect. */
export function navLiveNow(): NavLiveInfo | null {
	return flown;
}

/** The same for the route active on the planning surfaces: navLiveNow's own
 *  answer while that is the route being flown, else the active route's. */
export function navLiveActive(): NavLiveInfo | null {
	return active;
}
