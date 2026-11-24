/* play-release.js: put a build on Google Play tracks through the Play
 * Developer API, with Node's own fetch and crypto alone.
 *
 * The Android app carries its aeronautical datasets inside the bundle, so it
 * needs a release every AIRAC cycle (docs/play-release.md, "Each AIRAC
 * cycle"); this is that release in one command instead of a Console session.
 * It authenticates as the loxodrome-publisher service account (project
 * loxodrome-publish, invited in the Play Console with release rights on this
 * app only), opens an edit, uploads the bundle or names one already uploaded,
 * sets each track's release with its notes, and commits.
 *
 *	npm run play:release -- --aab <app-release.aab> --track internal \
 *		--track alpha --notes <notes.txt>
 *	npm run play:release -- --version-code 2 --track production \
 *		--notes <notes.txt>                   (promote, no upload)
 *	npm run play:release -- --dry-run           (auth + tracks, no change)
 *
 * --key      the service-account JSON (default local/android/play-publisher.json,
 *            gitignored; never commit it)
 * --package  default fr.loxodrome.app
 * --track    internal | alpha (the closed track) | beta | production, once
 *            per track: one edit sets the same release on each and commits
 *            once, so a run that fails leaves Play as it was
 * --status   completed (default) | draft | inProgress (with --fraction, above 0
 *            and below 1) | halted; production takes no default, since
 *            completed there rolls the release out to every user once approved
 * --notes    release notes in the Console's own form, nothing outside a block:
 *            <en-US>text</en-US> <fr-FR>texte</fr-FR>
 *
 * The arguments are checked before anything is asked of the API
 * (checkArgs): a run with no track, or with both or neither of --aab and
 * --version-code, a notes file holding no block, or text outside one (a tag
 * mistyped leaves its language out), a fraction that is not one, or a
 * production release with no stated status stops the command there.
 *
 * A committed edit whose changes need review is sent for review as the
 * Console's "Send for review" would; the answer, and every error, is the
 * API's own text, printed as is. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPLOAD, accessToken, call, withEdit } from './play-api.js';

/** The release statuses the API takes. */
const STATUSES = ['completed', 'draft', 'inProgress', 'halted'];

export function parseArgs(argv) {
	const out = {
		key: 'local/android/play-publisher.json',
		package: 'fr.loxodrome.app',
		status: 'completed',
		statusGiven: false,
		dryRun: false,
		tracks: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) {
				throw new Error(`${a} needs a value`);
			}
			return v;
		};
		switch (a) {
			case '--key':
				out.key = next();
				break;
			case '--package':
				out.package = next();
				break;
			case '--aab':
				out.aab = next();
				break;
			case '--version-code':
				out.versionCode = next();
				break;
			case '--track':
				out.tracks.push(next());
				break;
			case '--status':
				out.status = next();
				out.statusGiven = true;
				break;
			case '--fraction':
				out.fraction = next();
				break;
			case '--notes':
				out.notes = next();
				break;
			case '--name':
				out.name = next();
				break;
			case '--dry-run':
				out.dryRun = true;
				break;
			default:
				throw new Error(`unknown argument ${a}`);
		}
	}
	return out;
}

const NOTE_BLOCK = /<([a-z]{2}(?:-[A-Z]{2})?)>([\s\S]*?)<\/\1>/g;

/** `<en-US>…</en-US>` blocks, the Console's release-notes form. */
export function parseNotes(text) {
	const notes = [];
	for (const m of text.matchAll(NOTE_BLOCK)) {
		notes.push({ language: m[1], text: m[2].trim() });
	}
	return notes;
}

/** The reason the arguments cannot make a release, or null. `notesText` is
 *  the --notes file's content. Checked before the key is read or the API
 *  asked anything. */
export function checkArgs(args, notesText) {
	if (args.dryRun) {
		return null;
	}
	if (args.tracks.length === 0) {
		return '--track is required';
	}
	if (!args.aab === !args.versionCode) {
		return 'give exactly one of --aab (upload) and --version-code (promote)';
	}
	if (!STATUSES.includes(args.status)) {
		return `--status must be one of ${STATUSES.join(', ')}`;
	}
	if (args.tracks.includes('production') && !args.statusGiven) {
		return '--track production needs an explicit --status: completed rolls the release out to every user once approved';
	}
	if (args.status === 'inProgress') {
		const f = Number(args.fraction);
		if (args.fraction === undefined || !Number.isFinite(f) || f <= 0 || f >= 1) {
			return '--status inProgress needs --fraction above 0 and below 1';
		}
	} else if (args.fraction !== undefined) {
		return '--fraction goes with --status inProgress only';
	}
	if (notesText !== undefined) {
		if (parseNotes(notesText).length === 0) {
			return 'the notes hold no <xx-XX>…</xx-XX> block, and a release would go out without notes';
		}
		const outside = notesText.replace(NOTE_BLOCK, '').trim();
		if (outside !== '') {
			return `the notes hold text outside a block (a mistyped tag leaves its language out): ${outside.slice(0, 60)}`;
		}
	}
	return null;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const notesText = args.notes ? readFileSync(args.notes, 'utf-8') : undefined;
	const refused = checkArgs(args, notesText);
	if (refused) {
		throw new Error(refused);
	}
	const key = JSON.parse(readFileSync(args.key, 'utf-8'));
	const token = await accessToken(key);
	await withEdit(token, args.package, async (edit) => {
		console.log(`edit ${edit.id} opened as ${key.client_email}`);
		if (args.dryRun) {
			const tracks = await call(token, 'GET', `${edit.url}/tracks`);
			for (const t of tracks.tracks ?? []) {
				const releases = (t.releases ?? []).map(
					(r) => `${r.name ?? '?'} [${(r.versionCodes ?? []).join(',')}] ${r.status}`,
				);
				console.log(`track ${t.track}: ${releases.join('; ') || 'no release'}`);
			}
			return;
		}
		let versionCode = args.versionCode;
		if (args.aab) {
			const bytes = readFileSync(args.aab);
			const bundle = await call(
				token,
				'POST',
				`${UPLOAD}/${encodeURIComponent(args.package)}/edits/${edit.id}/bundles?uploadType=media`,
				bytes,
				'application/octet-stream',
			);
			versionCode = String(bundle.versionCode);
			console.log(`uploaded versionCode ${versionCode} (sha256 ${bundle.sha256})`);
		}
		const release = {
			versionCodes: [String(versionCode)],
			status: args.status,
			...(args.name ? { name: args.name } : {}),
			...(args.status === 'inProgress' ? { userFraction: Number(args.fraction) } : {}),
			...(notesText !== undefined ? { releaseNotes: parseNotes(notesText) } : {}),
		};
		for (const track of args.tracks) {
			await call(token, 'PUT', `${edit.url}/tracks/${encodeURIComponent(track)}`, {
				track,
				releases: [release],
			});
			console.log(`track ${track}: versionCode ${versionCode} ${args.status}`);
		}
		const done = await edit.commit();
		console.log(`committed edit ${done.id}`);
	});
}

/* Only when run as a command: tests/playRelease.spec.ts imports checkArgs,
 * and an import must never reach the API. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((e) => {
		console.error(`play-release: ${e.message}`);
		process.exit(1);
	});
}
