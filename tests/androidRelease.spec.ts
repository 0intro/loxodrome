/* What an Android release reads from the tree. The release workflow takes
 * versionCode and versionName from android/app/build.gradle, with the sed
 * patterns this spec mirrors, while the site, the About chip and the lock
 * carry package.json's version: one version, in four places. And it sends
 * android/release-notes.txt to Play, which takes 500 characters a language
 * (a French draft ran 620 in October), in English and in French, the French
 * spaced as the catalogs are. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkArgs, parseArgs, parseNotes } from '../scripts/play-release.js';

const NOTES = 'android/release-notes.txt';
const read = (f: string): string => readFileSync(f, 'utf8');

describe('the Android release', () => {
	it('carries one version, in build.gradle, package.json and the lock', () => {
		const gradle = read('android/app/build.gradle');
		const codes = [...gradle.matchAll(/^ *versionCode ([0-9]+)$/gm)];
		const names = [...gradle.matchAll(/^ *versionName "(.*)"$/gm)];
		expect(codes).toHaveLength(1);
		expect(names).toHaveLength(1);
		const version = names[0][1];
		const pkg = JSON.parse(read('package.json')) as { version: string };
		const lock = JSON.parse(read('package-lock.json')) as {
			version: string;
			packages: Record<string, { version?: string }>;
		};
		expect(pkg.version).toBe(version);
		expect(lock.version).toBe(version);
		expect(lock.packages[''].version).toBe(version);
	});

	it('sends notes in English and French, each within the 500 characters Play takes', () => {
		const text = read(NOTES);
		expect(checkArgs(parseArgs(['--aab', 'app.aab', '--track', 'internal', '--notes', NOTES]), text)).toBeNull();
		const notes = parseNotes(text);
		expect(notes.map((n) => n.language)).toEqual(['en-US', 'fr-FR']);
		for (const n of notes) {
			expect([...n.text].length, n.language).toBeLessThanOrEqual(500);
		}
	});

	it('puts a narrow no-break space before each French : ; ! ?, as the catalogs do', () => {
		const fr = parseNotes(read(NOTES)).find((n) => n.language === 'fr-FR');
		expect(fr).toBeDefined();
		const prose = (fr?.text ?? '').replace(/https?:\/\/\S+/g, '');
		expect(prose).not.toMatch(/(^|[^\u202f])[:;!?]/);
	});
});
