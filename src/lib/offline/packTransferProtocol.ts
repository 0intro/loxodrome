/* packTransferProtocol.ts: what the page and the pack transfer worker say to
 * each other (packTransferClient.ts, packTransfer.worker.ts).
 *
 * One transfer per worker. The page starts it and may abort it; the worker
 * answers progress, then exactly ONE terminal message, `done` or `failed`,
 * posted only after it has flushed and closed its handles: the page may
 * touch the part the moment it hears one. `unsupported` comes only before
 * anything was written or fetched, so the page may take the attempt itself. */

/** Where the transfer writes and what it fetches. */
export interface StartJob {
	type: 'start';
	/** The family's directory under the OPFS root. */
	dir: string;
	/** The part's file name, and its sidecar's (the etag file). */
	part: string;
	etagFile: string;
	/** The archive, ABSOLUTE: a worker resolves a relative URL against its
	 *  own script, not the page. */
	url: string;
}

export type ToWorker = StartJob | { type: 'abort' };

/** Why a transfer stopped, as plain data the page turns back into the error
 *  its callers test (packTransferClient.ts). */
export type TransferFailure =
	| { kind: 'abort' }
	| { kind: 'http'; status: number; phase: 'HEAD' | 'GET' }
	| { kind: 'error'; name: string; message: string };

export type FromWorker =
	| { type: 'ready' }
	| { type: 'unsupported'; reason: string }
	| { type: 'progress'; received: number; total: number | null }
	| { type: 'done'; received: number; total: number | null; etag: string | null }
	| { type: 'failed'; received: number; total: number | null; failure: TransferFailure };
