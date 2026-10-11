/* notamBlocks: the parser's splitter, shared with the briefing splice.
 *
 * It was the inside of parseNotams, a String.split over the id pattern with
 * the false headers glued back, and became a function so the aerodrome splice
 * (notam/splice.ts) cuts a briefing exactly where a parse reads one NOTAM.
 * Two things are pinned: it splits every fixture exactly as the split did
 * (the oracle below is that code, verbatim), and its offsets tile the text, so
 * cutting a block's range removes that NOTAM and nothing else. */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { notamBlocks, parseNotams } from '$lib/notam/parser';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.txt'));
const read = (file: string): string => readFileSync(new URL(file, FIXTURES), 'utf8');

/** The split parseNotams ran before notamBlocks existed. */
function splitPieces(text: string): { id: string; type: string; content: string }[] {
	const notamPattern = /(?:^|\n)\s*((?:[A-Z]{4}[\s-])?[A-Z]\d+\/\d+)\s*(NOTAM[NRC]?)?/gi;
	const parts = text.split(notamPattern);
	const pieces: { id: string; type: string; content: string }[] = [];
	for (let i = 1; i + 1 < parts.length; i += 3) {
		const id = parts[i].trim();
		const type = (parts[i + 1] || '').toUpperCase();
		const chunk = parts[i + 2] || '';
		const isHeader = type !== '' || /^\s*(?:[QA]\)|DU\s*:)/.test(chunk);
		if (!isHeader && pieces.length > 0) {
			const prev = pieces[pieces.length - 1];
			prev.content += '\n' + id + (chunk ? ' ' + chunk : '');
		} else {
			pieces.push({ id, type, content: chunk });
		}
	}
	return pieces;
}

describe('notamBlocks', () => {
	it('has fixtures to read', () => {
		expect(files.length).toBeGreaterThanOrEqual(10);
	});

	it.each(files)('splits %s exactly as the split did', (file) => {
		const text = read(file);
		const blocks = notamBlocks(text);
		expect(blocks.map(({ id, type, content }) => ({ id, type, content }))).toEqual(
			splitPieces(text),
		);
	});

	it.each(files)('tiles %s from the first header to the end', (file) => {
		const text = read(file);
		const blocks = notamBlocks(text);
		for (let i = 0; i + 1 < blocks.length; i++) {
			expect(blocks[i].end).toBe(blocks[i + 1].start);
		}
		expect(blocks.at(-1)?.end).toBe(text.length);
	});

	it('glues a false header into the block before it, offsets included', () => {
		const text = [
			'A0001/26 NOTAMN',
			'Q) LFFF/QKKKK/K/K/K/000/999/4900N00200E999',
			'A) LFFF B) 2601010000 C) 2612312359',
			'E) CHECKLIST',
			'A0002/26 A0003/26',
			'',
			'A0004/26 NOTAMN',
			'Q) LFFF/QMRLC/IV/NBO/A/000/999/4849N00237E005',
			'A) LFPL B) 2601010000 C) 2612312359',
			'E) RWY 08/26 CLSD.',
		].join('\n');
		const blocks = notamBlocks(text);
		expect(blocks.map((b) => b.id)).toEqual(['A0001/26', 'A0004/26']);
		expect(blocks[0].content).toContain('A0002/26');
		expect(text.slice(blocks[1].start, blocks[1].end)).toMatch(/^\s*A0004\/26 NOTAMN/);
		// Cutting the first block leaves the second parsing as before.
		const cut = text.slice(0, blocks[0].start) + text.slice(blocks[0].end);
		expect(parseNotams(cut)).toEqual(
			parseNotams(text).filter((n) => n.id === 'A0004/26'),
		);
	});
});
