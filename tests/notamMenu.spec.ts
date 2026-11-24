/* The stacked-NOTAM menu holds each row's index into the parsed briefing
 * (map/notamLayer.ts snapshots it when the pin's menu opens), and a click
 * selects by that index. Every parse hands out a new array, a fetch that
 * commits, an aerodrome merge's re-parse or a splice renumbering it, so a
 * row clicked after one opened whatever NOTAM had come to sit at its old
 * index. A parse and a clear close the menu. */

import { beforeEach, describe, expect, it } from 'vitest';
import { notamMenu, openNotamMenu } from '$lib/state/notamMenu.svelte';
import { clearNotams, notamState, parseInput } from '$lib/state/notam.svelte';

const BRIEFING = `A0001/26 NOTAMN
Q) LFFF/QRRCA/IV/BO/W/000/055/4500N00100W005
A) LFFF B) 2607010000 C) 2612310000
E) LF-R262 ACTIVE.

A0002/26 NOTAMN
Q) LFFF/QRRCA/IV/BO/W/000/055/4500N00100W005
A) LFFF B) 2607010000 C) 2612310000
E) LF-R263 ACTIVE.
`;

function openOnBoth(): void {
	openNotamMenu(
		notamState.notams.map((notam, index) => ({ notam, index })),
		10,
		10,
	);
	expect(notamMenu.open).toBe(true);
}

beforeEach(() => {
	notamState.rawText = BRIEFING;
	parseInput();
});

describe('the stacked-NOTAM menu', () => {
	it('closes when the briefing is parsed again', () => {
		openOnBoth();
		parseInput({ reparse: true });
		expect(notamMenu.open).toBe(false);
		expect(notamMenu.items).toEqual([]);
	});

	it('closes when a new briefing is parsed', () => {
		openOnBoth();
		notamState.rawText = BRIEFING.replace('LF-R263', 'LF-R264');
		parseInput();
		expect(notamMenu.open).toBe(false);
	});

	it('closes when the briefing is cleared', () => {
		openOnBoth();
		clearNotams();
		expect(notamMenu.open).toBe(false);
		expect(notamMenu.items).toEqual([]);
	});
});
