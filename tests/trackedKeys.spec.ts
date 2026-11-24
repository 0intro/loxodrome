/* A signing key or a service account key must stay out of the tree. The
 * upload keystore and the Play key sit under the ignored local/, and the
 * keystore's passwords in android/keystore.properties, which
 * android/.gitignore names. A key committed on dev would go public with the
 * next publish, before CI on main could see it, so verify reads the tree
 * here, untracked files a `git add` would take included. The CA certificates
 * under cmd/eaip/certs are public, so a .pem name stays allowed: a key is
 * recognised by its text. */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** Keystores, the signing properties, and the Play service account's key. */
const KEY_NAME = /(\.(jks|keystore|p12|pfx|p8)|(^|\/)keystore\.properties|(^|\/)play-publisher[^/]*\.json)$/i;

/** A PEM private key, or a Google service account's key file. Assembled
 *  from parts, so that this file's own text matches neither. */
const KEY_TEXT = new RegExp(
	[['-----BEGIN ', '([A-Z]+ )*', 'PRIVATE KEY-----'].join(''), ['"type": *"', 'service_', 'account"'].join('')].join('|'),
);

/** Every file a commit would take: tracked, or untracked and not ignored. */
function listed(): string[] {
	return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
		cwd: ROOT,
		encoding: 'utf8',
		maxBuffer: 64 << 20,
	})
		.split('\0')
		.filter((f) => f !== '');
}

describe('the tree', () => {
	it('carries no file named as a key', () => {
		expect(listed().filter((f) => KEY_NAME.test(f))).toEqual([]);
	});

	it('carries no key in its text', () => {
		// The datasets are upstream text, and the largest files are datasets
		// or binaries.
		const files = listed().filter((f) => {
			if (f.startsWith('public/data/')) {
				return false;
			}
			const p = join(ROOT, f);
			return existsSync(p) && statSync(p).size < 2_000_000;
		});
		expect(files.length).toBeGreaterThan(1000);
		const keyed = files.filter((f) => {
			const bytes = readFileSync(join(ROOT, f));
			return !bytes.subarray(0, 8000).includes(0) && KEY_TEXT.test(bytes.toString('utf8'));
		});
		expect(keyed).toEqual([]);
		// A git walk and some 3 000 files read: past the default 5 s inside a
		// full run on a loaded machine.
	}, 60_000);
});
