/* Types for play-release.js, so tests/playRelease.spec.ts can check the
 * argument rules without linting `any`. The script itself stays plain JS,
 * build tooling outside the app tsconfig like gen-privacy.js. */

export interface PlayReleaseArgs {
	key: string;
	package: string;
	status: string;
	/** --status was stated on the command line. */
	statusGiven: boolean;
	dryRun: boolean;
	aab?: string;
	versionCode?: string;
	track?: string;
	/** As typed: checkArgs judges it. */
	fraction?: string;
	notes?: string;
	name?: string;
}

export function parseArgs(argv: string[]): PlayReleaseArgs;

/** The Console's `<xx-XX>…</xx-XX>` blocks. */
export function parseNotes(text: string): { language: string; text: string }[];

/** Why the arguments cannot make a release, or null. */
export function checkArgs(args: PlayReleaseArgs, notesText: string | undefined): string | null;
