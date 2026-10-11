/* decoProtocol.ts: what the page and the decoration worker say to each other
 * (decoWorkerClient.ts, decoPaint.worker.ts).
 *
 * Zones cross once each, named by a number both sides keep (gid), before the
 * first painting that needs them; a painting names its zones by those
 * numbers, in stacking order. The zones' arrays are transferred, not copied:
 * the page keeps no ring it no longer paints. A painting comes back as an
 * ImageBitmap, transferred too. */

import type { DecoFrame } from './decoPaint';
import type { DecoZone } from './decoZone';

/** A zone on its way to the worker, with the number both sides name it by. */
export interface WireZone extends DecoZone {
	gid: number;
}

export type ToWorker =
	| { type: 'zones'; zones: WireZone[] }
	| {
			type: 'paint';
			seq: number;
			frame: DecoFrame;
			/** The canvas to paint, device px. */
			width: number;
			height: number;
			/** The rows shown, largest first. */
			zones: Uint32Array;
			/** The highlighted zones, drawn whatever the filters. */
			highlighted: Uint32Array;
			/** The zones stroked in the emphasis where drawn (linked to a
			 *  selected NOTAM). */
			outlined: Uint32Array;
	  }
	| { type: 'forget'; gids: Uint32Array };

export type FromWorker =
	| { type: 'ready' }
	| { type: 'unsupported'; reason: string }
	| { type: 'frame'; seq: number; bitmap: ImageBitmap }
	| { type: 'failed'; seq: number; reason: string };

/** The buffers a message hands over rather than copies. */
export function transfersOf(msg: ToWorker): Transferable[] {
	switch (msg.type) {
		case 'zones': {
			const out: Transferable[] = [];
			for (const z of msg.zones) {
				out.push(z.ring.buffer);
				for (const line of z.arcs ?? []) {
					out.push(line.buffer);
				}
				for (const line of z.internal ?? []) {
					out.push(line.buffer);
				}
			}
			return out;
		}
		case 'paint':
			return [msg.zones.buffer, msg.highlighted.buffer, msg.outlined.buffer];
		case 'forget':
			return [msg.gids.buffer];
	}
}
