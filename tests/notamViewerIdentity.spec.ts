/* The NOTAM Viewer shares the flight app's origin, and so its storage, and
 * bundles the shared state modules its panels read (docs/notam-viewer.md). Two
 * of those acted on the flight app's storage the moment they loaded: the
 * navigation trace's boot restore adopted the flight app's trace (the viewer's
 * airport panel then offered Direct-To) and MOVED a finished one to the
 * outbox, a write into the flight app's own storage; and the aircraft module
 * fetched the whole fleet library for the flight app's selected plane, which
 * the viewer's fuel chips then named. The viewer marks itself before its App
 * loads (state/appIdentity.ts); unmarked, a bundle is the flight app. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

function storage(seed: Record<string, string>): Storage & { dump: () => Record<string, string> } {
	const store = new Map<string, string>(Object.entries(seed));
	return {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		key: (i: number) => [...store.keys()][i] ?? null,
		get length() {
			return store.size;
		},
		clear: () => store.clear(),
		dump: () => Object.fromEntries(store),
	};
}

const NOW = Date.now();
/** A trace the flight app was recording when its page went away. */
const LIVE = JSON.stringify({
	v: 1,
	recording: true,
	points: [
		{ lat: 48.8, lon: 2.6, timeMs: NOW - 120_000, altFt: 2000, speedKt: 95 },
		{ lat: 48.81, lon: 2.62, timeMs: NOW - 60_000, altFt: 2100, speedKt: 96 },
	],
});

const fetched: string[] = [];

beforeEach(() => {
	vi.resetModules();
	fetched.length = 0;
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string) => {
			fetched.push(String(url));
			return Promise.resolve(new Response('{}', { status: 404 }));
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the NOTAM Viewer on the shared origin', () => {
	it('adopts no trace and writes nothing of the flight app', async () => {
		const ls = storage({ 'loxodrome:nav-trace': LIVE });
		vi.stubGlobal('localStorage', ls);
		(await import('$lib/state/appIdentity')).markNotamViewer();
		const nav = await import('$lib/state/navRecording.svelte');
		expect(nav.nav.points).toEqual([]);
		expect(nav.currentPose()).toBeNull();
		expect(ls.dump()).toEqual({ 'loxodrome:nav-trace': LIVE });
	});

	it('selects no aircraft and fetches no fleet', async () => {
		vi.stubGlobal('localStorage', storage({ 'loxodrome:aircraft-selected': 'F-GORQ' }));
		(await import('$lib/state/appIdentity')).markNotamViewer();
		const ac = await import('$lib/state/aircraft.svelte');
		await new Promise((r) => setTimeout(r, 20));
		expect(ac.aircraftState.selectedKey).toBeNull();
		expect(fetched.filter((u) => u.includes('aircraft'))).toEqual([]);
	});
});

/** The modules a file loads STATICALLY, relative to the repo root: what is
 *  evaluated before its own body runs. A dynamic import() is not followed,
 *  a type-only one is not a load, and a bare package is left out (none of
 *  them reads the app's storage). */
function staticClosure(entry: string): Set<string> {
	const root = process.cwd();
	const lib = join(root, 'src/lib');
	const find = (spec: string, from: string): string | null => {
		const base = spec.startsWith('$lib/')
			? join(lib, spec.slice('$lib/'.length))
			: spec.startsWith('.')
				? resolve(dirname(from), spec)
				: null;
		if (base === null) {
			return null;
		}
		for (const ext of ['', '.ts', '.svelte.ts', '.js', '.svelte', '/index.ts']) {
			const p = base + ext;
			if (existsSync(p) && statSync(p).isFile()) {
				return p;
			}
		}
		return null;
	};
	const scripts = (file: string): string[] => {
		const src = readFileSync(file, 'utf8');
		return file.endsWith('.svelte')
			? [...src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
			: [src];
	};
	const seen = new Set<string>();
	const queue = [join(root, entry)];
	while (queue.length > 0) {
		const file = queue.shift()!;
		const rel = relative(root, file);
		if (seen.has(rel)) {
			continue;
		}
		seen.add(rel);
		if (/\.(css|json)$/.test(file)) {
			continue;
		}
		for (const code of scripts(file)) {
			const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
			for (const node of sf.statements) {
				const spec =
					ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly
						? node.moduleSpecifier
						: ts.isExportDeclaration(node) && !node.isTypeOnly
							? node.moduleSpecifier
							: undefined;
				if (spec && ts.isStringLiteral(spec)) {
					const next = find(spec.text, file);
					if (next) {
						queue.push(next);
					}
				}
			}
		}
	}
	return seen;
}

describe("the viewer's entry", () => {
	it('evaluates neither storage-acting module before it marks itself', () => {
		// Only the dynamic import of App keeps them out of the modules loaded
		// before the mark: turned back into a static import of App, both would
		// evaluate first, adopt the flight app's trace and fetch its fleet, and
		// every test above would still pass, since each marks the viewer
		// itself.
		const before = staticClosure('src/notam/main.ts');
		expect(before.has('src/lib/state/appIdentity.ts')).toBe(true);
		expect(before.has('src/lib/state/navRecording.svelte.ts')).toBe(false);
		expect(before.has('src/lib/state/aircraft.svelte.ts')).toBe(false);
	});

	it('marks itself before it loads its App', () => {
		const src = readFileSync('src/notam/main.ts', 'utf8');
		const mark = src.indexOf('\nmarkNotamViewer();');
		const app = src.indexOf("import('./App.svelte')");
		expect(mark).toBeGreaterThan(0);
		expect(app).toBeGreaterThan(mark);
	});

	it('would load both with the App imported statically', () => {
		// The scan itself: the App's own closure does hold them.
		const app = staticClosure('src/notam/App.svelte');
		expect(app.has('src/lib/state/navRecording.svelte.ts')).toBe(true);
		expect(app.has('src/lib/state/aircraft.svelte.ts')).toBe(true);
	});
});

describe('the flight app, unmarked', () => {
	it('restores its own trace and loads its selected plane', async () => {
		vi.stubGlobal(
			'localStorage',
			storage({ 'loxodrome:nav-trace': LIVE, 'loxodrome:aircraft-selected': 'F-GORQ' }),
		);
		const nav = await import('$lib/state/navRecording.svelte');
		expect(nav.nav.points).toHaveLength(2);
		const ac = await import('$lib/state/aircraft.svelte');
		await new Promise((r) => setTimeout(r, 20));
		expect(ac.aircraftState.selectedKey).toBe('F-GORQ');
		expect(fetched.some((u) => u.includes('aircraft'))).toBe(true);
	});
});
