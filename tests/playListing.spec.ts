/* The store listing in android/play/listings, as play-listing.js puts it to
 * Play: within Play's limits, with the disclaimer and the official sources
 * the Misleading Claims policy asks of an app showing government
 * information (the update of 2026-10-02 was rejected for lacking them), the
 * same links in every language, so that a source added in one is added in
 * all, and the French spaced as the catalogs are. Importing the script runs
 * nothing. */

import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkListing, links } from '../scripts/play-listing.js';

const LISTING = 'android/play/listings';

/** Each case breaks a copy of the listing in one way. */
const BROKEN: { name: string; edit: (dir: string) => void; want: RegExp }[] = [
	{
		name: 'a title past 30 characters',
		edit: (dir) => writeFileSync(join(dir, 'en-US/title.txt'), 'Loxodrome, the aeronautical chart\n'),
		want: /^en-US\/title\.txt is 33 characters, Play takes 30$/,
	},
	{
		name: 'an empty short description',
		edit: (dir) => writeFileSync(join(dir, 'fr-FR/short-description.txt'), '\n'),
		want: /^fr-FR\/short-description\.txt is empty$/,
	},
	{
		name: 'a missing full description',
		edit: (dir) => unlinkSync(join(dir, 'en-US/full-description.txt')),
		want: /^en-US\/full-description\.txt is missing$/,
	},
	{
		name: 'a French colon after a plain space',
		edit: (dir) => writeFileSync(join(dir, 'fr-FR/short-description.txt'), 'Cartes aéronautiques : NOTAM, météo.\n'),
		want: /^fr-FR\/short-description\.txt wants U\+202F/,
	},
	{
		name: 'a full description without its disclaimer',
		edit: (dir) => {
			const p = join(dir, 'en-US/full-description.txt');
			writeFileSync(p, readFileSync(p, 'utf8').replace('NOT A GOVERNMENT APPLICATION\n', ''));
		},
		want: /NOT A GOVERNMENT APPLICATION paragraph$/,
	},
	{
		name: 'a source linked in one language alone',
		edit: (dir) => {
			const p = join(dir, 'en-US/full-description.txt');
			writeFileSync(p, readFileSync(p, 'utf8').replace('\nOpen source:', '\nMalta: TM https://www.transport.gov.mt\nOpen source:'));
		},
		want: /^https:\/\/www\.transport\.gov\.mt is in en-US\/full-description\.txt alone$/,
	},
];

let scratch: string | undefined;

afterEach(() => {
	if (scratch) {
		rmSync(scratch, { recursive: true, force: true });
		scratch = undefined;
	}
});

describe('the store listing', () => {
	it('can go to Play as the tree holds it', () => {
		expect(checkListing(LISTING)).toEqual([]);
	});

	it('links every official source in its full descriptions', () => {
		const en = links(readFileSync(join(LISTING, 'en-US/full-description.txt'), 'utf8'));
		expect(en).toContain('https://sia.aviation-civile.gouv.fr');
		expect(en.every((u) => !u.endsWith('.') && !u.endsWith(','))).toBe(true);
	});

	it.each(BROKEN)('refuses $name', ({ edit, want }) => {
		scratch = mkdtempSync(join(tmpdir(), 'listing-'));
		cpSync(LISTING, scratch, { recursive: true });
		edit(scratch);
		const problems = checkListing(scratch);
		expect(problems.some((p) => want.test(p)), problems.join('\n')).toBe(true);
	});
});
