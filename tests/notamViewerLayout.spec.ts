/* The NOTAM Viewer's shell re-places its open surfaces when the phone is
 * turned or the phone layout comes or goes (src/notam/layout.ts). It only
 * flipped the two flags, so the detail pane kept the edge it was opened on:
 * turned sideways on the measured 392 x 791 device it stayed a bottom dock
 * clamped over a 300 px stage, the map 30 px tall, its handle cycling a right
 * dock the pane was not in; turned back, a right column left the map 76 px
 * wide. The real workspace, driven through the shell's own step. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

function storage(): Storage {
	const store = new Map<string, string>();
	return {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		key: (i: number) => [...store.keys()][i] ?? null,
		get length() {
			return store.size;
		},
		clear: () => store.clear(),
	};
}

// The measured device, 392 x 791 CSS px, less the viewer's bar and the phone
// bar in each orientation.
const PORTRAIT = { width: 392, height: 699 };
const LANDSCAPE = { width: 791, height: 300 };

async function shell() {
	vi.resetModules();
	vi.stubGlobal('localStorage', storage());
	const { ui } = await import('$lib/state/ui.svelte');
	const ws = await import('$lib/state/workspace.svelte');
	const { applyLayout } = await import('../src/notam/layout');
	return { ui, ws, applyLayout };
}

describe('the viewer shell turned with the detail pane open', () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it('moves the pane to the right dock when the phone is turned sideways', async () => {
		const { ui, ws, applyLayout } = await shell();
		applyLayout(true, false, () => PORTRAIT);
		ws.setStageSize(PORTRAIT.width, PORTRAIT.height);
		ws.openSurface('detail');
		expect(ws.placementOf('detail')).toBe('dock-bottom');
		applyLayout(true, true, () => LANDSCAPE);
		expect(ui.isLandscapePhone).toBe(true);
		expect(ws.placementOf('detail')).toBe('dock-right');
		expect(ws.workspace.dockPx.bottom).toBe(0);
		expect(ws.workspace.dockPx.right).toBeGreaterThan(0);
		expect(ws.workspace.dockPx.right).toBeLessThan(LANDSCAPE.width);
	});

	it('moves it back under the map when the phone is turned upright', async () => {
		const { ws, applyLayout } = await shell();
		applyLayout(true, true, () => LANDSCAPE);
		ws.setStageSize(LANDSCAPE.width, LANDSCAPE.height);
		ws.openSurface('detail');
		expect(ws.placementOf('detail')).toBe('dock-right');
		applyLayout(true, false, () => PORTRAIT);
		expect(ws.placementOf('detail')).toBe('dock-bottom');
		expect(ws.workspace.dockPx.right).toBe(0);
		expect(ws.workspace.dockPx.bottom).toBeLessThan(PORTRAIT.height);
	});

	it('leaves the surfaces alone when neither flag moved', async () => {
		const { ws, applyLayout } = await shell();
		applyLayout(true, false, () => PORTRAIT);
		ws.setStageSize(PORTRAIT.width, PORTRAIT.height);
		ws.openSurface('detail');
		const before = ws.workspace.dockPx.bottom;
		let measured = 0;
		applyLayout(true, false, () => {
			measured++;
			return PORTRAIT;
		});
		expect(measured).toBe(0);
		expect(ws.workspace.dockPx.bottom).toBe(before);
	});

	it('is what the shell runs on every media change', () => {
		const src = readFileSync('src/notam/App.svelte', 'utf8');
		const handler = /const apply = \(\): void => \{([\s\S]*?)\n\t\t\};/.exec(src)?.[1] ?? '';
		expect(handler).toContain('applyLayout(phone.matches, landscape.matches,');
		expect(src).toMatch(/phone\.addEventListener\('change', apply\)/);
		expect(src).toMatch(/landscape\.addEventListener\('change', apply\)/);
	});
});
