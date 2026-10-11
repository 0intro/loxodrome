/* Seeds wrangler dev's local R2 from an `nwp ingest -out <dir>` store: every
 * archive and receipt as written, and each model's latest/ pointer built
 * from the receipts the way the orchestrator publishes (src/plan.ts).
 *
 *   node loxodrome-nwp/dev/seed.ts <store dir> [--persist-to <state dir>]
 *
 * (from the repository root). Then `npx wrangler@4 dev` in loxodrome-nwp
 * serves those runs, given the same `--persist-to` when one was: a local
 * state of its own keeps a test store apart from whatever another task
 * seeded into the default one. */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { nextPointer, type Receipt, type RunState } from '../src/plan.ts';
import type { Pointer } from '../src/pointer.ts';
import type { ModelId } from '../src/models.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--persist-to');
const persistTo = at >= 0 ? args.splice(at, 2)[1] : '';
const dir = args[0];
if (!dir || (at >= 0 && !persistTo)) {
	console.error('usage: node loxodrome-nwp/dev/seed.ts <store dir> [--persist-to <state dir>]');
	process.exit(2);
}

function walk(d: string, out: string[] = []): string[] {
	for (const name of readdirSync(d)) {
		const p = join(d, name);
		if (statSync(p).isDirectory()) {
			walk(p, out);
		} else {
			out.push(p);
		}
	}
	return out;
}

const files = walk(dir);
const byRun = new Map<string, Receipt[]>();
for (const f of files.filter((p) => relative(dir, p).startsWith('receipts/'))) {
	const rec = JSON.parse(readFileSync(f, 'utf8')) as Receipt;
	const k = `${rec.model}|${rec.run}`;
	byRun.set(k, [...(byRun.get(k) ?? []), rec]);
}
const pointers = new Map<string, Pointer | null>();
for (const k of [...byRun.keys()].sort((a, b) => Date.parse(a.split('|')[1]) - Date.parse(b.split('|')[1]))) {
	const [model, run] = k.split('|');
	const recs = byRun.get(k) ?? [];
	const st: RunState = { run, status: 'collecting', blocks: {}, seenAt: 0 };
	for (const r of recs) {
		st.blocks[`b${String(r.first).padStart(3, '0')}-${String(r.last).padStart(3, '0')}`] = { status: 'built', attempts: 0, receipt: r };
	}
	pointers.set(model, nextPointer(pointers.get(model) ?? null, model as ModelId, st, Object.keys(st.blocks), false, Date.now()));
}
const put = (key: string, file: string): void => {
	// Absolute: wrangler runs in loxodrome-nwp/, the store is named from the
	// caller's directory.
	const state = persistTo ? [`--persist-to=${resolve(persistTo)}`] : [];
	execFileSync('npx', ['--yes', 'wrangler@4', 'r2', 'object', 'put', `loxodrome-nwp/${key}`, `--file=${resolve(file)}`, '--local', ...state], {
		cwd: new URL('..', import.meta.url).pathname,
		stdio: ['ignore', 'ignore', 'inherit'],
	});
	console.log(`put ${key}`);
};
for (const [model, p] of pointers) {
	const path = join(dir, 'latest', `${model}.json`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(p));
}
for (const f of walk(dir)) {
	const key = relative(dir, f);
	if (/^(first|blocks|receipts|latest)\//.test(key) && !key.endsWith('.tmp')) {
		put(key, f);
	}
}
