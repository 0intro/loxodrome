/* What the decoration worker loads (map/decoPaint.worker.ts): its static
 * import closure, walked from the entry, must run where there is no map, no
 * DOM, no app state and no catalogs. A worker that imports Leaflet dies at
 * load on `window`; one that imports a state module drags the app's stores
 * and storage in with it. Checked on the sources, so a new import fails here
 * before a build ships a worker that cannot start. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { staticClosure } from './helpers/staticClosure';

const ENTRY = 'src/lib/map/decoPaint.worker.ts';
const FORBIDDEN_DIRS = ['src/lib/state/', 'src/lib/i18n/', 'src/lib/components/', 'src/lib/ui/'];
const FORBIDDEN_PACKAGES = /^(leaflet|svelte)(\/|$)/;
const FORBIDDEN_GLOBALS = new Set(['document', 'window', 'localStorage', 'sessionStorage', 'navigator']);

/** The bare packages a file imports at run time, and the globals it names. */
function uses(file: string): { packages: string[]; globals: string[] } {
	const src = readFileSync(join(process.cwd(), file), 'utf8');
	const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const packages: string[] = [];
	const globals = new Set<string>();
	for (const node of sf.statements) {
		if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
			const spec = node.moduleSpecifier.text;
			if (!spec.startsWith('.') && !spec.startsWith('$lib/')) {
				packages.push(spec);
			}
		}
	}
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text)) {
			const parent = node.parent;
			const isMember = ts.isPropertyAccessExpression(parent) && parent.name === node;
			const isKey = (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) && parent.name === node;
			if (!isMember && !isKey) {
				globals.add(node.text);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return { packages, globals: [...globals] };
}

describe('the decoration worker', () => {
	const closure = [...staticClosure(ENTRY)];

	it('loads the painter and its core, and nothing of the app around them', () => {
		expect(closure).toContain('src/lib/map/decoPaint.ts');
		expect(closure).toContain('src/lib/map/decoWorkerCore.ts');
		for (const file of closure) {
			for (const dir of FORBIDDEN_DIRS) {
				expect(file.startsWith(dir), `${file} is under ${dir}`).toBe(false);
			}
		}
	});

	it('imports no Leaflet and no Svelte, and names no DOM global', () => {
		for (const file of closure) {
			const u = uses(file);
			expect(u.packages.filter((p) => FORBIDDEN_PACKAGES.test(p)), file).toEqual([]);
			expect(u.globals, file).toEqual([]);
		}
	});
});
