/* The NOTAM Viewer's map publishes its view once at creation, as the flight
 * app's does (MapView.svelte calls its onMove right after registering it).
 * L.map() fires its own moveend while it is being built, before any handler
 * listens, so the viewer held the module's default zoom until the first pan.
 * The on-field pin rule reads that zoom (pinHeldByAirport over
 * airportZoomFloor), and a viewer restored at #map=5 or #map=4 and handed a
 * briefing with no fit (an opened file, a fetch short of its corridor) hid
 * the pins of fields whose symbols the airport layer does not draw at that
 * zoom: the NOTAM stood nowhere on the map.
 *
 * Mounting the component needs a DOM this suite does not install, so the
 * wiring is read off the component's own script with the TypeScript parser:
 * inside the block that registers the settle handler, a bare call to it
 * follows the registrations. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/** The statements of every block in a Svelte component's instance script. */
function blocks(file: string): ts.NodeArray<ts.Statement>[] {
	const src = readFileSync(file, 'utf8');
	const script = /<script lang="ts">([\s\S]*?)<\/script>/.exec(src)?.[1] ?? '';
	const sf = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const out: ts.NodeArray<ts.Statement>[] = [];
	const visit = (n: ts.Node): void => {
		if (ts.isBlock(n)) {
			out.push(n.statements);
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return out;
}

/** Is `s` a call of `name`, bare or as `map.on(<event>, name)`? */
function callOf(s: ts.Statement, name: string): 'bare' | 'registered' | null {
	if (!ts.isExpressionStatement(s) || !ts.isCallExpression(s.expression)) {
		return null;
	}
	const call = s.expression;
	if (ts.isIdentifier(call.expression) && call.expression.text === name && call.arguments.length === 0) {
		return 'bare';
	}
	if (
		ts.isPropertyAccessExpression(call.expression) &&
		call.expression.name.text === 'on' &&
		call.arguments.some((a) => ts.isIdentifier(a) && a.text === name)
	) {
		return 'registered';
	}
	return null;
}

function settlesOnceAfterRegistering(file: string, name: string): boolean {
	for (const stmts of blocks(file)) {
		const kinds = stmts.map((s) => callOf(s, name));
		const lastRegistration = kinds.lastIndexOf('registered');
		if (lastRegistration >= 0) {
			return kinds.indexOf('bare', lastRegistration) > lastRegistration;
		}
	}
	return false;
}

describe("the viewer map's first view", () => {
	it('is published at creation, not at the first pan', () => {
		expect(settlesOnceAfterRegistering('src/lib/components/NotamMapView.svelte', 'onSettled')).toBe(true);
	});

	it('the way the flight app publishes its own (the scan itself)', () => {
		expect(settlesOnceAfterRegistering('src/lib/components/MapView.svelte', 'onMove')).toBe(true);
	});
});
