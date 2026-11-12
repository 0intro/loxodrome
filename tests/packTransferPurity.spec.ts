/* What the pack transfer worker loads (offline/packTransfer.worker.ts): its
 * static import closure is EXACTLY the transfer's own three run-time modules
 * (the protocol is types only, never loaded). A worker
 * reaching packStore or the client would close a circle Vite refuses to
 * build ("Circular worker imports detected"); one reaching a state module
 * drags the app's stores in. No module names a DOM or storage global, and
 * `navigator` (the OPFS root) is named in the entry alone, the core taking
 * its root as a parameter. Checked on the sources, so a new import fails here
 * before a build ships a worker that cannot start. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { staticClosure } from './helpers/staticClosure';

const ENTRY = 'src/lib/offline/packTransfer.worker.ts';
const FORBIDDEN_GLOBALS = new Set(['document', 'window', 'localStorage', 'sessionStorage', 'navigator']);

/** The bare packages a file imports at run time, and the forbidden globals
 *  it names. */
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

describe('the pack transfer worker', () => {
	const closure = [...staticClosure(ENTRY)].sort();

	it('loads the transfer own three modules and nothing else', () => {
		expect(closure).toEqual([
			'src/lib/offline/packTransfer.ts',
			'src/lib/offline/packTransfer.worker.ts',
			'src/lib/offline/packTransferCore.ts',
		]);
	});

	it('imports no package, names no DOM or storage global, and navigator only in the entry', () => {
		for (const file of closure) {
			const u = uses(file);
			expect(u.packages, file).toEqual([]);
			expect(u.globals, file).toEqual(file === ENTRY ? ['navigator'] : []);
		}
	});
});
