/* The banners' action says what it is doing. A press on Reload or Retry now
 * left the button as it was while the work ran, so nothing told the pilot
 * the press had been taken. While `busy` the button reads its running form,
 * the idle label kept beside it, hidden, so the box keeps its width, and it
 * absorbs a press through aria-disabled, which keeps the focus where
 * `disabled` would drop it. */

import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Banner from '$lib/components/Banner.svelte';

const props = {
	text: 'A new version is available.',
	actionLabel: 'Reload',
	busyLabel: 'Reloading…',
	dismissLabel: 'Dismiss',
	onDismiss: () => {},
};

/** The action button's markup. */
function action(busy: boolean): string {
	const body = render(Banner, { props: { ...props, busy } }).body;
	const m = /<button type="button" class="btn action[^"]*"[^>]*>[\s\S]*?<\/button>/.exec(body);
	expect(m).not.toBeNull();
	return m![0];
}

/** The labels shown, and those kept hidden. */
function labels(html: string): { shown: string[]; hidden: string[] } {
	const out = { shown: [] as string[], hidden: [] as string[] };
	for (const m of html.matchAll(/<span class="label([^"]*)"[^>]*>([^<]*)<\/span>/g)) {
		(/\boff\b/.test(m[1]) ? out.hidden : out.shown).push(m[2]);
	}
	return out;
}

describe('the banner action', () => {
	it('reads its label at rest', () => {
		const html = action(false);
		expect(html).not.toContain('aria-disabled');
		expect(labels(html)).toEqual({ shown: ['Reload'], hidden: ['Reloading…'] });
	});

	it('reads its running form while the work runs, and absorbs a press', () => {
		const html = action(true);
		expect(html).toContain('aria-disabled="true"');
		expect(html).not.toMatch(/\sdisabled[\s=>]/);
		expect(labels(html)).toEqual({ shown: ['Reloading…'], hidden: ['Reload'] });
	});

	it('sits inside the live region, which announces the change', () => {
		const body = render(Banner, { props: { ...props, busy: true } }).body;
		expect(body).toMatch(/<aside class="banner[^"]*" role="status">[\s\S]*Reloading…[\s\S]*<\/aside>/);
	});
});
