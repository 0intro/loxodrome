/* decoWorkerCore.ts: the decoration worker's logic (decoPaint.worker.ts runs
 * it), with its canvases and its post handed in, so a spec can run it in Node.
 *
 * It keeps the zones the page sends, paints what it is asked to with the
 * page's own painter (decoPaint.ts) on an OffscreenCanvas, and answers with
 * the bitmap. It first makes sure the platform paints what the decorations
 * need: a 2d context, Path2D, clipping, dashes, patterns, text that actually
 * reaches the pixels (a worker with no font draws nothing and says nothing),
 * and a bitmap to hand back. A worker that answers `unsupported` is replaced
 * by painting on the page (decoWorkerClient.ts). */

import { DecoPainter, scratchOver, type Scratch } from './decoPaint';
import type { FromWorker, ToWorker } from './decoProtocol';
import type { DecoZone } from './decoZone';

export interface WorkerEnv {
	post(msg: FromWorker, transfer: Transferable[]): void;
	/** A canvas of the given device-pixel size. */
	canvas(width: number, height: number): OffscreenCanvas;
}

/** A canvas as the painter's scratch. */
function scratchOf(canvas: OffscreenCanvas): Scratch | null {
	const ctx = canvas.getContext('2d');
	return ctx ? scratchOver(canvas, ctx) : null;
}

/** Why the platform cannot paint the decorations here, or null when it can. */
export function probePaint(env: WorkerEnv): string | null {
	try {
		if (typeof Path2D !== 'function') {
			return 'path2d';
		}
		const canvas = env.canvas(16, 16);
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			return 'context';
		}
		const path = new Path2D();
		path.rect(2, 2, 12, 12);
		ctx.save();
		ctx.clip(path);
		ctx.setLineDash([2, 2]);
		ctx.stroke(path);
		ctx.restore();
		if (!ctx.createPattern(env.canvas(2, 2), 'repeat')) {
			return 'pattern';
		}
		ctx.clearRect(0, 0, 16, 16);
		ctx.font = 'bold 11px system-ui, sans-serif'; // i18n-ignore: CSS font shorthand, not display text
		ctx.fillStyle = '#000';
		ctx.fillText('W', 2, 12); // i18n-ignore: a probe glyph, never shown
		const px = ctx.getImageData(0, 0, 16, 16).data;
		let ink = false;
		for (let i = 3; i < px.length && !ink; i += 4) {
			ink = px[i] > 0;
		}
		if (!ink) {
			return 'text';
		}
		canvas.transferToImageBitmap().close();
		return null;
	} catch (err) {
		return `probe: ${String(err)}`;
	}
}

export class DecoWorkerCore {
	private readonly zones = new Map<number, DecoZone>();
	private readonly painter: DecoPainter;
	private surface: { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | null = null;

	constructor(private readonly env: WorkerEnv) {
		this.painter = new DecoPainter((w, h) => scratchOf(env.canvas(w, h)));
	}

	/** Say whether the platform paints what is needed here. */
	start(): void {
		const reason = probePaint(this.env);
		this.env.post(reason === null ? { type: 'ready' } : { type: 'unsupported', reason }, []);
	}

	/** The zones held, for a spec. */
	get held(): number {
		return this.zones.size;
	}

	/** The vertices of the simplified lines held, for a spec. */
	get heldLineVertices(): number {
		return this.painter.heldLineVertices;
	}

	handle(msg: ToWorker): void {
		switch (msg.type) {
			case 'zones':
				for (const z of msg.zones) {
					this.zones.set(z.gid, z);
				}
				return;
			case 'forget':
				for (const gid of msg.gids) {
					const z = this.zones.get(gid);
					if (z) {
						this.painter.forget(z);
						this.zones.delete(gid);
					}
				}
				return;
			case 'paint':
				this.paint(msg);
				return;
		}
	}

	private paint(msg: Extract<ToWorker, { type: 'paint' }>): void {
		try {
			const zones = this.lookup(msg.zones);
			const highlighted = this.lookup(msg.highlighted);
			const outlined = this.lookup(msg.outlined);
			const s = this.surfaceOf(msg.width, msg.height);
			this.painter.paint(s.ctx, s.canvas, msg.frame, zones, highlighted, outlined);
			const bitmap = s.canvas.transferToImageBitmap();
			this.env.post({ type: 'frame', seq: msg.seq, bitmap }, [bitmap]);
		} catch (err) {
			this.env.post({ type: 'failed', seq: msg.seq, reason: String(err) }, []);
		}
	}

	/** The zones named: every one must have been sent, or the page and the
	 *  worker no longer agree, which is a failure, not a partial painting. */
	private lookup(gids: Uint32Array): DecoZone[] {
		const out: DecoZone[] = [];
		for (const gid of gids) {
			const z = this.zones.get(gid);
			if (!z) {
				throw new Error(`zone ${gid} unknown`);
			}
			out.push(z);
		}
		return out;
	}

	private surfaceOf(w: number, h: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
		if (!this.surface) {
			const canvas = this.env.canvas(w, h);
			const ctx = canvas.getContext('2d');
			if (!ctx) {
				throw new Error('no 2d context');
			}
			this.surface = { canvas, ctx };
		} else if (this.surface.canvas.width !== w || this.surface.canvas.height !== h) {
			this.surface.canvas.width = w;
			this.surface.canvas.height = h;
		}
		return this.surface;
	}
}
