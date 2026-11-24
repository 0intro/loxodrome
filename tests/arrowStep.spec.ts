/* The steppers that listen on the WINDOW for a bare Left or Right arrow:
 * the nav log's and the route profile's route (NavLogModal,
 * RouteProfileModal) and the detail panel's NOTAM (detailKeydown). The
 * window hears a key after every element handler, so a key a focused control
 * already used (the chart's pan, a leg's nudge, the route strip's own step)
 * steps nothing, and a step marks the key used, so the next stepper on the
 * window skips it: with the nav log and the route profile both docked, one
 * press must move the route by one. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { stepOnArrow } from '$lib/ui/focus';
import { addRoute, clearAllRoutes, routes, setActiveRoute, stepActiveRoute } from '$lib/state/route.svelte';
import { detailKeydown, type NotamStepper } from '$lib/components/detail/detailHead.svelte';
import { closeDetail, selectNotam, ui } from '$lib/state/ui.svelte';

vi.mock('leaflet', () => ({ default: {} }));

// The SVG targets a browser hands over (a leg, the chart) are Elements but
// not HTMLElements.
beforeAll(() => {
	vi.stubGlobal('HTMLElement', class {});
});

afterEach(() => {
	closeDetail();
});

interface FakeTarget {
	tagName: string;
	isContentEditable: boolean;
	getAttribute: (name: string) => string | null;
	closest: (selector: string) => object | null;
}

/** An element, by tag, attributes and the classes of its ancestors. */
function el(tagName: string, attrs: Record<string, string> = {}, within: string[] = []): FakeTarget {
	return {
		tagName,
		isContentEditable: false,
		getAttribute: (name) => attrs[name] ?? null,
		closest: (selector) => (selector.split(',').some((s) => within.includes(s.trim())) ? {} : null),
	};
}

interface KeyInit {
	target?: FakeTarget;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
	defaultPrevented?: boolean;
}

function press(key: string, init: KeyInit = {}): KeyboardEvent {
	const e = {
		key,
		target: el('BUTTON'),
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		defaultPrevented: false,
		...init,
		preventDefault(): void {
			e.defaultPrevented = true;
		},
	};
	return e as unknown as KeyboardEvent;
}

describe('stepOnArrow', () => {
	function steps(e: KeyboardEvent, moved = true): number[] {
		const out: number[] = [];
		stepOnArrow(e, (delta) => {
			out.push(delta);
			return moved;
		});
		return out;
	}

	it('steps on a bare arrow and marks the key used', () => {
		const right = press('ArrowRight');
		expect(steps(right)).toEqual([1]);
		expect(right.defaultPrevented).toBe(true);
		expect(steps(press('ArrowLeft'))).toEqual([-1]);
	});

	it('leaves a key that moved nothing to the next stepper', () => {
		const e = press('ArrowRight');
		expect(steps(e, false)).toEqual([1]);
		expect(e.defaultPrevented).toBe(false);
	});

	it('steps nothing on a key a focused control used, a modifier or an editable target', () => {
		const cases: [string, KeyboardEvent][] = [
			['another key', press('ArrowUp')],
			['the chart’s pan', press('ArrowRight', { target: el('svg', { role: 'group' }), defaultPrevented: true })],
			['Ctrl', press('ArrowRight', { ctrlKey: true })],
			['Meta', press('ArrowRight', { metaKey: true })],
			['Alt', press('ArrowRight', { altKey: true })],
			['Shift', press('ArrowRight', { shiftKey: true })],
			['a text field', press('ArrowRight', { target: el('INPUT') })],
			['a leg (an SVG slider)', press('ArrowRight', { target: el('path', { role: 'slider' }) })],
		];
		for (const [what, e] of cases) {
			expect(steps(e), what).toEqual([]);
		}
	});
});

describe('the two route steppers on the window', () => {
	it('move the route by one on one press', () => {
		clearAllRoutes();
		const first = routes.activeId;
		addRoute();
		addRoute();
		setActiveRoute(first);
		const e = press('ArrowRight');
		// The nav log's handler, then the route profile's.
		stepOnArrow(e, stepActiveRoute);
		stepOnArrow(e, stepActiveRoute);
		expect(routes.list.findIndex((r) => r.id === routes.activeId)).toBe(1);
	});

	it('are both modals’ window handlers', () => {
		for (const file of ['NavLogModal', 'RouteProfileModal']) {
			const src = readFileSync(`src/lib/components/${file}.svelte`, 'utf8');
			const at = src.indexOf('<svelte:window');
			const handler = src.slice(at, src.indexOf('/>', at));
			expect(handler, file).toContain('stepOnArrow(e, stepActiveRoute)');
		}
	});
});

describe('detailKeydown', () => {
	const nav: NotamStepper = { pos: 1, total: 3, prev: 4, next: 7 };

	function stepped(e: KeyboardEvent): number | null {
		selectNotam(5, true);
		detailKeydown(e, nav);
		return ui.detail?.kind === 'notam' ? ui.detail.index : null;
	}

	it('steps the list on a bare arrow', () => {
		expect(stepped(press('ArrowRight'))).toBe(7);
		expect(stepped(press('ArrowLeft'))).toBe(4);
	});

	it('leaves a key the profile chart, a leg or a slider used', () => {
		expect(stepped(press('ArrowRight', { target: el('svg', { role: 'group' }), defaultPrevented: true }))).toBe(5);
		expect(stepped(press('ArrowRight', { target: el('path', { role: 'slider' }) }))).toBe(5);
		expect(stepped(press('ArrowRight', { target: el('BUTTON', { role: 'slider' }) }))).toBe(5);
	});

	it('leaves the resize handle, the dock grip and the map their own arrows', () => {
		for (const within of ['.resize-handle', '.dock-grip', '.leaflet-container']) {
			expect(stepped(press('ArrowRight', { target: el('path', {}, [within]) })), within).toBe(5);
		}
	});
});
