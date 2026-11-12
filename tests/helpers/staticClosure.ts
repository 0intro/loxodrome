/* The static import closure of a source file (the identity spec's walker,
 * shared): the modules evaluated before its own body runs. */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

/** The modules a file loads STATICALLY, relative to the repo root: what is
 *  evaluated before its own body runs. A dynamic import() is not followed,
 *  a type-only one is not a load, and a bare package is left out (none of
 *  them reads the app's storage). */
export function staticClosure(entry: string): Set<string> {
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
