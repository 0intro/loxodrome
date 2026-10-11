/* The radar's in-flight caution (docs/precipitation-radar.md "The age
 * policy"): once per device, on BOTH entry paths (the layer switched on
 * while recording, the Fly tap with the layer already on), never gating
 * the layer, a dismissal asking again next time. The wiring of the two
 * paths and the dialog's acknowledge mode are pinned from the sources:
 * goFlying through the TypeScript AST, since WHERE a call sits is a matter
 * of the tree and not of what text comes first, and the dialog's effects by
 * their whole normalised body, since a substring survives the inversion of
 * the condition around it. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nav } from '$lib/state/navRecording.svelte';
import { display } from '$lib/state/display.svelte';
import {
	acknowledgeRadarCaution,
	dismissRadarCaution,
	noteRadarInFlight,
	radar,
	setShowRadarOnMap,
} from '$lib/state/radar.svelte';

const KEY = 'loxodrome:radar-caution';
const store = new Map<string, string>();
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

/** The `$effect(() => { ... })` of a Svelte source that contains `marker`,
 *  whitespace-normalised, whole: the guard around a call is part of what is
 *  pinned. */
function effectAround(src: string, marker: string): string {
	const at = src.indexOf(marker);
	expect(at, marker).toBeGreaterThan(0);
	const open = src.lastIndexOf('$effect(() => {', at);
	const close = src.indexOf('});', at);
	expect(open).toBeGreaterThan(0);
	return src.slice(open, close + 3).replace(/\s+/g, ' ');
}

/** The chain of statements from a call named `name` inside function `fn` of
 *  a TypeScript source up to the function body, innermost first. */
function enclosingOf(src: string, fn: string, name: string): ts.Node[] {
	const file = ts.createSourceFile('x.ts', src, ts.ScriptTarget.Latest, true);
	let found: ts.Node | null = null;
	const visit = (n: ts.Node, inside: boolean): void => {
		const here = inside || (ts.isFunctionDeclaration(n) && n.name?.text === fn);
		if (
			here &&
			ts.isCallExpression(n) &&
			ts.isIdentifier(n.expression) &&
			n.expression.text === name
		) {
			found = n;
		}
		ts.forEachChild(n, (c) => visit(c, here));
	};
	visit(file, false);
	expect(found, `${name}() inside ${fn}`).not.toBeNull();
	const chain: ts.Node[] = [];
	for (let n: ts.Node | undefined = found!; n && !ts.isFunctionDeclaration(n); n = n.parent) {
		chain.push(n);
	}
	return chain;
}

beforeEach(() => {
	store.clear();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => {
			store.set(k, String(v));
		},
		removeItem: (k: string) => {
			store.delete(k);
		},
	});
	nav.recording = true;
	display.liveWeather = true;
	setShowRadarOnMap(false);
	radar.cautionDue = false;
});

afterEach(() => {
	nav.recording = false;
	vi.unstubAllGlobals();
});

describe('the caution when the layer goes on while recording', () => {
	it('is raised once per device, the layer on whichever way it is answered', () => {
		setShowRadarOnMap(true);
		expect(radar.showOnMap).toBe(true);
		expect(radar.cautionDue).toBe(true);
		acknowledgeRadarCaution();
		expect(radar.cautionDue).toBe(false);
		expect(store.get(KEY)).toBe('seen');
		setShowRadarOnMap(false);
		setShowRadarOnMap(true);
		expect(radar.cautionDue).toBe(false);
	});

	it('asks again after a dismissal', () => {
		setShowRadarOnMap(true);
		expect(radar.cautionDue).toBe(true);
		dismissRadarCaution();
		expect(radar.cautionDue).toBe(false);
		expect(store.has(KEY)).toBe(false);
		setShowRadarOnMap(false);
		setShowRadarOnMap(true);
		expect(radar.cautionDue).toBe(true);
	});

	it('is withdrawn when the layer goes off under it', () => {
		setShowRadarOnMap(true);
		expect(radar.cautionDue).toBe(true);
		setShowRadarOnMap(false);
		expect(radar.cautionDue).toBe(false);
	});

	it('stays silent when not recording, and when Live weather is off', () => {
		nav.recording = false;
		setShowRadarOnMap(true);
		expect(radar.showOnMap).toBe(true);
		expect(radar.cautionDue).toBe(false);
		setShowRadarOnMap(false);
		nav.recording = true;
		display.liveWeather = false;
		setShowRadarOnMap(true);
		expect(radar.cautionDue).toBe(false);
		display.liveWeather = true;
	});
});

describe('the caution from the Fly tap', () => {
	it('is raised for a layer left on from planning, once', () => {
		nav.recording = false;
		setShowRadarOnMap(true);
		expect(radar.cautionDue).toBe(false);
		nav.recording = true;
		noteRadarInFlight();
		expect(radar.cautionDue).toBe(true);
		acknowledgeRadarCaution();
		noteRadarInFlight();
		expect(radar.cautionDue).toBe(false);
	});

	it('is nothing with the layer off', () => {
		noteRadarInFlight();
		expect(radar.cautionDue).toBe(false);
	});
});

describe('the wiring', () => {
	it('goFlying raises it INSIDE the recording branch, and only there', () => {
		// A recording that did not start (an insecure context, no geolocation)
		// is not a flight, and the caution is about using the radar IN one.
		// The order against the battery offer is not goFlying's to decide:
		// that offer lands after an await, and the Toolbar's branch order
		// decides which dialog shows (pinned below).
		const chain = enclosingOf(read('src/lib/state/flightAction.svelte.ts'), 'goFlying', 'noteRadarInFlight');
		const branch = chain.find((n): n is ts.IfStatement => ts.isIfStatement(n));
		expect(branch, 'an if statement encloses the call').toBeDefined();
		expect(branch!.expression.getText()).toBe('nav.recording');
		// In its THEN branch, not its else.
		let n: ts.Node = chain[0];
		while (n.parent !== branch) {
			n = n.parent;
		}
		expect(n).toBe(branch.thenStatement);
	});

	it('the toolbar hosts it ahead of the flight confirm, in acknowledge mode', () => {
		const src = read('src/lib/components/Toolbar.svelte');
		const caution = src.indexOf('{#if radar.cautionDue}');
		expect(caution).toBeGreaterThan(0);
		expect(src.indexOf('{:else if flightConfirm}')).toBeGreaterThan(caution);
		expect(src.slice(caution, src.indexOf('{:else if flightConfirm}'))).toContain('mode="acknowledge"');
	});

	it('the acknowledge mode has one button, which takes the focus', () => {
		const src = read('src/lib/components/ConfirmDialog.svelte');
		expect(src).toContain("mode?: 'confirm' | 'acknowledge'");
		expect(src).toContain("{#if mode === 'confirm'}");
		expect(src).toContain("(mode === 'acknowledge' ? confirmBtn : cancelBtn)?.focus()");
	});

	it('the phone\'s Back key dismisses it through the back-close stack, on the phone only', () => {
		// With nothing registered, Back minimised the app right after the
		// Fly tap that raised the caution (the recording running on). The
		// guard is part of the pin: inverted, the phone registers nothing and
		// the desktop gains a history entry per confirm.
		expect(effectAround(read('src/lib/components/ConfirmDialog.svelte'), 'registerBackClose(')).toBe(
			'$effect(() => { if (!ui.isMobile) { return; } return registerBackClose(onCancel); });',
		);
	});

	it('a held key\'s repeats never activate the one button', () => {
		// The OK of a confirm that started the recording is what mounts the
		// caution in its place, under the same still-held Enter.
		const src = read('src/lib/components/ConfirmDialog.svelte');
		const guard = src.indexOf("e.repeat && (e.key === 'Enter' || e.key === ' ')");
		expect(guard).toBeGreaterThan(0);
		expect(src.slice(guard, guard + 200)).toContain('e.preventDefault()');
	});
});
