/* Structural guard for the rule every workspace surface rests on
 * (docs/workspace-surfaces.md):
 *
 *   A SURFACE SHELL IS NOT MOUNTED BEHIND A CONDITION. It is rendered
 *   unconditionally by whoever owns it, and SurfaceShell gates its own DOM
 *   from the workspace slot.
 *
 * The slot is the truth and the shell is what serves it: `placementOf(id)`
 * decides whether anything paints, `registerSurfaceClose` runs inside the
 * shell's own `$effect`, and the divider grip, Escape, the placement switcher
 * and the close button all live inside it. A shell that goes while its slot
 * stays claimed therefore leaves a surface OPEN with no renderer, no closer
 * and no control: the stage keeps reserving its dock strip (`.dock-space` in
 * App.svelte reads `workspace.dockPx`, which only `vacate()` zeroes), the map
 * and the detail panel stay shrunk around it, and nothing on screen can undo
 * whatever caused it. LazySurface.svelte names that exact state for the case
 * where the chunk never arrives, and closes the surface rather than leaving it.
 *
 * It happened for real, twice. detail/AltitudeProfile wrapped its
 * VerticalProfileModal in `{#if shown.length > 0}`, so picking "on map" in the
 * chart's own header emptied the chart, unmounted the shell, and took the
 * control that had just done it. And on a PHONE, where the detail is itself a
 * surface in the pane, that same chart was mounted INSIDE the panel it evicts:
 * a tap on the inline chart opened the surface, the eviction unmounted the
 * panel's body, and the shell went with it (the last two cases below).
 *
 * WHY THE CONDITION SCAN STOPS AT TWO HOPS. A conditional PARENT is fine:
 * destroying the branch destroys the component inside it, which destroys the
 * shell, and the shell's own `onDestroy` releases the slot it was serving
 * (`releaseOrphanedSurface`, pinned below; before it, nothing on the way down
 * released anything, and a parent three hops up, an `{#if}` round a
 * LazySurface or a MapProfileModal, would have stranded the slot as surely
 * as one in the owner's file). What is not fine is a block inside the file
 * that OWNS the shell, because the owner outlives its own branch: the shell
 * goes, the surface closes, and the control that flipped the branch went
 * with it. So that property is per-file, and the set it applies
 * to is the shells plus their direct renderers. The one thing a conditional
 * parent cannot excuse is a parent that is ANOTHER SURFACE, which its own close
 * takes away: that is the cross-file case, and it has its own test.
 *
 * It reads source text on purpose, through the compiler's own parser: the
 * suite is `environment: 'node'` and mounts no components, so this is the only
 * route that catches the class of bug rather than the instance. Components are
 * resolved through each file's IMPORTS, never by tag name, so an alias
 * (`import Chart from './VerticalProfileModal.svelte'`) is the same component
 * it names. */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parse } from 'svelte/compiler';

const ROOT = process.cwd();
const SHELL = 'src/lib/components/SurfaceShell.svelte';

/** Node types that can take their children away while the file that wrote
 *  them lives on: every `{#...}` block (a snippet's body is mounted wherever
 *  `{@render}` says, which may itself be behind a condition), a boundary
 *  (its `failed` snippet replaces the content on an error), and a dynamic
 *  element or component (nothing renders while `this` is falsy, which makes
 *  `<svelte:component>` a condition on the very component it mounts). A
 *  component's CHILDREN are the same case and are recorded as `<Name>`: the
 *  wrapper decides when they render, and `{@render children()}` behind a
 *  condition is a legal wrapper. Which node types the compiler produces is
 *  asserted below, against a fixture it parses, rather than assumed. */
const CONDITIONAL = new Set([
	'IfBlock',
	'EachBlock',
	'AwaitBlock',
	'KeyBlock',
	'SnippetBlock',
	'SvelteBoundary',
	'SvelteElement',
	'SvelteComponent',
]);

/** The tag name a `<svelte:component>` use is recorded under. */
const DYNAMIC_COMPONENT = 'svelte:component';

/** AST keys that are positions or back-references, never children. Every
 *  other object-valued key is walked, so a branch the compiler adds under a
 *  new key is covered rather than silently skipped (the `fallback` of an each
 *  block was missed that way when this walked a fixed key list). */
const NOT_CHILDREN = new Set(['start', 'end', 'loc', 'metadata', 'parent']);

/** Components allowed to sit under a condition anyway, each with the reason
 *  it may. Empty today, and a new entry owes the sentence that says what
 *  releases the slot when the block flips. */
const NESTED_OK: Record<string, string> = {};

/** Tags that are not an import binding, each with its reason. Such a tag
 *  cannot be resolved, so an unknown one fails the suite rather than passing
 *  through the scan unseen. */
const DYNAMIC_OK: Record<string, string> = {
	// The one sanctioned absence: it mounts the surface its own load
	// resolved, and releases the slot when the load fails.
	'src/lib/components/LazySurface.svelte <Surface>': 'mount-and-keep of a lazily loaded surface',
};

/** A tag the resolution test must account for when no import names it: a
 *  component (capitalised), a dotted member of something, or a dynamic
 *  component. A lower-case plain name is an element and never gets here. */
function unresolvable(name: string): boolean {
	return !/^[a-z]/.test(name) || name.includes('.') || name === DYNAMIC_COMPONENT;
}

function svelteFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(join(ROOT, dir))) {
		const rel = `${dir}/${entry}`;
		if (statSync(join(ROOT, rel)).isDirectory()) {
			svelteFiles(rel, out);
		} else if (entry.endsWith('.svelte')) {
			out.push(rel);
		}
	}
	return out;
}

interface Use {
	/** `src/lib/components/Foo.svelte` */
	file: string;
	/** The tag as written. */
	name: string;
	/** The component file the tag resolves to through the file's imports,
	 *  null when the tag is not an import binding. */
	target: string | null;
	/** The conditional carriers it sits under, outermost first: block types,
	 *  and `<Name>` for another component's children. Empty at top level. */
	under: string[];
	/** The static `id` it was given, for a SurfaceShell. */
	id: string | null;
	/** The surface whose SHELL BODY it sits in, null outside any shell. */
	inShell: string | null;
}

type Ast = ReturnType<typeof parse>;

/** Default imports of `.svelte` files, local binding -> repo path. */
function svelteImports(file: string, ast: Ast): Map<string, string> {
	const out = new Map<string, string>();
	for (const script of [ast.instance, ast.module]) {
		if (!script) {
			continue;
		}
		const body = (script as unknown as { content: { body: unknown[] } }).content.body;
		for (const st of body as {
			type: string;
			source?: { value: string };
			specifiers?: { type: string; local: { name: string } }[];
		}[]) {
			const src = st.type === 'ImportDeclaration' ? st.source?.value : undefined;
			if (!src?.endsWith('.svelte')) {
				continue;
			}
			const path = src.startsWith('$lib/')
				? `src/lib/${src.slice('$lib/'.length)}`
				: relative(ROOT, resolve(dirname(join(ROOT, file)), src));
			for (const sp of st.specifiers ?? []) {
				if (sp.type === 'ImportDefaultSpecifier') {
					out.set(sp.local.name, path);
				}
			}
		}
	}
	return out;
}

/** Every component tag in a parsed file, with what it sits under. */
function componentUses(file: string, ast: Ast): Use[] {
	const imports = svelteImports(file, ast);
	const uses: Use[] = [];
	const walk = (node: unknown, under: string[], inShell: string | null): void => {
		if (!node || typeof node !== 'object') {
			return;
		}
		if (Array.isArray(node)) {
			for (const child of node) {
				walk(child, under, inShell);
			}
			return;
		}
		const n = node as Record<string, unknown> & { type?: string; name?: string };
		let inner = typeof n.type === 'string' && CONDITIONAL.has(n.type) ? [...under, n.type] : under;
		let innerShell = inShell;
		const idOf = (): string | null => {
			const idAttr = (n.attributes as { type: string; name: string; value: unknown }[] | undefined)?.find(
				(a) => a.type === 'Attribute' && a.name === 'id',
			);
			const first = Array.isArray(idAttr?.value) ? (idAttr.value[0] as { type: string; data?: string }) : null;
			return idAttr ? (first?.type === 'Text' ? (first.data ?? null) : '{dynamic}') : null;
		};
		if (n.type === 'Component' && typeof n.name === 'string') {
			// A dotted tag (`<parts.Chart />`) names no import binding and so
			// resolves to null, which the resolution test below refuses.
			const target = imports.get(n.name) ?? null;
			const id = idOf();
			uses.push({ file, name: n.name, target, under, id, inShell });
			inner = [...under, `<${n.name}>`];
			if (target === SHELL) {
				innerShell = id ?? '{dynamic}';
			}
		} else if (n.type === 'SvelteComponent') {
			// Whatever `this` can name, each import binding in it, the use sitting
			// under its own condition (`inner`); null when nothing resolves.
			const targets = [...new Set(identifiers(n.expression).flatMap((name) => imports.get(name) ?? []))];
			const id = idOf();
			for (const target of targets.length > 0 ? targets : [null]) {
				uses.push({ file, name: DYNAMIC_COMPONENT, target, under: inner, id, inShell });
				if (target === SHELL) {
					innerShell = id ?? '{dynamic}';
				}
			}
		}
		for (const [key, value] of Object.entries(n)) {
			if (!NOT_CHILDREN.has(key) && value && typeof value === 'object') {
				walk(value, inner, innerShell);
			}
		}
	};
	walk(ast.fragment, [], null);
	return uses;
}

/** Every identifier an expression reads, member-expression properties
 *  aside (`this={cond ? A : B}` names both A and B). */
function identifiers(expr: unknown, out: string[] = []): string[] {
	if (!expr || typeof expr !== 'object') {
		return out;
	}
	if (Array.isArray(expr)) {
		for (const e of expr) {
			identifiers(e, out);
		}
		return out;
	}
	const e = expr as Record<string, unknown> & { type?: string; name?: string; computed?: boolean };
	if (e.type === 'Identifier' && typeof e.name === 'string') {
		out.push(e.name);
		return out;
	}
	for (const [key, value] of Object.entries(e)) {
		if (NOT_CHILDREN.has(key) || (e.type === 'MemberExpression' && key === 'property' && !e.computed)) {
			continue;
		}
		identifiers(value, out);
	}
	return out;
}

function parseFile(file: string, source: string): Ast {
	return parse(source, { filename: file, modern: true });
}

function allUses(): Use[] {
	const out: Use[] = [];
	for (const file of svelteFiles('src')) {
		// A file this parser cannot read is a failure of its own: the compiler
		// reads the same text, so a silent skip would be a hole in the scan.
		out.push(...componentUses(file, parseFile(file, readFileSync(join(ROOT, file), 'utf8'))));
	}
	return out;
}

/** The files that render a SurfaceShell themselves, i.e. the second hop:
 *  mounting one of these IS mounting a shell. */
function shellBearingFiles(uses: Use[]): Set<string> {
	return new Set(uses.filter((u) => u.target === SHELL).map((u) => u.file));
}

describe('workspace surface mounts', () => {
	const uses = allUses();

	it('sees under every carrier the compiler produces, so a shell cannot hide in one', () => {
		// The scan's own coverage, asserted against the compiler's AST for a
		// fixture that holds each form once. Every <A /> but the two bare ones
		// sits under something that can take it away; a carrier this walk
		// misses would leave one reading as top level, and a spec that sees
		// nothing passes.
		const fixture = `<script>
	import A from './A.svelte';
	let { x, y, list, promise, tag } = $props();
</script>
{#if x}<A />{:else if y}<A />{:else}<A />{/if}
{#each list as item (item)}<A />{:else}<A />{/each}
{#await promise}<A />{:then v}<A />{:catch e}<A />{/await}
{#key x}<A />{/key}
{#snippet s()}<A />{/snippet}
<svelte:boundary><A />{#snippet failed()}<A />{/snippet}</svelte:boundary>
<svelte:element this={tag}><A /></svelte:element>
<svelte:component this={x ? A : null}><A /></svelte:component>
<A><A /></A>
<div><A /></div>
<ns.A />`;
		const all = componentUses('src/fixture/F.svelte', parseFile('F.svelte', fixture));
		const found = all.filter((u) => u.name === 'A');
		// if 3, each 2, await 3, key 1, snippet 1, boundary 2, element 1,
		// the dynamic component's child 1, the wrapper and its child 2, the
		// plain element's 1.
		expect(found).toHaveLength(17);
		const bare = found.filter((u) => u.under.length === 0);
		// The wrapper itself and the one inside a plain element.
		expect(bare).toHaveLength(2);
		// Resolved through the import, which is what defeats an alias.
		expect(new Set(found.map((u) => u.target))).toEqual(new Set(['src/fixture/A.svelte']));
		// A dynamic component is a use of what its `this` can name, under its
		// own condition; a dotted tag is a use nothing resolves.
		expect(all.filter((u) => u.name === 'svelte:component').map((u) => [u.target, u.under])).toEqual([
			['src/fixture/A.svelte', ['SvelteComponent']],
		]);
		expect(all.filter((u) => u.name === 'ns.A').map((u) => u.target)).toEqual([null]);
		// And every carrier seen is one this spec treats as conditional.
		for (const u of found) {
			for (const carrier of u.under) {
				expect(CONDITIONAL.has(carrier) || /^<.+>$/.test(carrier)).toBe(true);
			}
		}
	});

	it('finds the shells at all (the scan itself is load-bearing)', () => {
		// A scan that matched nothing would pass every assertion below.
		const shells = uses.filter((u) => u.target === SHELL);
		expect(shells.length).toBeGreaterThan(8);
		expect(shells.map((u) => u.file)).toContain('src/lib/components/VerticalProfileModal.svelte');
		// Both apps, or the rule would only cover the flight app's own shells.
		expect(shells.map((u) => u.file)).toContain('src/notam/AboutSurface.svelte');
	});

	it('resolves every tag through an import, or knows why it cannot', () => {
		const dynamic = uses
			.filter((u) => u.target === null && unresolvable(u.name))
			.map((u) => `${u.file} <${u.name}>`)
			.filter((k) => !(k in DYNAMIC_OK));
		expect(dynamic).toEqual([]);
	});

	it('sees a shell-bearing component behind a condition however it is mounted', () => {
		// Two spellings the scan once passed over: a `<svelte:component>` was
		// never recorded at all, and a dotted tag resolved to nothing and was
		// skipped by the resolution test for starting lower-case.
		const host = (body: string) =>
			componentUses(
				'src/lib/components/Host.svelte',
				parseFile(
					'Host.svelte',
					`<script>import Chart from '$lib/components/VerticalProfileModal.svelte'; import * as parts from './parts.js'; let { x } = $props();</script>\n${body}`,
				),
			);
		const dyn = host('{#if x}<svelte:component this={Chart} />{/if}');
		expect(dyn.map((u) => [u.target, u.under])).toEqual([
			['src/lib/components/VerticalProfileModal.svelte', ['IfBlock', 'SvelteComponent']],
		]);
		// Unconditional by the file, still a condition by its own `this`.
		expect(host('<svelte:component this={Chart} />').map((u) => u.under)).toEqual([['SvelteComponent']]);
		const dotted = host('{#if x}<parts.Chart />{/if}');
		expect(dotted.filter((u) => u.target === null && unresolvable(u.name)).map((u) => u.name)).toEqual([
			'parts.Chart',
		]);
	});

	it('releases the slot from the shell itself when it goes', () => {
		// What makes a conditional parent harmless: the shell's teardown,
		// deferred past the flush, closes a surface still open with no
		// closer registered.
		const shell = readFileSync(join(ROOT, SHELL), 'utf8');
		expect(shell).toMatch(/onDestroy\(\(\) => \{\s*queueMicrotask\(\(\) => releaseOrphanedSurface\(id\)\);\s*\}\);/);
	});

	it('mounts every SurfaceShell unconditionally in its own file', () => {
		const offenders = uses
			.filter((u) => u.target === SHELL && u.under.length > 0)
			.map((u) => `${u.file} under ${u.under.join(' ')}`);
		expect(offenders).toEqual([]);
	});

	it('mounts every shell-bearing component unconditionally in its own file', () => {
		const bearing = shellBearingFiles(uses);
		// The second hop is the one the real bug was at: the shell was fine
		// inside VerticalProfileModal and the CALLER put a condition on it.
		expect(bearing.has('src/lib/components/VerticalProfileModal.svelte')).toBe(true);
		const offenders = uses
			.filter((u) => u.target !== null && bearing.has(u.target) && u.under.length > 0)
			.filter((u) => !(u.name in NESTED_OK))
			.map((u) => `${u.file} <${u.name}> under ${u.under.join(' ')}`);
		expect(offenders).toEqual([]);
	});

	it('never owns a surface from inside another surface', () => {
		// The cross-file case, which no per-file condition can see. A shell
		// mounted anywhere in another surface's BODY lives exactly as long as
		// that surface is open, and on a phone the pane holds one surface, so
		// opening the inner one is what closes the outer: the detail panel's
		// own chart opened, evicted the panel, and went with it. Followed
		// through every file the body mounts, since the chart sat four
		// components down (DetailBody > AirportDetail > AltitudeProfile >
		// VerticalProfileModal).
		const byFile = new Map<string, Use[]>();
		for (const u of uses) {
			byFile.set(u.file, [...(byFile.get(u.file) ?? []), u]);
		}
		const memo = new Map<string, string[][]>();
		const shellsBelow = (file: string, path: Set<string>): string[][] => {
			const hit = memo.get(file);
			if (hit) {
				return hit;
			}
			if (path.has(file)) {
				return [];
			}
			const out: string[][] = [];
			for (const u of byFile.get(file) ?? []) {
				if (u.target === SHELL) {
					out.push([file, `surface "${u.id ?? '{dynamic}'}"`]);
				} else if (u.target) {
					for (const chain of shellsBelow(u.target, new Set([...path, file]))) {
						out.push([file, ...chain]);
					}
				}
			}
			memo.set(file, out);
			return out;
		};
		const offenders: string[] = [];
		for (const u of uses) {
			if (u.inShell === null || u.target === null || u.target === SHELL) {
				continue;
			}
			for (const chain of shellsBelow(u.target, new Set())) {
				offenders.push(`${u.file}, in the body of surface "${u.inShell}": ${chain.join(' > ')}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('keeps the release LazySurface promises for the mount it cannot make', () => {
		// The one sanctioned way a shell is absent while its slot is claimed:
		// the chunk did not arrive. It releases instead of leaving the stage
		// reserved, which is the same repair this spec exists to enforce
		// structurally everywhere else.
		const lazy = readFileSync(join(ROOT, 'src/lib/components/LazySurface.svelte'), 'utf8');
		expect(lazy).toContain('closeSurface(id)');
	});

	it('mounts the panel profile once per app, and the panel releases what it opened', () => {
		// The chart left the panel (state/airspaceProfileModal.svelte.ts), so
		// both apps must mount its host, or the inline chart opens a surface
		// nothing renders.
		const app = readFileSync(join(ROOT, 'src/App.svelte'), 'utf8');
		expect(app).toMatch(/<LazySurface\s+id="airspaceProfile"[\s\S]*?PanelProfileModal\.svelte/);
		const viewer = uses.filter((u) => u.file === 'src/notam/App.svelte');
		expect(viewer.find((u) => u.target === 'src/lib/components/PanelProfileModal.svelte')?.under).toEqual([]);
		// And the panel hands its ownership back when it goes, which on a
		// desktop is what closes a chart that outlived its panel.
		const panel = readFileSync(join(ROOT, 'src/lib/components/detail/AltitudeProfile.svelte'), 'utf8');
		expect(panel).toMatch(/onDestroy\(\(\) => releaseAirspaceProfile\(token\)\)/);
	});
});
