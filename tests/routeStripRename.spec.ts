/* A route tab's rename: double-click, type, then Enter or a click elsewhere
 * commits and Escape discards. Escape closes the editor by removing the
 * input, and Chromium fires blur on a focused element it removes (Firefox
 * does not), so the input's blur commit renamed the route to the abandoned
 * text, an undo step with it. The strip's own functions and handlers run
 * here over a stand-in for the route state (tests/helpers/componentCode.ts). */

import { describe, expect, it, vi } from 'vitest';
import { componentCode, run } from './helpers/componentCode';

const strip = componentCode('src/lib/components/tabs/route/RouteStrip.svelte');

interface Tab {
	start: () => void;
	keydown: (e: { key: string; currentTarget: { value: string } }) => void;
	blur: (e: { currentTarget: { value: string } }) => void;
	editing: () => string | null;
}

function tab(): { tab: Tab; renameRoute: ReturnType<typeof vi.fn> } {
	const renameRoute = vi.fn();
	const t = run<Tab>(
		{ setActiveRoute: () => {}, renameRoute, r: { id: 'route-1' } },
		`let editingId = null;
		${strip.declarations('cancelled', 'startRename', 'cancelRename', 'commitRename')};
		return {
			start: () => startRename(r.id),
			keydown: ${strip.attribute('route-rename', 'onkeydown')},
			blur: ${strip.attribute('route-rename', 'onblur')},
			editing: () => editingId,
		};`,
	);
	return { tab: t, renameRoute };
}

const typed = { currentTarget: { value: 'Corse day 2' } };

describe("a route tab's rename", () => {
	it('discards the typed name on Escape, the blur of the removed input included', () => {
		const { tab: t, renameRoute } = tab();
		t.start();
		t.keydown({ key: 'Escape', ...typed });
		t.blur(typed);
		expect(t.editing()).toBeNull();
		expect(renameRoute).not.toHaveBeenCalled();
	});

	it('commits on Enter, and on a blur elsewhere', () => {
		const { tab: t, renameRoute } = tab();
		t.start();
		t.keydown({ key: 'Enter', ...typed });
		expect(renameRoute).toHaveBeenLastCalledWith('route-1', 'Corse day 2');
		expect(t.editing()).toBeNull();
		renameRoute.mockClear();
		t.start();
		t.blur(typed);
		expect(renameRoute).toHaveBeenCalledWith('route-1', 'Corse day 2');
	});

	it('commits the next rename after an Escape discarded one', () => {
		const { tab: t, renameRoute } = tab();
		t.start();
		t.keydown({ key: 'Escape', ...typed });
		t.blur(typed);
		t.start();
		t.blur(typed);
		expect(renameRoute).toHaveBeenCalledTimes(1);
	});
});
