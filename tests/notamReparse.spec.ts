/* A re-parse of the loaded briefing keeps what the pilot has open.
 *
 * The briefing is re-parsed when an airport merge places an "RDL .../... ARP"
 * anchor the first parse could not, and a merge happens whenever a country
 * loads late: a pan, a route, the briefing's own publishers. The re-parse
 * cleared the detail panel and its back stack, so the NOTAM being read closed
 * under the reader as the map crossed a border (measured in the browser: a pan
 * from Paris to Vienna, detail {kind notam, index 1} to null).
 *
 * Keeping the INDEX is not enough. A NOTAM with no Q-line has no entry at all
 * until its anchor resolves, so its first entry moves every later one down by
 * one; the panel follows its ENTRY, named by its NOTAM and its rank among that
 * NOTAM's entries. And the re-parse reads the briefing that is loaded, never the
 * paste box, which binds the same raw text and can hold an edit nobody has
 * displayed yet. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.hoisted(() => ({ known: new Map<string, { lat: number; lon: number }>() }));
vi.mock('$lib/state/data.svelte', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/state/data.svelte')>();
	return {
		...real,
		airportLookup: (ident: string) => lookup.known.get(ident.toUpperCase()) ?? null,
	};
});

const { clearNotams, notamState, parseInput } = await import('$lib/state/notam.svelte');
const { navigateToNotam, selectNotam, toggleNotamQRadius, ui } = await import('$lib/state/ui.svelte');

const LFPL = { lat: 48.8231, lon: 2.6239 };

const TEXT = `A1234/26 NOTAMN
Q) LFFF/QOBCE/IV/M/A/000/005/4849N00237E005
A) LFPL B) 2609010000 C) 2612312359
E) CRANE ERECTED RDL 194/0.25NM ARP LFPL. HGT 150FT.

A1235/26 NOTAMN
Q) LFFF/QMRLC/IV/NBO/A/000/999/4849N00237E005
A) LFPL B) 2609010000 C) 2612312359
E) RWY 08/26 CLSD.`;

// The first NOTAM states no Q-line, so until LFPL resolves it has no position
// to take and no entry: the crane after it is entry 0, then entry 1.
const NO_QLINE_FIRST = `A2001/26 NOTAMN
A) LFPL B) 2609010000 C) 2612312359
E) MAST ERECTED RDL 090/1NM ARP LFPL. HGT 200FT.

A2002/26 NOTAMN
Q) LFFF/QOBCE/IV/M/A/000/005/4849N00237E005
A) LFPL B) 2609010000 C) 2612312359
E) CRANE ERECTED RDL 194/0.25NM ARP LFPL. HGT 150FT.`;

function openId(): string | null {
	return ui.detail?.kind === 'notam' ? (notamState.notams[ui.detail.index]?.id ?? null) : null;
}

beforeEach(() => {
	lookup.known.clear();
	clearNotams();
	ui.qRadiusIndex = null;
});

describe('a re-parse of the loaded briefing', () => {
	it('keeps the NOTAM panel the pilot is reading', () => {
		notamState.rawText = TEXT;
		parseInput();
		selectNotam(1);
		const before = JSON.stringify(ui.detail);
		parseInput({ reparse: true });
		expect(JSON.stringify(ui.detail)).toBe(before);
	});

	it('keeps the back stack', () => {
		notamState.rawText = TEXT;
		parseInput();
		selectNotam(0);
		navigateToNotam(1);
		parseInput({ reparse: true });
		expect(ui.detail).toMatchObject({ kind: 'notam', index: 1 });
		expect(ui.detailBack).toMatchObject({ kind: 'notam', index: 0 });
	});

	it('follows an entry that an earlier anchor pushed down', () => {
		notamState.rawText = NO_QLINE_FIRST;
		parseInput();
		expect(notamState.notams.map((n) => n.id)).toEqual(['A2002/26']);
		selectNotam(0);
		toggleNotamQRadius(0);

		lookup.known.set('LFPL', LFPL);
		parseInput({ reparse: true });
		expect(notamState.notams.map((n) => n.id)).toEqual(['A2001/26', 'A2002/26']);
		expect(openId()).toBe('A2002/26');
		expect(ui.qRadiusIndex).toBe(ui.detail?.kind === 'notam' ? ui.detail.index : -1);
	});

	it('closes a panel whose entry is gone, and drops a back target that is', () => {
		lookup.known.set('LFPL', LFPL);
		notamState.rawText = NO_QLINE_FIRST;
		parseInput();
		selectNotam(1);
		navigateToNotam(0);
		expect(openId()).toBe('A2001/26');

		// The aerodrome no longer resolves (a later merge replaced its row),
		// so the Q-line-less NOTAM has nowhere to be drawn and no entry.
		lookup.known.clear();
		parseInput({ reparse: true });
		expect(ui.detail).toBeNull();
		expect(ui.detailBack).toBeNull();

		lookup.known.set('LFPL', LFPL);
		parseInput({ reparse: true });
		selectNotam(0);
		navigateToNotam(1);
		lookup.known.clear();
		parseInput({ reparse: true });
		expect(openId()).toBe('A2002/26');
		expect(ui.detailBack).toBeNull();
	});

	it('reads the briefing that is loaded, not the paste box', () => {
		notamState.rawText = TEXT;
		parseInput();
		selectNotam(1);
		// The box binds the same raw text: an edit in progress is not a briefing.
		notamState.rawText = 'A9999/26 NOTAMN\nQ) LFFF/QOBCE/IV/M/A/000/005/4849N00237E005\nE) DRAFT';
		parseInput({ reparse: true });
		expect(notamState.notams.map((n) => n.id)).toEqual(['A1234/26', 'A1235/26']);
		expect(openId()).toBe('A1235/26');
		expect(notamState.rawText).toContain('A9999/26');
	});
});

describe('a fresh parse', () => {
	it('closes the panel and forgets the Q radius it had on', () => {
		notamState.rawText = TEXT;
		parseInput();
		selectNotam(1);
		toggleNotamQRadius(1);
		parseInput();
		expect(ui.detail).toBeNull();
		// An index held across a new briefing names an unrelated NOTAM: the
		// first one opened at that index would come up with its circle drawn.
		expect(ui.qRadiusIndex).toBeNull();
	});
});
