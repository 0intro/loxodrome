/* Open/close for the navigation-trace vertical-profile surface: the plain
 * trio (state/surfaceControls.ts). Both profiles default to the bottom
 * dock, so opening this one takes that slot from the route profile; the
 * workspace does that eviction, which is why no module here reaches into
 * another to close it. The detail panel's back arrow keeps openNavProfile,
 * since a reopen must never close; the Navigation tab's button toggles. */

import { surfaceControls } from './surfaceControls';

const trio = surfaceControls('navProfile');

export const navProfileModal = trio.state;
export const openNavProfile = trio.open;
export const toggleNavProfile = trio.toggle;
export const closeNavProfile = trio.close;
