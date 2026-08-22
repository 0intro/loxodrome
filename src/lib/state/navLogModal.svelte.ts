/* Open/close for the navigation-log ("log de nav") surface: the plain trio
 * (state/surfaceControls.ts). The entry points are buttons that stay
 * reachable beside a docked surface, so they toggle. */

import { surfaceControls } from './surfaceControls';

const trio = surfaceControls('navlog');

export const navLogModal = trio.state;
export const toggleNavLog = trio.toggle;
export const closeNavLog = trio.close;
