/* The map's context menu closes when the pilot moves the view, and stays up
 * while the app moves it. The menu holds the point it was opened on and the
 * rows found there, but it closed on Leaflet's movestart, which follow mode's
 * re-centre fires too (navLayer.ts, m.panTo): in flight a menu opened by a
 * long press for Direct-To closed at the next 12 px of drift, and the tap
 * meant for its row landed on the map. Mounting MapView needs a DOM this suite
 * does not install, so the events it binds the close to are read off its
 * script with the TypeScript parser, then bound on a real Leaflet map
 * (tests/helpers/leafletNode.ts). */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { ContextFeatures } from '$lib/map/interactions';
import { installLeafletNode } from './helpers/leafletNode';

const env = installLeafletNode();
const L = (await import('leaflet')).default;
const { KEYPAN_START } = await import('$lib/map/keyPan');
const { closeContextMenu, contextMenu, openContextMenu } = await import('$lib/state/contextMenu.svelte');

const VIEW = 'src/lib/components/MapView.svelte';

/** The event lists MapView's script hands `map.on` (or `map.off`) with
 *  closeContextMenu, a template literal read with the names it imports. */
function closeEvents(method: 'on' | 'off'): string[] {
	const src = readFileSync(VIEW, 'utf8');
	const script = /<script lang="ts">([\s\S]*?)<\/script>/.exec(src)?.[1] ?? '';
	const sf = ts.createSourceFile(VIEW, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const names: Record<string, string> = { KEYPAN_START };
	const read = (e: ts.Expression): string => {
		if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
			return e.text;
		}
		if (ts.isTemplateExpression(e)) {
			return (
				e.head.text +
				e.templateSpans.map((s) => (ts.isIdentifier(s.expression) ? (names[s.expression.text] ?? '?') : '?') + s.literal.text).join('')
			);
		}
		return '?';
	};
	const out: string[] = [];
	const visit = (n: ts.Node): void => {
		if (
			ts.isCallExpression(n) &&
			ts.isPropertyAccessExpression(n.expression) &&
			n.expression.name.text === method &&
			n.arguments.length === 2 &&
			ts.isIdentifier(n.arguments[1]) &&
			n.arguments[1].text === 'closeContextMenu'
		) {
			out.push(read(n.arguments[0]));
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return out;
}

const NOTHING: ContextFeatures = {
	notams: [],
	stations: [],
	radar: null,
	airports: [],
	navaids: [],
	airspaces: [],
	obstacles: [],
	supaips: [],
	zsm: [],
	sigmets: [],
	charts: [],
	waypoints: [],
	leg: null,
};

describe("the map's context menu", () => {
	it('closes on the gestures that move the view, bound and unbound alike', () => {
		const on = closeEvents('on');
		expect(on).toHaveLength(1);
		expect(on[0].split(' ').sort()).toEqual(['dragstart', KEYPAN_START, 'zoomstart'].sort());
		expect(closeEvents('off')).toEqual(on);
	});

	it('stays open while follow mode re-centres the map, and closes on a drag', () => {
		const map = L.map(env.container(800, 600) as unknown as HTMLElement, {
			zoomControl: false,
			attributionControl: false,
			trackResize: false,
		}).setView([48.8, 2.3], 12);
		map.on(closeEvents('on')[0], closeContextMenu);
		let starts = 0;
		map.on('movestart', () => starts++);
		openContextMenu(NOTHING, 48.8, 2.3, 400, 300);
		// navLayer's re-centre once the aircraft has drifted past its dead
		// band: a plain panTo, which fires movestart before it animates.
		map.panTo(map.containerPointToLatLng([420, 300]));
		expect(starts).toBe(1);
		expect(contextMenu.open).toBe(true);
		map.fire('dragstart');
		expect(contextMenu.open).toBe(false);
		map.remove();
	});
});
