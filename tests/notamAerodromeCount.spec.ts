/* The NOTAMs an aerodrome lists (state/notam.svelte.ts aerodromeNotams):
 * one row per source NOTAM, the QKKKK checklists left out, the rule its
 * panel lists by. The Airports tab's badge and the context menu counted
 * notamsByIdent() entries instead, which list a multi-area NOTAM once per
 * area and a checklist reaching the ident through a collision with a FIR
 * (UAAA Almaty is both), so a row read 3 NOTAMs where the panel listed 1. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNotams } from '$lib/notam';
import { filter } from '$lib/state/filter.svelte';
import { aerodromeNotams, notamsByIdent, notamState } from '$lib/state/notam.svelte';

const NOW = '2026-07-31T12:00:00Z';

const AERODROME = `A0002/26
Q) UAAA/QMRLC/IV/NBO/A/000/999/4316N07702E005
A) UAAA
B) 2607010000 C) 2612310000
E) RWY 05L/23R CLSD.
`;

const CHECKLIST = `C0100/26
Q) UAAA/QKKKK/K/K/K/000/999/4316N07702E999
A) UAAA
B) 2607010000 C) 2608010000
E) CHECKLIST
`;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(NOW));
	filter.window.mode = 'now';
	filter.query = '';
	const [aerodrome] = parseNotams(AERODROME);
	// A multi-area NOTAM is several entries sharing the source's id.
	notamState.notams = [aerodrome, { ...aerodrome }, ...parseNotams(CHECKLIST)];
	notamState.parsedAt = Date.now();
});

afterEach(() => {
	vi.useRealTimers();
	notamState.notams = [];
});

describe('aerodromeNotams', () => {
	it('lists one row per source NOTAM and no checklist', () => {
		expect(notamsByIdent().get('UAAA')).toHaveLength(3);
		expect(aerodromeNotams('UAAA').map((it) => it.notam.id)).toEqual(['A0002/26']);
		expect(aerodromeNotams('uaaa')).toHaveLength(1);
		expect(aerodromeNotams('LFPN')).toEqual([]);
	});

	it('is what the counts beside the panel read', () => {
		const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');
		expect(read('src/lib/components/tabs/AirportsTab.svelte')).toContain(
			'{@const n = aerodromeNotams(a.ident).length}',
		);
		expect(read('src/lib/components/ContextMenu.svelte')).toContain(
			'{@const notamCount = aerodromeNotams(ap.ident).length}',
		);
		expect(read('src/lib/components/detail/AirportDetail.svelte')).toContain(
			'const matchedUnique = $derived(aerodromeNotams(airport.ident));',
		);
	});
});
