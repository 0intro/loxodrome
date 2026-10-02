/* Open/close for the route vertical-profile surface: the plain trio
 * (state/surfaceControls.ts). The detail panel's back arrow keeps
 * openRouteProfile, since a reopen must never close; the Route tab's
 * button toggles. */

import { surfaceControls } from './surfaceControls';

const trio = surfaceControls('routeProfile');

export const routeProfileModal = trio.state;
export const openRouteProfile = trio.open;
export const toggleRouteProfile = trio.toggle;
export const closeRouteProfile = trio.close;
