/* Where the map's two bottom corners stand against its foot (MapView
 * .map-foot: the time strips, or the chips they fold into): the bottom-left
 * column (the undo chip, the terrain legend, the cursor badge) and Leaflet's
 * corner credit.
 *
 * The foot is a centred box at most 640 px wide. On a phone it spans the
 * map, and the corners stand on it. On a desktop map it leaves room on each
 * side, and a corner standing on a strip with that room beside it read as
 * the strip pushed under the badge and the credit. So on the desktop each
 * corner keeps its corner, on the strip's own baseline, while the room beside
 * the foot's box holds it, and stands on the foot only where it would reach
 * it. The foot itself never moves either way.
 *
 * Pure and Leaflet-free: MapView measures (the map's width, the foot's box,
 * the column's width) and this decides. */

/** The foot's and both corners' distance from the map's side edges, CSS px
 *  (MapView .map-foot and .corner-bl `left: 8px`, the credit's
 *  `right: max(8px, --sar)` in app.css). The room below takes the foot's
 *  right inset as this too, which holds while the safe area is under 8 px: a
 *  desktop's. */
export const FOOT_SIDE_PX = 8;

/** The gap a corner keeps from the foot, beside it as above it (the 6 px of
 *  the stacked stances' `min(var(--map-foot-h), 6px)`). */
export const FOOT_GAP_PX = 6;

/** The narrowest room the credit is laid beside the foot in, CSS px. It
 *  wraps there rather than reaching over the strip, so this bounds how many
 *  lines it takes for its five seconds; under it, it stands on the foot in
 *  as few lines as the map's width allows. */
export const CREDIT_MIN_ROOM_PX = 200;

/** How much room to spare a column standing on the foot needs before it comes
 *  back down beside it. The cursor badge's width breathes with its digits
 *  (an unpadded decimal line) and the terrain legend's with GPS ALT: without
 *  the margin, a map whose room matched the column's width would move the
 *  column up and down as the pointer crossed a meridian. */
export const COLUMN_RETURN_PX = 16;

/** The free room on EACH side of the foot's box, its gap taken, CSS px. The
 *  box is centred between FOOT_SIDE_PX from the map's left edge and
 *  FOOT_SIDE_PX plus the open desktop detail panel (`inset`) from its right,
 *  so the two sides get the same room, the credit's right edge standing on
 *  the same line as the foot's (the panel hides the credit while it is
 *  open). `footW` is the box's measured width, which carries its 640 px cap.
 *  Never negative. */
export function footRoom(mapW: number, footW: number, inset: number): number {
	return Math.max(0, (mapW - 2 * FOOT_SIDE_PX - inset - footW) / 2 - FOOT_GAP_PX);
}

/** Whether the bottom-left column stands BESIDE the foot, given where it
 *  stood: one beside goes up the moment it would touch the foot's box, one on
 *  the foot comes back down only with COLUMN_RETURN_PX to spare. An emptied
 *  column (0) comes back beside, so what shows in it next starts there. */
export function columnBeside(wasBeside: boolean, columnW: number, room: number): boolean {
	return columnW + (wasBeside ? 0 : COLUMN_RETURN_PX) <= room;
}

/** Whether the corner credit stands beside the foot, in a container exactly
 *  `room` wide: by the geometry alone, which no pointer moves. */
export function creditBeside(room: number): boolean {
	return room >= CREDIT_MIN_ROOM_PX;
}
