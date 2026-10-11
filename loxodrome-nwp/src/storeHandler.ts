/* What the ingest Container reaches the bucket through, and the publisher's
 * check of a built block: both free of the Container runtime, so the suite
 * runs them under Node. */

import type { Env } from './env.ts';
import type { Receipt } from './plan.ts';
import { checkDescriptor, SEGMENTS } from './archive.ts';
import { Archive, inflateRaw } from './pmtiles.ts';

/** The host the Container stores through. */
export const STORE_HOST = 'r2.nwp';
const STORE_KEY_RE = /^(first|blocks|receipts|static|logs)\/[A-Za-z0-9._/-]+$/;

/** The outbound handler: GET and PUT of an object, R2's multipart upload
 *  in parts, for the keys an ingest writes and nothing else; and the job's
 *  last resort, a line for the Worker's own log (`GET /__log?m=`), when the
 *  bucket would not take its log. */
export async function storeHandler(req: Request, env: Env): Promise<Response> {
	const url = new URL(req.url);
	if (url.pathname === '/__log') {
		console.error(JSON.stringify({ event: 'ingest-report', message: (url.searchParams.get('m') ?? '').slice(0, 1500) }));
		return new Response(null, { status: 204 });
	}
	const key = decodeURIComponent(url.pathname.slice(1));
	if (!STORE_KEY_RE.test(key) || key.includes('..')) {
		return new Response('bad key', { status: 400 });
	}
	const q = url.searchParams;
	const ct = req.headers.get('Content-Type') ?? 'application/octet-stream';
	const body = async (): Promise<ReadableStream | ArrayBuffer> => {
		// R2 takes a stream of known length; a body without one is read.
		return req.headers.get('Content-Length') && req.body ? req.body : await req.arrayBuffer();
	};
	try {
		switch (req.method) {
			case 'GET': {
				const obj = await env.NWP.get(key);
				return obj ? new Response(obj.body) : new Response('not found', { status: 404 });
			}
			case 'PUT': {
				const upload = q.get('upload');
				if (upload && q.has('part')) {
					const part = await env.NWP.resumeMultipartUpload(key, upload).uploadPart(Number(q.get('part')), await body());
					return Response.json({ partNumber: part.partNumber, etag: part.etag });
				}
				await env.NWP.put(key, await body(), { httpMetadata: { contentType: ct } });
				return new Response('ok');
			}
			case 'POST': {
				if (q.has('uploads')) {
					const up = await env.NWP.createMultipartUpload(key, { httpMetadata: { contentType: ct } });
					return Response.json({ uploadId: up.uploadId });
				}
				const upload = q.get('upload');
				if (upload) {
					const { parts } = await req.json<{ parts: R2UploadedPart[] }>();
					await env.NWP.resumeMultipartUpload(key, upload).complete(parts);
					return new Response('ok');
				}
				break;
			}
			case 'DELETE': {
				const upload = q.get('upload');
				if (upload) {
					await env.NWP.resumeMultipartUpload(key, upload).abort();
					return new Response('ok');
				}
				break;
			}
		}
	} catch (err) {
		console.error(JSON.stringify({ event: 'store-error', key, method: req.method, error: String(err) }));
		return new Response(String(err), { status: 500 });
	}
	return new Response('method not allowed', { status: 405 });
}

export function runKey(run: string): string {
	return run.slice(0, 13).replace(/[-T]/g, '');
}

async function sha256Hex(b: Uint8Array): Promise<string> {
	const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b));
	return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Reads a block's canary tiles through the read path's decoder and holds
 *  each segment to its receipt's hash. */
/** A canary read the bucket failed: no verdict on the archive. */
export class CanaryReadFailed extends Error {}

/** The verdict on a receipt's archive: null when its canaries decode to
 *  their hashes, else what is wrong (missing, a tile lacking, a hash
 *  differing, an archive that does not parse). A read the bucket fails is
 *  thrown as CanaryReadFailed: a transient error demoted a served block
 *  and had it built again. */
export async function checkCanaries(bucket: R2Bucket, rec: Receipt): Promise<string | null> {
	try {
		return await canaries(bucket, rec);
	} catch (err) {
		if (err instanceof CanaryReadFailed) {
			throw err;
		}
		return `${rec.key}: ${String(err)}`;
	}
}

async function canaries(bucket: R2Bucket, rec: Receipt): Promise<string | null> {
	const get = async (offset: number, length: number): Promise<R2ObjectBody | null> => {
		try {
			return await bucket.get(rec.key, { range: { offset, length } });
		} catch (err) {
			throw new CanaryReadFailed(`${rec.key}: ${String(err)}`);
		}
	};
	const range = async (offset: number, length: number): Promise<Uint8Array> => {
		const obj = await get(offset, length);
		if (!obj) {
			throw new Error(`${rec.key} missing`);
		}
		return new Uint8Array(await obj.arrayBuffer());
	};
	const head = await get(0, Math.min(rec.size, 64 * 1024));
	if (!head) {
		return `${rec.key} is not in the bucket`;
	}
	const archive = await Archive.open(new Uint8Array(await head.arrayBuffer()), range);
	checkDescriptor(archive.metadata);
	for (const c of rec.canaries) {
		const at = await archive.locate(c.z, c.x, c.y);
		if (!at) {
			return `${rec.key} lacks canary ${c.z}/${c.x}/${c.y}`;
		}
		const payload = await range(at.offset, at.length);
		const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
		let off = 1 + 4 * payload[0];
		for (let s = 0; s < SEGMENTS.length; s++) {
			const len = view.getUint32(1 + 4 * s, true);
			const raw = await inflateRaw(payload.subarray(off, off + len));
			off += len;
			if ((await sha256Hex(raw)) !== c.segments[s]) {
				return `${rec.key} canary ${c.z}/${c.x}/${c.y} segment ${SEGMENTS[s]} differs from its receipt`;
			}
		}
	}
	return null;
}
