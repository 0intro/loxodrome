/* The style specs' one reader: a stylesheet's rules, from a component's
 * <style> block or a plain .css file, through the Svelte compiler's own CSS
 * parser. Each rule carries its selectors, the at-rules around it (outermost
 * first) and its declarations in source order, whitespace squashed, so a spec
 * can pin what a declaration says and where it applies. */

import { readFileSync } from 'node:fs';
import { parse, type AST } from 'svelte/compiler';

export interface CssRule {
	selectors: string[];
	parents: string[];
	decls: Map<string, string>;
}

export function cssRulesOf(file: string): CssRule[] {
	const raw = readFileSync(file, 'utf8');
	const text = file.endsWith('.css') ? `<style>${raw}</style>` : raw;
	const css = parse(text, { modern: true }).css;
	if (!css) throw new Error(`${file} has no style block`);
	const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
	const out: CssRule[] = [];
	const walk = (nodes: (AST.CSS.Rule | AST.CSS.Atrule | AST.CSS.Declaration)[], parents: string[]): void => {
		for (const n of nodes) {
			if (n.type === 'Rule') {
				const decls = n.block.children.filter((c): c is AST.CSS.Declaration => c.type === 'Declaration');
				out.push({
					selectors: n.prelude.children.map((c) => squash(text.slice(c.start, c.end))),
					parents,
					decls: new Map(decls.map((d) => [d.property, squash(d.value)])),
				});
			} else if (n.type === 'Atrule') {
				walk(n.block?.children ?? [], [...parents, squash(`@${n.name} ${n.prelude}`)]);
			}
		}
	};
	walk(css.children, []);
	return out;
}
