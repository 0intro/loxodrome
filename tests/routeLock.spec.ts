/* The route locked on the map in flight (state/routeLock.svelte.ts): a rule
 * of the recording and a preference, and the one-drag escape the menu arms.
 * How the map applies it is driven on real Leaflet in routeDragSnap.spec.ts;
 * the surfaces that offer it are read from their source here. */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { display, setLockRouteInFlight } from '$lib/state/display.svelte';
import { nav } from '$lib/state/navRecording.svelte';
import { armWaypointMove, endWaypointMove, routeLock, routeLocked } from '$lib/state/routeLock.svelte';

afterEach(() => {
	nav.recording = false;
	setLockRouteInFlight(true);
	endWaypointMove();
});

describe('the lock', () => {
	it('holds while a recording runs, and only then', () => {
		expect(display.lockRouteInFlight, 'on by default').toBe(true);
		expect(routeLocked(), 'on the ground').toBe(false);
		nav.recording = true;
		expect(routeLocked()).toBe(true);
		nav.recording = false;
		expect(routeLocked()).toBe(false);
	});

	it('is the pilot\'s to turn off, in flight as on the ground', () => {
		nav.recording = true;
		setLockRouteInFlight(false);
		expect(routeLocked()).toBe(false);
		setLockRouteInFlight(true);
		expect(routeLocked()).toBe(true);
	});

	it('arms one waypoint for one drag, and lets it go', () => {
		armWaypointMove('wp-7');
		expect(routeLock.moveId).toBe('wp-7');
		armWaypointMove('wp-8');
		expect(routeLock.moveId, 'one at a time').toBe('wp-8');
		endWaypointMove();
		expect(routeLock.moveId).toBeNull();
	});
});

describe('the surfaces', () => {
	const menu = readFileSync('src/lib/components/ContextMenu.svelte', 'utf8');
	const mapView = readFileSync('src/lib/components/MapView.svelte', 'utf8');
	const chip = readFileSync('src/lib/components/UndoChip.svelte', 'utf8');
	const settings = readFileSync('src/lib/components/tabs/SettingsTab.svelte', 'utf8');

	it('the menu offers Move waypoint per pin under the press, while locked only', () => {
		expect(menu).toContain('const locked = $derived(routeLocked());');
		expect(menu).toMatch(
			/\{#if locked\}\s*\{#each contextMenu\.waypoints as wp \(wp\.id\)\}\s*<button\s+class="item action"\s+onclick=\{\(\) => onMoveWaypoint\(wp\.id\)\}/,
		);
		const fn = menu.slice(menu.indexOf('function onMoveWaypoint('), menu.indexOf('function moveLabel('));
		expect(fn).toContain('armWaypointMove(id);');
		expect(fn).toContain('closeContextMenu();');
	});

	it('the map applies the lock from the rule, lets a stale arm go, and Escape ends an arm', () => {
		const effect = mapView.slice(mapView.indexOf('const locked = routeLocked();') - 200, mapView.indexOf('setRouteLock(locked, locked ? moveId : null, endWaypointMove);') + 80);
		expect(effect).toContain('$effect(() => {');
		expect(effect).toMatch(/if \(!locked && moveId !== null\) \{\s*untrack\(\(\) => endWaypointMove\(\)\);\s*\}/);
		expect(mapView).toMatch(/if \(e\.key === 'Escape' && routeLock\.moveId !== null\) \{\s*endWaypointMove\(\);\s*\}/);
	});

	it('the chip says what an armed waypoint waits for, with a Cancel that lets it go', () => {
		expect(chip).toMatch(/\{#if moving\}[\s\S]*onclick=\{endWaypointMove\}>\{t\.common\.cancel\}[\s\S]*\{:else if shown && undoChip\.kind\}/);
		expect(chip).toContain('return name ? t.map.moveArmedNamed(name) : t.map.moveArmed;');
	});

	it('Settings offers the switch on every layout, not with the phone\'s rows only', () => {
		const lock = settings.indexOf('checked={display.lockRouteInFlight}');
		const phone = settings.indexOf('{#if ui.isMobile}');
		expect(lock).toBeGreaterThan(0);
		expect(phone, 'the phone rows follow it inside the fieldset').toBeGreaterThan(lock);
		expect(settings.slice(lock, lock + 200)).toContain('onchange={(e) => setLockRouteInFlight(e.currentTarget.checked)}');
		const fieldset = settings.lastIndexOf('<fieldset class="group">', lock);
		expect(settings.slice(fieldset, lock), 'the fieldset is not behind the phone test').not.toContain('{#if');
	});
});
