/* Where the map's bottom corners stand against its foot (map/footStance.ts):
 * on a desktop map each keeps its corner beside the strips while the room
 * beside the foot's box holds it, and stands on the foot only where it would
 * reach it. The room is the arithmetic of MapView's .map-foot box (8 px from
 * each side, the open detail panel's width off the right, its measured width
 * centred between), the 6 px gap taken. */

import { describe, expect, it } from 'vitest';
import {
	COLUMN_RETURN_PX,
	CREDIT_MIN_ROOM_PX,
	FOOT_GAP_PX,
	FOOT_SIDE_PX,
	columnBeside,
	creditBeside,
	footRoom,
} from '$lib/map/footStance';

describe('the room beside the foot', () => {
	it('is what the centred box leaves on each side, its gap taken', () => {
		// A 1500 px map, the strip at its 640 px cap: 422 px each side, 416
		// once the gap is kept.
		expect(footRoom(1500, 640, 0)).toBe(416);
		expect(footRoom(1500, 640, 0)).toBe((1500 - 2 * FOOT_SIDE_PX - 640) / 2 - FOOT_GAP_PX);
	});

	it('shrinks by half the open detail panel, the box centring in what is left', () => {
		expect(footRoom(1500, 640, 400)).toBe(216);
	});

	it('is none where the box spans the map, never negative', () => {
		// A phone's foot: the box takes the whole width.
		expect(footRoom(392, 376, 0)).toBe(0);
		// A desktop map narrower than the cap plus the room a badge takes.
		expect(footRoom(900, 640, 0)).toBe(116);
		// The open panel leaves the box less than its cap: it fills what is
		// left, and nothing is beside it.
		expect(footRoom(1000, 1000 - 2 * FOOT_SIDE_PX - 400, 400)).toBe(0);
	});
});

describe("the bottom-left column's stance", () => {
	it('stands beside while it fits, at equality included', () => {
		expect(columnBeside(true, 150, 416)).toBe(true);
		expect(columnBeside(true, 416, 416)).toBe(true);
	});

	it('goes up the moment it would touch the foot', () => {
		expect(columnBeside(true, 417, 416)).toBe(false);
	});

	it('comes back down only with room to spare, so a breathing width never flips it', () => {
		const room = 160;
		// The cursor badge at the room's edge: up, then held up while its
		// digits make it a few px narrower or wider.
		let beside = columnBeside(true, 162, room);
		expect(beside).toBe(false);
		for (const w of [158, 161, 155, 162, 157]) {
			beside = columnBeside(beside, w, room);
			expect(beside).toBe(false);
		}
		expect(columnBeside(false, room - COLUMN_RETURN_PX + 1, room)).toBe(false);
		expect(columnBeside(false, room - COLUMN_RETURN_PX, room)).toBe(true);
	});

	it('comes back beside once emptied, so what shows next starts there', () => {
		expect(columnBeside(false, 0, 116)).toBe(true);
		// Unless there is no room at all beside the foot.
		expect(columnBeside(false, 0, 0)).toBe(false);
		expect(columnBeside(true, 0, 0)).toBe(true);
	});
});

describe("the credit's stance", () => {
	it('stands beside from its minimum room, which no pointer moves', () => {
		expect(creditBeside(CREDIT_MIN_ROOM_PX)).toBe(true);
		expect(creditBeside(CREDIT_MIN_ROOM_PX - 1)).toBe(false);
		expect(creditBeside(416)).toBe(true);
		expect(creditBeside(0)).toBe(false);
	});
});
