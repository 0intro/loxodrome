/* packTransfer.worker.ts: a pack written in place, off the main thread
 * (docs/offline-maps.md, "Downloads"). The work is packTransferCore.ts's;
 * this binds it to the worker's own scope, the one place a
 * FileSystemSyncAccessHandle may be held. Its static imports are held to the
 * transfer's own modules, which tests/packTransferPurity.spec.ts checks: a
 * worker that reached packStore or the client would close a circle Vite
 * refuses to build. No top-level await: workers are built as classic
 * scripts (appWorker, vite.shared.ts). */

import { PackTransferCore, type SyncAccessHandle } from './packTransferCore';
import type { FromWorker, ToWorker } from './packTransferProtocol';

interface WorkerScope {
	postMessage(message: FromWorker): void;
	onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
	addEventListener(type: 'unhandledrejection', listener: (e: { reason: unknown }) => void): void;
}

const scope = self as unknown as WorkerScope;

const core = new PackTransferCore({
	post: (msg) => {
		scope.postMessage(msg);
	},
	root: () => navigator.storage.getDirectory(),
	probe: () => {
		if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
			// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
			return 'no origin private file system';
		}
		const proto = (globalThis as { FileSystemFileHandle?: { prototype: { createSyncAccessHandle?: () => Promise<SyncAccessHandle> } } })
			.FileSystemFileHandle?.prototype;
		if (typeof proto?.createSyncAccessHandle !== 'function') {
			// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
			return 'no sync access handles';
		}
		return null;
	},
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

scope.onmessage = (e) => {
	core.handle(e.data);
};
// A rejection fires no Worker.onerror on the page: the page would wait out
// its deadline. The core catches its own; this is the net under it.
scope.addEventListener('unhandledrejection', (e) => {
	core.fail(e.reason);
});
core.start();
