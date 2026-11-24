/* Real-DOM measurement of the packs' loading sheets, at print-prep time (the
 * navlogMeasure.ts pattern): mount the M&B page in its pack rendition with
 * every pair two neighbours could make, at the landscape sheet's own content
 * width, off-viewport, read each pair's rendered height and pair the trips
 * whose pair fits a sheet (mbBlocks.ts). A pair's columns share their rows,
 * so its height is the two together, never either column alone. The pack
 * renditions render no input, no button and no select, only what paper
 * shows, and their line box is pinned on screen as on paper, so the
 * measured layout IS the printed one. Null on any inconsistency; the print
 * then puts every trip on its own sheet, which always fits. */

import { mount, tick, unmount } from 'svelte';
import MassBalancePage from './MassBalancePage.svelte';
import { PAIR_BUDGET_MM, PAIR_SHEET_MM, PX_PER_MM, candidatePairs, pairBlocks } from './mbBlocks';

export async function measureMbBlocks(n: number): Promise<number[][] | null> {
	if (typeof document === 'undefined' || n < 2) {
		return null;
	}
	const host = document.createElement('div');
	host.style.position = 'fixed';
	host.style.left = '-10000px';
	host.style.top = '0';
	host.style.width = `${PAIR_SHEET_MM}mm`;
	host.style.visibility = 'hidden';
	document.body.appendChild(host);
	let page: Record<string, unknown> | null = null;
	try {
		page = mount(MassBalancePage, { target: host, props: { pack: true, blocks: candidatePairs(n) } });
		await tick();
		await document.fonts.ready;
		await new Promise((res) => requestAnimationFrame(() => res(undefined)));
		// i18n-ignore-start: CSS selectors, not user-visible text
		const pairs = Array.from(host.querySelectorAll<HTMLElement>('[data-block]'));
		// i18n-ignore-end
		if (pairs.length !== n - 1) {
			return null;
		}
		const heights = pairs.map((b) => b.getBoundingClientRect().height);
		if (heights.some((h) => !(h > 0))) {
			return null;
		}
		return pairBlocks(n, heights, PAIR_BUDGET_MM * PX_PER_MM);
	} catch {
		return null;
	} finally {
		if (page) {
			void unmount(page);
		}
		host.remove();
	}
}
