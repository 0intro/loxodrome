/* Run vitest with its temporary files kept out of /tmp.
 *
 * Vitest 5 makes a directory under os.tmpdir() for every run, its root
 * `_tmpDir` (<nanoid>/ssr, some 260 transformed modules and 7.5 MB), and
 * never removes it. /tmp on this machine is a tmpfs with a fixed inode
 * table, and by 2026-09-24 a thousand of those directories held most of it,
 * which breaks every tool that needs a temporary file, go build among them.
 *
 * So each run gets its own directory under node_modules/.cache/vitest-tmp,
 * named by this process, with TMPDIR pointing there for vitest and every
 * worker it starts. The directory goes when the run ends, and one whose
 * process has died without cleaning up is swept by the next run. A shared
 * directory cleared at the start of each run would be simpler and wrong:
 * two runs at once (two sessions in one checkout) would delete each other's
 * files mid-run.
 *
 * Vitest computes its root when it is loaded, before any config file is
 * read, so the variable cannot be set from vite.config.ts: it has to be in
 * the environment the process starts with.
 *
 * Run: npm test (vitest run), npm run test:watch (vitest); arguments pass
 * through to vitest.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TMP_ROOT = join(ROOT, 'node_modules', '.cache', 'vitest-tmp');
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

// alive reports whether a process still runs: signal 0 checks without
// sending, and EPERM means it runs as someone else.
function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e.code === 'EPERM';
	}
}

function sweep() {
	mkdirSync(TMP_ROOT, { recursive: true });
	for (const name of readdirSync(TMP_ROOT)) {
		const pid = Number(name);
		if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) {
			rmSync(join(TMP_ROOT, name), { recursive: true, force: true });
		}
	}
}

function main() {
	sweep();
	const dir = join(TMP_ROOT, String(process.pid));
	mkdirSync(dir, { recursive: true });
	const child = spawn(process.execPath, [VITEST, ...process.argv.slice(2)], {
		stdio: 'inherit',
		env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir },
	});
	// A terminal's Ctrl+C reaches both processes; a signal sent to this one
	// alone is passed on, so vitest always gets to stop its workers.
	for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
		process.on(sig, () => child.kill(sig));
	}
	child.on('exit', (code, signal) => {
		rmSync(dir, { recursive: true, force: true });
		process.exit(signal ? 128 + (constants.signals[signal] ?? 1) : (code ?? 1));
	});
	child.on('error', (err) => {
		rmSync(dir, { recursive: true, force: true });
		console.error(`vitest: ${err.message}`);
		process.exit(1);
	});
}

main();
