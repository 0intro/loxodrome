/* The account-api wire client (docs/accounts-sync.md): thin typed fetch
 * over the /v1 endpoints, no state, no Svelte. Errors surface as
 * ApiError carrying the server's TYPED code verbatim (the errorText
 * doctrine: the UI words codes at render, upstream text stays
 * untranslated); a network failure is the code 'network', which the
 * engine treats as the quiet offline state, never an error surface.
 *
 * The base URL resolves localStorage override -> VITE_ACCOUNT_API_URL
 * -> the shipped address (the autorouter three-tier idiom); the env
 * tier is also the debug-APK hook for on-device e2e. */

import { ACCOUNT_API_DEFAULT } from '$lib/net/endpoints';
import { readItem } from '$lib/state/persist';
import { unwrapInline } from './model';
import type { ChangesResponse, PushDoc, PushResult, WireDoc } from './model';

const LS_API = 'loxodrome:account-api';

/** The API base in force, trailing slashes trimmed. */
export function accountApiBase(): string {
	return (readItem(LS_API) ?? ACCOUNT_API_DEFAULT).replace(/\/+$/, '');
}

/** A typed refusal from the API (or the 'network' code for no answer at
 *  all). `code` is the server's error string, worded by the UI. */
export class ApiError extends Error {
	readonly code: string;
	readonly status: number;
	readonly retryAfterS: number | undefined;
	constructor(code: string, status: number, retryAfterS?: number) {
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		super(`account-api: ${code} (${status})`);
		this.code = code;
		this.status = status;
		this.retryAfterS = retryAfterS;
	}
}

/** A hung request must not wedge the writer lock (the whole pass awaits
 *  the transport under it): every call carries a deadline, blobs a
 *  longer one (megabytes on a slow link). An abort surfaces as the
 *  quiet 'network' code. */
function deadline(ms: number): AbortSignal | undefined {
	try {
		return AbortSignal.timeout(ms);
	} catch {
		return undefined; // ancient runtime: no deadline, same behavior
	}
}

async function call(
	path: string,
	init: RequestInit & { token?: string; timeoutMs?: number },
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (init.token !== undefined) {
		headers.set('Authorization', `Bearer ${init.token}`);
	}
	if (init.body !== undefined && typeof init.body === 'string') {
		headers.set('Content-Type', 'application/json');
	}
	const signal = deadline(init.timeoutMs ?? 30_000);
	let res: Response;
	try {
		res = await fetch(`${accountApiBase()}${path}`, {
			...init,
			headers,
			...(signal ? { signal } : {}),
		});
	} catch {
		throw new ApiError('network', 0);
	}
	if (res.ok || res.status === 204) {
		return res;
	}
	let code = 'internal';
	let retryAfterS: number | undefined;
	try {
		const body = (await res.json()) as { error?: string; retryAfterS?: number };
		if (typeof body.error === 'string') {
			code = body.error;
		}
		if (typeof body.retryAfterS === 'number') {
			retryAfterS = body.retryAfterS;
		}
	} catch {
		/* a non-JSON refusal keeps the generic code */
	}
	throw new ApiError(code, res.status, retryAfterS);
}

async function jsonOf<T>(res: Response): Promise<T> {
	return (await res.json()) as T;
}

// --- auth ------------------------------------------------------------------

/** `token` (a live bearer for the SAME address) stands in for the
 *  Turnstile token on the sudo re-verify path. */
export async function requestCode(
	email: string,
	turnstile: string,
	locale: string,
	token?: string,
): Promise<void> {
	await call('/v1/auth/code', {
		method: 'POST',
		...(token !== undefined ? { token } : {}),
		body: JSON.stringify({ email, turnstile, locale }),
	});
}

export interface VerifyResult {
	token: string;
	userId: string;
	created: boolean;
	status: string;
}

export async function verifyCode(
	email: string,
	code: string,
	deviceName: string,
	mode: 'personal' | 'shared',
): Promise<VerifyResult> {
	return jsonOf(
		await call('/v1/auth/verify', {
			method: 'POST',
			body: JSON.stringify({ email, code, deviceName, mode }),
		}),
	);
}

// --- sync ------------------------------------------------------------------

/** `full` marks a continuation page of a full listing (the pages after a
 *  `reset`): the server then skips its horizon clamp, which would
 *  otherwise send the cursor back to zero on every page and never let a
 *  >200-doc account past page one. */
export async function fetchChanges(
	token: string,
	since: number,
	full = false,
): Promise<ChangesResponse> {
	return jsonOf(
		await call(`/v1/sync/changes?since=${since}${full ? '&full=1' : ''}`, {
			method: 'GET',
			token,
		}),
	);
}

export async function pushDocs(token: string, docs: PushDoc[]): Promise<PushResult[]> {
	const out = await jsonOf<{ results: PushResult[] }>(
		await call('/v1/sync/push', { method: 'POST', token, body: JSON.stringify({ docs }) }),
	);
	return out.results;
}

export async function putBlob(token: string, hash: string, bytes: Uint8Array): Promise<void> {
	await call(`/v1/blobs/${hash}`, {
		method: 'PUT',
		token,
		body: bytes as unknown as BodyInit,
		timeoutMs: 120_000,
	});
}

/** The stored (framed, deflated) blob bytes; the CALLER unwraps,
 *  inflates and VERIFIES the hash before anything is applied. */
export async function getBlob(token: string, hash: string): Promise<Uint8Array> {
	const res = await call(`/v1/blobs/${hash}`, { method: 'GET', token, timeoutMs: 120_000 });
	return new Uint8Array(await res.arrayBuffer());
}

// --- account ---------------------------------------------------------------

export interface AccountSession {
	id: string;
	deviceName: string;
	mode: string;
	createdAt: number;
	lastSeen: number;
	current: boolean;
}

export interface AccountInfo {
	email: string;
	bytesUsed: number;
	quotaBytes: number;
	status: string;
	deleteAfter: number | null;
	sessions: AccountSession[];
}

export async function fetchAccount(token: string): Promise<AccountInfo> {
	return jsonOf(await call('/v1/account', { method: 'GET', token }));
}

export async function renameSession(token: string, deviceName: string): Promise<void> {
	await call('/v1/sessions/current', {
		method: 'PATCH',
		token,
		body: JSON.stringify({ deviceName }),
	});
}

export async function signOutSession(token: string): Promise<void> {
	await call('/v1/sessions/current', { method: 'DELETE', token });
}

export async function revokeSession(token: string, id: string): Promise<void> {
	await call(`/v1/sessions/${id}`, { method: 'DELETE', token });
}

/** Sudo-gated: `code` is a FRESH login code for the account's address. */
export async function signOutEverywhere(token: string, code: string): Promise<void> {
	await call('/v1/sessions', { method: 'DELETE', token, body: JSON.stringify({ code }) });
}

/** Sudo-gated staged deletion; answers the purge instant. */
export async function deleteAccount(token: string, code: string): Promise<number | null> {
	const out = await jsonOf<{ deleteAfter?: number }>(
		await call('/v1/account', { method: 'DELETE', token, body: JSON.stringify({ code }) }),
	);
	return out.deleteAfter ?? null;
}

export async function restoreAccount(token: string): Promise<void> {
	await call('/v1/account/restore', { method: 'POST', token, body: JSON.stringify({}) });
}

/** The wire doc's payload text, or null (tombstones, blob-only docs);
 *  routed through the envelope so a future alg cannot leak raw. */
export function wirePayloadText(doc: WireDoc): string | null {
	return doc.payload ? unwrapInline(doc.payload) : null;
}
