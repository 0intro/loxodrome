/* notam/splice.ts: one aerodrome's freshly fetched NOTAMs put into a loaded
 * briefing, replacing what the answer speaks for and nothing else.
 *
 * The rules come in as predicates (covers, sameSource), so this spec drives
 * each fate directly; which source covers what is aerodromeRefresh.spec.ts's.
 * The fixture cases pin the two properties the design rests on, measured
 * over the corpus before it was built: an answer that is unchanged leaves the
 * parse identical, ids included, and a NOTAM withdrawn takes nothing else
 * with it. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { notamBlocks, parseNotams } from '$lib/notam/parser';
import { bareNotamId, spliceAerodromeNotams, type SpliceRules } from '$lib/notam/splice';
import type { Notam } from '$lib/notam/types';

const read = (file: string): string =>
	readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');

interface Spec {
	id: string;
	a?: string;
	type?: string;
	replaces?: string;
	q?: string;
	e?: string;
}

/** One NOTAM as an ICAO block, filed under LFPN unless `a` says otherwise. */
function notam({ id, a = 'LFPN', type = 'NOTAMN', replaces, q, e = 'RWY 07/25 CLSD.' }: Spec): string {
	const header = replaces ? `${id} NOTAMR ${replaces}` : `${id} ${type}`;
	return [
		header,
		`Q) ${q ?? 'LFFF/QMRLC/IV/NBO/A/000/999/4845N00207E005'}`,
		`A) ${a} B) 2609010000 C) 2612312359`,
		`E) ${e}`,
	].join('\n');
}

const briefing = (...blocks: string[]): string => blocks.join('\n\n') + '\n';

/** Withdraw what the answer lacks: the source covers it and gave it. */
const SAME: SpliceRules = { covers: () => true, sameSource: () => true };

const ids = (text: string): string[] => parseNotams(text).map((n) => n.id);

describe('bareNotamId', () => {
	it('drops the location a briefing writes before the number', () => {
		expect(bareNotamId('A1234/26')).toBe('A1234/26');
		expect(bareNotamId('LFFA-A1234/26')).toBe('A1234/26');
		expect(bareNotamId('LFFF A1234/26')).toBe('A1234/26');
		expect(bareNotamId('LFPN-LFFA-a1234/26')).toBe('A1234/26');
	});
});

describe('spliceAerodromeNotams', () => {
	it('replaces a NOTAM in place and leaves other aerodromes byte for byte', () => {
		const other = notam({ id: 'B0001/26', a: 'LFPG', q: 'LFFF/QMRLC/IV/NBO/A/000/999/4900N00233E005' });
		const text = briefing(notam({ id: 'A0001/26', e: 'OLD TEXT.' }), other, notam({ id: 'A0002/26' }));
		const out = spliceAerodromeNotams(
			text,
			'lfpn',
			[notam({ id: 'A0001/26', e: 'NEW TEXT.' }), notam({ id: 'A0002/26' })],
			SAME,
		);
		expect(ids(out.text)).toEqual(['A0001/26', 'B0001/26', 'A0002/26']);
		expect(parseNotams(out.text)[0].fullContent).toContain('NEW TEXT.');
		expect(out.text).toContain(other);
		expect(out).toMatchObject({ count: 2, withdrawn: [], unconfirmed: [], kept: [], refused: 0 });
		expect(out.freshKeys).toEqual(['LFPN|A0001/26', 'LFPN|A0002/26']);
	});

	it('withdraws a NOTAM the answer lacks when it came from that source', () => {
		const text = briefing(notam({ id: 'A0001/26' }), notam({ id: 'A0002/26' }));
		const out = spliceAerodromeNotams(text, 'LFPN', [notam({ id: 'A0001/26' })], SAME);
		expect(ids(out.text)).toEqual(['A0001/26']);
		expect(out.withdrawn).toEqual(['A0002/26']);
	});

	it('keeps it, unconfirmed, when it came from elsewhere', () => {
		const text = briefing(notam({ id: 'A0001/26' }), notam({ id: 'A0002/26' }));
		const out = spliceAerodromeNotams(text, 'LFPN', [notam({ id: 'A0001/26' })], {
			covers: () => true,
			sameSource: () => false,
		});
		expect(ids(out.text)).toEqual(['A0001/26', 'A0002/26']);
		expect(out.unconfirmed).toEqual(['A0002/26']);
		expect(out.withdrawn).toEqual([]);
	});

	it('keeps it when the answer does not speak for it, and when no one can tell', () => {
		const text = briefing(notam({ id: 'A0001/26' }), notam({ id: 'A0002/26' }));
		const notCovered = spliceAerodromeNotams(text, 'LFPN', [notam({ id: 'A0001/26' })], {
			covers: () => false,
			sameSource: () => true,
		});
		expect(ids(notCovered.text)).toEqual(['A0001/26', 'A0002/26']);
		expect(notCovered.kept).toEqual(['A0002/26']);
		const unknown = spliceAerodromeNotams(text, 'LFPN', [notam({ id: 'A0001/26' })], {
			covers: () => null,
			sameSource: () => true,
		});
		expect(unknown.unconfirmed).toEqual(['A0002/26']);
	});

	it('withdraws nothing on an empty answer, a hole in coverage likelier than every NOTAM gone', () => {
		const text = briefing(notam({ id: 'A0001/26' }), notam({ id: 'A0002/26' }));
		const out = spliceAerodromeNotams(text, 'LFPN', [], SAME);
		expect(out.text).toBe(text);
		expect(out.unconfirmed).toEqual(['A0001/26', 'A0002/26']);
		expect(out.count).toBe(0);
	});

	it('withdraws what a NOTAMR of the answer replaces, whatever its source', () => {
		const text = briefing(notam({ id: 'A0001/26' }));
		const out = spliceAerodromeNotams(
			text,
			'LFPN',
			[notam({ id: 'A0009/26', replaces: 'A0001/26', e: 'RWY 07/25 CLSD UNTIL FURTHER NOTICE.' })],
			{ covers: () => true, sameSource: () => false },
		);
		expect(ids(out.text)).toEqual(['A0009/26']);
		expect(out.withdrawn).toEqual(['A0001/26']);
	});

	it('appends a NOTAM new to the briefing after everything it held', () => {
		const other = notam({ id: 'B0001/26', a: 'LFPG', q: 'LFFF/QMRLC/IV/NBO/A/000/999/4900N00233E005' });
		const text = briefing(notam({ id: 'A0001/26' }), other);
		const out = spliceAerodromeNotams(
			text,
			'LFPN',
			[notam({ id: 'A0001/26' }), notam({ id: 'A0005/26' })],
			SAME,
		);
		expect(ids(out.text)).toEqual(['A0001/26', 'B0001/26', 'A0005/26']);
	});

	it('replaces a pasted bulletin copy under its location-prefixed id', () => {
		const text = briefing(notam({ id: 'LFFA-A0001/26', e: 'OLD.' }));
		const out = spliceAerodromeNotams(text, 'LFPN', [notam({ id: 'A0001/26', e: 'NEW.' })], SAME);
		expect(ids(out.text)).toEqual(['A0001/26']);
		expect(parseNotams(out.text)[0].fullContent).toContain('NEW.');
	});

	it("never touches another aerodrome's NOTAM of the same number", () => {
		const theirs = notam({ id: 'A0001/26', a: 'LOWS', e: 'SALZBURG.', q: 'LOVV/QMRLC/IV/NBO/A/000/999/4748N01300E005' });
		const text = briefing(theirs);
		const out = spliceAerodromeNotams(text, 'LFPN', [notam({ id: 'A0001/26' })], SAME);
		expect(out.text).toContain(theirs);
		// The parser's own collision label: the briefing's NOTAM came first.
		expect(ids(out.text)).toEqual(['A0001/26', 'LFPN-A0001/26']);
	});

	it('refuses an answer record that is not one NOTAM filed under the ident', () => {
		const headerless = notam({ id: 'A0001/26' }).split('\n').slice(1).join('\n');
		const elsewhere = notam({ id: 'A0002/26', a: 'LFPG' });
		const text = briefing(notam({ id: 'B0001/26', a: 'LFPG', e: 'TWY A CLSD.' }));
		const out = spliceAerodromeNotams(text, 'LFPN', [headerless, elsewhere], SAME);
		expect(out.refused).toBe(2);
		expect(out.text).toBe(text);
		// Glued onto LFPG's NOTAM it would have rewritten that NOTAM's E).
		expect(parseNotams(out.text)[0].fullContent).not.toContain('RWY 07/25');
	});

	it('never lets a cut run a four-letter last line into the next header', () => {
		const lfpg = [
			'B0001/26 NOTAMN',
			'Q) LFFF/QMXLC/IV/M/A/000/999/4900N00233E005',
			'A) LFPG B) 2609010000 C) 2612312359',
			'E) TWY B',
			'CLSD',
		].join('\n');
		const next = notam({ id: 'B0002/26', a: 'LFPG', q: 'LFFF/QMRLC/IV/NBO/A/000/999/4900N00233E005' });
		// One blank line before the LFPN block, a single newline after it.
		const text = `${lfpg}\n\n${notam({ id: 'A0001/26' })}\n${next}\n`;
		const out = spliceAerodromeNotams(text, 'LFPN', [notam({ id: 'A0005/26' })], SAME);
		const after = parseNotams(out.text);
		expect(after.map((n) => n.id)).toEqual(['B0001/26', 'B0002/26', 'A0005/26']);
		expect(after[0].fullContent).toMatch(/CLSD$/);
	});

	it('takes the repeats of one NOTAM together', () => {
		const text = briefing(notam({ id: 'A0001/26' }), notam({ id: 'A0001/26' }));
		const out = spliceAerodromeNotams(text, 'LFPN', [notam({ id: 'A0001/26', e: 'NEW.' })], SAME);
		expect(notamBlocks(out.text).map((b) => b.id)).toEqual(['A0001/26']);
	});

	it('puts the answer into an empty briefing', () => {
		const out = spliceAerodromeNotams('', 'LFPN', [notam({ id: 'A0001/26' })], SAME);
		expect(ids(out.text)).toEqual(['A0001/26']);
		expect(out.count).toBe(1);
	});
});

/** An aerodrome's own blocks in a fixture, as an answer would bring them. */
function ownBlocks(text: string, ident: string): string[] {
	return notamBlocks(text)
		.filter((b) => {
			const a = /(?:^|\s)A\)\s*([A-Z]{4}(?:\s+[A-Z]{4})*)/i.exec(b.content)?.[1] ?? '';
			return a.toUpperCase().split(/\s+/).includes(ident);
		})
		.map((b) => text.slice(b.start, b.end));
}

const body = (n: Notam): string => JSON.stringify({ ...n, id: undefined });

// Each case parses a 12 MB world briefing more than once.
describe('over real briefings', { timeout: 60_000 }, () => {
	const worldEn = read('world-en-20260610.txt');
	const worldFr = read('world-fr-20260610.txt');
	const whole = parseNotams(worldEn);

	it.each(['LFPN', 'LFOB', 'LFMP'])('an unchanged answer for %s leaves the parse identical, ids included', (ident) => {
		const answer = ownBlocks(worldEn, ident);
		expect(answer.length).toBeGreaterThan(5);
		const out = spliceAerodromeNotams(worldEn, ident, answer, SAME);
		expect(out.withdrawn).toEqual([]);
		// The world briefing's numbers collide with LIBB, ZBYN, LHCC and
		// SKCC's: a NOTAM moved would move their labels.
		expect(parseNotams(out.text)).toEqual(whole);
	});

	it('withdraws one NOTAM and nothing else; a number another State shares changes label', () => {
		const before = parseNotams(worldFr);
		const answer = ownBlocks(worldFr, 'LFPO').filter(
			(b) => bareNotamId(notamBlocks(b)[0]?.id ?? '') !== 'A0958/26',
		);
		const out = spliceAerodromeNotams(worldFr, 'LFPO', answer, SAME);
		expect(out.withdrawn).toEqual(['A0958/26']);
		const after = parseNotams(out.text);
		const gone = before.filter((n) => n.id === 'A0958/26').map(body);
		expect(after.map(body)).toEqual(before.map(body).filter((b) => !gone.includes(b)));
		// Salzburg's A0958/26 was second, so labelled; it now comes first.
		expect(before.some((n) => n.id === 'LOWS-A0958/26')).toBe(true);
		expect(after.some((n) => n.id === 'LOWS-A0958/26')).toBe(false);
		expect(after.filter((n) => n.id === 'A0958/26').every((n) => n.icaoCodes[0] === 'LOWS')).toBe(true);
	});
});
