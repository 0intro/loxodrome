/* decoPaint.worker.ts: the airspace decorations painted off the main thread.
 * The work is decoWorkerCore.ts's; this binds it to the worker's own scope. Its
 * static imports are held to what a worker can run (no map, no DOM, no app
 * state, no catalogs), which tests/decoWorkerPurity.spec.ts checks. */

import { DecoWorkerCore } from './decoWorkerCore';
import type { ToWorker } from './decoProtocol';

interface WorkerScope {
	postMessage(message: unknown, transfer: Transferable[]): void;
	onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const core = new DecoWorkerCore({
	post: (msg, transfer) => {
		scope.postMessage(msg, transfer);
	},
	canvas: (width, height) => new OffscreenCanvas(width, height),
});
scope.onmessage = (e) => {
	core.handle(e.data);
};
core.start();
