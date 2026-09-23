/* Structural guard for the one rule map click resolution rests on
 * (docs/map-hit-testing.md):
 *
 *   A FILLED area never takes the click itself. It is resolved by featureAt,
 *   which ranks every area under the point by size. Only a LINE or a PIN --
 *   something the pilot aims at -- keeps a Leaflet click handler of its own.
 *
 * A filled path that keeps its own handler shadows everything beneath it
 * whatever its size, because Leaflet fires the path and the map's handler
 * never runs: that is how a NOTAM area came to swallow the SUP AIP zone it
 * activates, the airports under it, and the waypoint a click in route edit
 * mode meant to add. The rule is a property of the layer rather than a list of
 * kinds, so a layer written later inherits it -- but only if nothing quietly
 * opts out, which is what this spec is for.
 *
 * It reads source text on purpose. Asserting behaviour through a Leaflet stub
 * would pin the layers that exist today and say nothing about the one somebody
 * adds next year. */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAP_DIR = join(process.cwd(), 'src/lib/map');

/** Leaflet path constructors whose default fill is hit-testable. L.polyline is
 *  absent by design: a line is an aimed target and shadows nothing. */
const FILLED_CTORS = ['L.polygon(', 'L.circle(', 'L.rectangle(', 'L.circleMarker('];

/** The map modules allowed to consume a click, and why each may: every reason
 *  is "a line or a pin". A new entry here owes the same sentence. */
const CLICK_TARGETS: Record<string, string> = {
	'notamLayer.ts': 'the NOTAM position pins, markers the pilot aims at',
	'routeLayer.ts': 'the route line (a 4 px stroke) and its draggable waypoint pins',
	'profilePointLayer.ts': 'the map-profile crosshair, a draggable marker',
	'navLayer.ts': 'the recentre control, a Leaflet control button and not a feature',
};

/** Option sets that arrive as a PARAMETER, with the promise each rests on.
 *  Both promises are asserted below, so a pass-through cannot become a hole. */
const PASS_THROUGH: Record<string, string> = {
	opts: 'createCloneLayer builds the option set and pins interactive: false',
	style: "makeSupGeometryLayer draws its caller's style; every caller pins it",
};

function mapSources(): { file: string; src: string }[] {
	return readdirSync(MAP_DIR)
		.filter((f) => f.endsWith('.ts'))
		.map((file) => ({ file, src: readFileSync(join(MAP_DIR, file), 'utf8') }));
}

/** The text between `open` and its matching close, brackets balanced. */
function balanced(src: string, openIdx: number, open: string, close: string): string {
	let depth = 0;
	for (let i = openIdx; i < src.length; i++) {
		if (src[i] === open) {
			depth++;
		} else if (src[i] === close) {
			depth--;
			if (depth === 0) {
				return src.slice(openIdx, i + 1);
			}
		}
	}
	return src.slice(openIdx);
}

/** The body of a local `function name` / `const name =` declaration, and only
 *  that: a `const` stops at the semicolon ending its own statement, or the
 *  lookup would run on into the next unrelated block and find a flag that
 *  belongs to somebody else. */
function declBody(src: string, name: string): string | null {
	const m = new RegExp(`(function|const)\\s+${name}\\b`).exec(src);
	if (!m) {
		return null;
	}
	if (m[1] === 'function') {
		const paren = src.indexOf('(', m.index);
		const params = balanced(src, paren, '(', ')');
		const brace = src.indexOf('{', paren + params.length);
		return brace < 0 ? null : balanced(src, brace, '{', '}');
	}
	let depth = 0;
	for (let i = m.index; i < src.length; i++) {
		const ch = src[i];
		if (ch === '{' || ch === '(' || ch === '[') {
			depth++;
		} else if (ch === '}' || ch === ')' || ch === ']') {
			depth--;
			if (depth < 0) {
				return src.slice(m.index, i);
			}
		} else if (ch === ';' && depth === 0) {
			return src.slice(m.index, i);
		}
	}
	return src.slice(m.index);
}

/** Does this call's option expression resolve to a non-interactive path? One
 *  hop of local resolution: the literal, a style helper declared in the same
 *  file, or a named pass-through whose own promise is checked separately. */
function guarded(src: string, callBody: string): boolean {
	if (callBody.includes('interactive: false')) {
		return true;
	}
	for (const name of callBody.match(/[A-Za-z_$][\w$]*/g) ?? []) {
		if (name in PASS_THROUGH) {
			return true;
		}
		if (declBody(src, name)?.includes('interactive: false')) {
			return true;
		}
	}
	return false;
}

/** Every filled-path construction in the map layer, as `file:line`. */
function filledPathCalls(): { where: string; src: string; body: string }[] {
	const out: { where: string; src: string; body: string }[] = [];
	for (const { file, src } of mapSources()) {
		for (const ctor of FILLED_CTORS) {
			let from = 0;
			for (;;) {
				const at = src.indexOf(ctor, from);
				if (at < 0) {
					break;
				}
				from = at + ctor.length;
				out.push({
					where: `${file}:${src.slice(0, at).split('\n').length}`,
					src,
					body: balanced(src, at + ctor.length - 1, '(', ')'),
				});
			}
		}
	}
	return out;
}

describe('map click targets', () => {
	it('finds the filled paths at all (the scan itself is load-bearing)', () => {
		const calls = filledPathCalls();
		expect(calls.length).toBeGreaterThan(8);
		expect(calls.map((c) => c.where.split(':')[0])).toContain('notamLayer.ts');
	});

	it('builds every filled path non-interactive', () => {
		const offenders = filledPathCalls()
			.filter((c) => !guarded(c.src, c.body))
			.map((c) => c.where);
		// An interactive fill takes the click Leaflet would otherwise hand to
		// the map, and featureAt never runs under it.
		expect(offenders).toEqual([]);
	});

	it('lets only lines and pins consume a click', () => {
		const wired = mapSources()
			.filter(({ src }) => /\.on\(\s*'click'|DomEvent\.on\([^)]*'click'/.test(src))
			.map(({ file }) => file)
			.sort();
		expect(wired).toEqual(Object.keys(CLICK_TARGETS).sort());
	});

	it('keeps the promise behind each pass-through option set', () => {
		// `opts`: the clone factory behind every emphasis overlay, and the
		// canvas base class the direct-draw symbol layers extend.
		const clones = readFileSync(join(MAP_DIR, 'emphasisClones.ts'), 'utf8');
		expect(clones).toContain('interactive: false');
		const canvas = readFileSync(join(MAP_DIR, 'directDrawLayer.ts'), 'utf8');
		expect(canvas).toMatch(/pointerEvents\s*=\s*'none'/);
		// `style`: the shared SUP AIP geometry builder draws whatever its
		// caller hands it, so the callers are where the rule has to hold.
		const callers = mapSources().filter(({ src }) =>
			/makeSupGeometryLayer\(/.test(src.replace(/export function makeSupGeometryLayer\(/, '')),
		);
		expect(callers.length).toBeGreaterThan(0);
		for (const { file, src } of callers) {
			let from = 0;
			for (;;) {
				const at = src.indexOf('makeSupGeometryLayer(', from);
				if (at < 0) {
					break;
				}
				from = at + 1;
				const body = balanced(src, at + 'makeSupGeometryLayer'.length, '(', ')');
				if (body.startsWith('(g: SupAipGeometry')) {
					continue; // the declaration itself
				}
				expect({ file, body, ok: guarded(src, body) }).toMatchObject({ ok: true });
			}
		}
	});
});
