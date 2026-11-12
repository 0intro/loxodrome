/* The side panels' and the landscape pane's resize drag (ui/resize.ts), over
 * DOM-less stand-ins: the window and the grip record their listeners and
 * deliver an event to them. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startResize } from '$lib/ui/resize';

type Handler = (e: unknown) => void;

class Target {
	hs: Record<string, Handler[]> = {};
	addEventListener(t: string, h: Handler): void {
		(this.hs[t] ??= []).push(h);
	}
	removeEventListener(t: string, h: Handler): void {
		this.hs[t] = (this.hs[t] ?? []).filter((x) => x !== h);
	}
	fire(t: string, e: unknown): void {
		for (const h of [...(this.hs[t] ?? [])]) {
			h(e);
		}
	}
	setPointerCapture(): void {}
}

function stubEnv(): { win: Target; grip: Target } {
	const win = new Target();
	vi.stubGlobal('window', win);
	vi.stubGlobal('document', { body: { style: {} } });
	vi.stubGlobal('Element', Target);
	return { win, grip: new Target() };
}

function press(grip: Target, pointerId: number, clientX: number): PointerEvent {
	return { pointerId, clientX, currentTarget: grip, preventDefault: () => {} } as unknown as PointerEvent;
}

describe('startResize', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('runs on when capture comes to the grip from a child', () => {
		// A finger's press holds capture on the element it landed on (the
		// landscape handle's pill). Taking capture on the grip fires
		// lostpointercapture at that child, and the event bubbles to the
		// grip: read as the grip's own loss, it committed the drag at once.
		const { win, grip } = stubEnv();
		const widths: number[] = [];
		const commits: number[] = [];
		startResize(press(grip, 1, 100), 300, { dir: -1, min: 100, max: 800 }, (w) => widths.push(w), (w) => commits.push(w));
		grip.fire('lostpointercapture', { pointerId: 1, target: { a: 'pill' } });
		expect(commits).toEqual([]);
		win.fire('pointermove', { pointerId: 1, clientX: 60 });
		win.fire('pointerup', { pointerId: 1 });
		expect(widths).toEqual([340]);
		expect(commits).toEqual([340]);
	});

	it('settles when the grip itself loses capture', () => {
		const { win, grip } = stubEnv();
		const commits: number[] = [];
		startResize(press(grip, 2, 100), 300, { dir: -1, min: 100, max: 800 }, () => {}, (w) => commits.push(w));
		win.fire('pointermove', { pointerId: 2, clientX: 80 });
		grip.fire('lostpointercapture', { pointerId: 2, target: grip });
		expect(commits).toEqual([320]);
		// The next drag is not refused by a flag nobody cleared.
		startResize(press(grip, 3, 100), 300, { dir: -1, min: 100, max: 800 }, () => {}, (w) => commits.push(w));
		win.fire('pointerup', { pointerId: 3 });
		expect(commits).toEqual([320, 300]);
	});
});
