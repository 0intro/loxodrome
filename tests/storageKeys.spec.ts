/* Every localStorage key the application names is classified, once, in
 * state/storageKeys.ts (docs/preferences.md). The scan reads the source the
 * way the compiler does, so a key in a comment is no key: every string and
 * template literal starting `loxodrome:` in src/ and in the two pre-paint
 * pages must be registered, and every registered key must still occur. A new
 * key therefore cannot land without a class, which is what decides whether
 * Restore default settings resets it and which Reset group erases it. */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
	STORAGE_FAMILIES,
	STORAGE_KEYS,
	STORAGE_PREFIX,
	keysOfClass,
	storageClassOf,
} from '$lib/state/storageKeys';

const REGISTRY = join('src', 'lib', 'state', 'storageKeys.ts');

function sourceFiles(): string[] {
	return [
		...readdirSync('src', { recursive: true, withFileTypes: true })
			.filter((d) => d.isFile() && /\.(ts|js|svelte)$/.test(d.name))
			.map((d) => join(d.parentPath, d.name)),
		'index.html',
		'notam.html',
	];
}

/** The script a file carries: the whole of a module, the <script> blocks of
 *  a component or a page. */
function scripts(file: string): string[] {
	const src = readFileSync(file, 'utf8');
	return /\.(svelte|html)$/.test(file)
		? [...src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '')
		: [src];
}

/** Every literal starting with the storage prefix: plain and no-substitution
 *  strings whole, a template by its head (the stem a key is built from). */
function keyLiterals(file: string): string[] {
	const found: string[] = [];
	for (const code of scripts(file)) {
		if (!code.includes(STORAGE_PREFIX)) {
			continue;
		}
		const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const visit = (node: ts.Node): void => {
			if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
				if (node.text.startsWith(STORAGE_PREFIX)) {
					found.push(node.text);
				}
			} else if (ts.isTemplateExpression(node) && node.head.text.startsWith(STORAGE_PREFIX)) {
				found.push(node.head.text);
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);
	}
	return found;
}

const USES = new Map<string, string[]>();
for (const file of sourceFiles()) {
	for (const lit of keyLiterals(file)) {
		USES.set(lit, [...(USES.get(lit) ?? []), file]);
	}
}

const isFamilyStem = (lit: string): boolean =>
	STORAGE_FAMILIES.some((f) => lit === f.literal || lit.startsWith(`${f.literal}:`));

describe('the storage-key registry', () => {
	it('classifies every key the source names', () => {
		const unregistered = [...USES]
			.filter(([lit]) => lit !== STORAGE_PREFIX)
			.filter(([lit]) => !Object.hasOwn(STORAGE_KEYS, lit) && !isFamilyStem(lit))
			.map(([lit, files]) => `${lit} (${files.join(', ')})`);
		expect(unregistered).toEqual([]);
	});

	it('keeps the bare prefix to itself', () => {
		expect(USES.get(STORAGE_PREFIX) ?? []).toEqual([REGISTRY]);
	});

	it('lists no key the source has stopped naming', () => {
		const namedOutside = (lit: string): boolean =>
			(USES.get(lit) ?? []).some((f) => f !== REGISTRY);
		const stale = [
			...Object.keys(STORAGE_KEYS),
			...STORAGE_FAMILIES.map((f) => f.literal),
		].filter((k) => !namedOutside(k));
		expect(stale).toEqual([]);
	});

	it("keeps Reset's two data groups exactly as they are", () => {
		// The groups the registry replaced, plus two keys that belong to
		// them (2026-09-25): the recording's automatic night, which outlived
		// the trace it belongs to (a boot painted night over a trace erased
		// by Reset or the shared-mode wipe), and the selected aircraft, which
		// outlived the planes it names.
		expect(keysOfClass('briefing').sort()).toEqual([
			'loxodrome:auto-night',
			'loxodrome:nav-trace',
			'loxodrome:nav-trace-parked',
			'loxodrome:routes',
			'loxodrome:routes-rescued',
		]);
		expect(keysOfClass('aircraft').sort()).toEqual([
			'loxodrome:aircraft-fuel',
			'loxodrome:aircraft-selected',
			'loxodrome:aircraft-user',
			'loxodrome:flight-prep',
			'loxodrome:pilot',
		]);
	});

	it('classifies the built surface keys and nothing unregistered', () => {
		expect(storageClassOf('loxodrome:surface:navlog:placement')).toBe('layout');
		expect(storageClassOf('loxodrome:surface:routeProfile:size-bottom')).toBe('layout');
		expect(storageClassOf('loxodrome:surface:navlog:colour')).toBeNull();
		expect(storageClassOf('loxodrome:nobody')).toBeNull();
		expect(storageClassOf('loxodrome:layers')).toBe('pref');
	});
});
