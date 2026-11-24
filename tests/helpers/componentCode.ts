/* A component's own code, for the specs that run it with no DOM to mount it
 * in (the suite installs none): declarations of its script, the callback a
 * top-level call hands over (an $effect, an onDestroy) and the expression an
 * element's attribute holds (a handler), each as JavaScript that `run`
 * evaluates over stand-ins for what the code reads. Read through the Svelte
 * compiler's own parser and transpiled by TypeScript, so a case runs the
 * code as written and survives a reformat, where a pin of its text would
 * not. */

import { readFileSync } from 'node:fs';
import { parse } from 'svelte/compiler';
import ts from 'typescript';

interface Node {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

export interface ComponentCode {
	/** The script's top-level declarations of these names, in source order.
	 *  A name the script does not declare is left out. */
	declarations(...names: string[]): string;
	/** The callback the top-level call of `callee` hands over, the one whose
	 *  source contains `marker`. */
	callback(callee: string, marker: string): string;
	/** The expression the attribute `attr` holds on the first element whose
	 *  static class list includes `className`. */
	attribute(className: string, attr: string): string;
}

/** TypeScript to JavaScript, one piece at a time: without the strict-mode
 *  prologue TypeScript gives each output, which inside an object literal
 *  or after a declaration would not parse. */
function toJs(code: string): string {
	const out = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
	return out.outputText
		.replace(/^"use strict";\s*/, '')
		.trim()
		.replace(/;$/, '');
}

function declaredName(n: Node): string | null {
	if (n.type === 'FunctionDeclaration') {
		return ((n.id as { name: string } | null) ?? null)?.name ?? null;
	}
	if (n.type === 'VariableDeclaration') {
		const [d] = n.declarations as { id: { name?: string } }[];
		return d?.id.name ?? null;
	}
	return null;
}

/** Every element of a template, wherever it sits in blocks and snippets. */
function elements(root: unknown): Node[] {
	const out: Node[] = [];
	const seen = new Set<object>();
	const visit = (v: unknown): void => {
		if (v === null || typeof v !== 'object' || seen.has(v)) {
			return;
		}
		seen.add(v);
		const n = v as Node;
		if (n.type === 'RegularElement') {
			out.push(n);
		}
		for (const child of Object.values(n)) {
			visit(child);
		}
	};
	visit(root);
	return out;
}

function staticClasses(el: Node): string[] {
	const attrs = el.attributes as { type: string; name?: string; value?: unknown }[];
	const a = attrs.find((x) => x.type === 'Attribute' && x.name === 'class');
	if (!a || !Array.isArray(a.value)) {
		return [];
	}
	return (a.value as { type: string; data?: string }[])
		.filter((p) => p.type === 'Text')
		.flatMap((p) => (p.data ?? '').split(/\s+/));
}

export function componentCode(file: string): ComponentCode {
	const src = readFileSync(file, 'utf8');
	const ast = parse(src, { modern: true });
	const body = (ast.instance?.content as unknown as { body: Node[] } | undefined)?.body ?? [];
	const text = (n: Node): string => src.slice(n.start, n.end);
	return {
		declarations(...names) {
			const want = new Set(names);
			return body
				.filter((n) => want.has(declaredName(n) ?? ''))
				.map((n) => toJs(text(n)))
				.join(';\n');
		},
		callback(callee, marker) {
			for (const n of body) {
				const call = n.type === 'ExpressionStatement' ? (n.expression as Node) : null;
				const fn = call?.type === 'CallExpression' ? (call.callee as Node) : null;
				if (fn?.type === 'Identifier' && fn.name === callee && text(n).includes(marker)) {
					return toJs(`(${text((call!.arguments as Node[])[0])})`);
				}
			}
			throw new Error(`${file}: no ${callee}(...) holding ${marker}`);
		},
		attribute(className, attr) {
			for (const el of elements(ast.fragment)) {
				if (!staticClasses(el).includes(className)) {
					continue;
				}
				const attrs = el.attributes as { type: string; name?: string; value?: unknown }[];
				const a = attrs.find((x) => x.type === 'Attribute' && x.name === attr);
				const tag = a?.value as Node | undefined;
				if (tag?.type === 'ExpressionTag') {
					return toJs(`(${text(tag.expression as Node)})`);
				}
			}
			throw new Error(`${file}: no .${className} element with ${attr}={...}`);
		},
	};
}

/** Run `body`, JavaScript ending in a return, with each entry of `scope`
 *  bound to the name the code reads it by. */
export function run<T>(scope: Record<string, unknown>, body: string): T {
	// eslint-disable-next-line @typescript-eslint/no-implied-eval -- a component's own code, run over stand-ins for what it reads
	const fn = new Function(...Object.keys(scope), body) as (...args: unknown[]) => T;
	return fn(...Object.values(scope));
}
