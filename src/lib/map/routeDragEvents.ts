/* routeDragEvents.ts: the map-level events a route drag announces, a pin
 * moved or a leg dragged out into a new waypoint (map/routeLayer.ts), so
 * follow mode holds the map still under the pointer the way it does for a
 * pan (map/navLayer.ts): a pan under a dragged pin moves the ground away
 * from the finger and lands the waypoint somewhere nobody pointed. A module
 * of their own, as keyPan.ts's pair lives with keyPan, so navLayer hears them
 * without loading the route layer. */

export const ROUTE_DRAG_START = 'routedragstart';
export const ROUTE_DRAG_END = 'routedragend';
