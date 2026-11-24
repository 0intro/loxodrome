/* The Play release script's argument rules (scripts/play-release.js), checked
 * before the key is read or the API asked anything: a notes file with no
 * block went out as a release without notes, a production release took
 * "completed" by default and rolled out to every user once approved, and a
 * fraction that was not a number went to the API as null. Importing the
 * script runs nothing. */

import { describe, expect, it } from 'vitest';
import { checkArgs, parseArgs } from '../scripts/play-release.js';

const NOTES = '<en-US>AIRAC 2610 data.</en-US>\n<fr-FR>Données AIRAC 2610.</fr-FR>\n';

describe('the Play release arguments', () => {
	it('take an ordinary internal release', () => {
		const a = parseArgs(['--aab', 'app.aab', '--track', 'internal', '--notes', 'n.txt']);
		expect(checkArgs(a, NOTES)).toBeNull();
	});

	it('take one release to several tracks, in the order given', () => {
		const a = parseArgs(['--aab', 'app.aab', '--track', 'internal', '--track', 'alpha', '--notes', 'n.txt']);
		expect(a.tracks).toEqual(['internal', 'alpha']);
		expect(checkArgs(a, NOTES)).toBeNull();
	});

	it('want a track, and exactly one of an upload and a promotion', () => {
		expect(checkArgs(parseArgs(['--aab', 'app.aab', '--notes', 'n.txt']), NOTES)).toMatch(/--track is required/);
		expect(checkArgs(parseArgs(['--track', 'internal', '--notes', 'n.txt']), NOTES)).toMatch(/exactly one of --aab/);
		expect(
			checkArgs(parseArgs(['--aab', 'app.aab', '--version-code', '4', '--track', 'internal', '--notes', 'n.txt']), NOTES),
		).toMatch(/exactly one of --aab/);
	});

	it('refuse notes holding no block, or text outside one', () => {
		const a = parseArgs(['--aab', 'app.aab', '--track', 'internal', '--notes', 'n.txt']);
		expect(checkArgs(a, 'AIRAC 2610 data.')).toMatch(/no <xx-XX>/);
		expect(checkArgs(a, '<en-US>AIRAC 2610.</en-US>\n<fr-FR>AIRAC 2610.</fr_FR>')).toMatch(/outside a block/);
	});

	it('want an explicit status for production', () => {
		expect(checkArgs(parseArgs(['--version-code', '2', '--track', 'production']), undefined)).toMatch(/explicit --status/);
		expect(checkArgs(parseArgs(['--version-code', '2', '--track', 'alpha', '--track', 'production']), undefined)).toMatch(
			/explicit --status/,
		);
		expect(checkArgs(parseArgs(['--version-code', '2', '--track', 'production', '--status', 'completed']), undefined)).toBeNull();
		expect(checkArgs(parseArgs(['--version-code', '2', '--track', 'production', '--status', 'draft']), undefined)).toBeNull();
	});

	it('want a fraction above 0 and below 1 for a staged rollout, and none otherwise', () => {
		const staged = (f: string) => parseArgs(['--version-code', '2', '--track', 'production', '--status', 'inProgress', '--fraction', f]);
		expect(checkArgs(staged('0.2'), undefined)).toBeNull();
		for (const f of ['abc', '0', '1', '1.5', '-0.1', '']) {
			expect(checkArgs(staged(f), undefined), f).toMatch(/--fraction above 0/);
		}
		expect(checkArgs(parseArgs(['--version-code', '2', '--track', 'production', '--status', 'inProgress']), undefined)).toMatch(/--fraction above 0/);
		expect(checkArgs(parseArgs(['--version-code', '2', '--track', 'internal', '--fraction', '0.2']), undefined)).toMatch(/inProgress only/);
	});

	it('refuse a status the API does not take', () => {
		expect(checkArgs(parseArgs(['--version-code', '2', '--track', 'internal', '--status', 'complete']), undefined)).toMatch(/--status must be/);
	});

	it('leave a dry run alone', () => {
		expect(checkArgs(parseArgs(['--dry-run']), undefined)).toBeNull();
	});
});
