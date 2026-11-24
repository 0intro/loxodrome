/* play-api.js: the Google Play Developer API as the Play scripts use it,
 * with Node's own fetch and crypto alone: a service account's token, one
 * call, and an edit that ends committed or deleted. Every error carries the
 * API's own text. */

import { createSign } from 'node:crypto';

export const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
export const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** An access token for the service account whose key file holds `key`. */
export async function accessToken(key) {
	const now = Math.floor(Date.now() / 1000);
	const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const claims = b64url(
		JSON.stringify({
			iss: key.client_email,
			scope: SCOPE,
			aud: key.token_uri,
			iat: now,
			exp: now + 3600,
		}),
	);
	const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key);
	const res = await fetch(key.token_uri, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			assertion: `${header}.${claims}.${b64url(signature)}`,
		}),
	});
	const body = await res.json();
	if (!res.ok) {
		throw new Error(`token: HTTP ${res.status} ${JSON.stringify(body)}`);
	}
	return body.access_token;
}

/** One request, answered with its JSON. */
export async function call(token, method, url, body, contentType = 'application/json') {
	const res = await fetch(url, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			...(body === undefined ? {} : { 'content-type': contentType }),
		},
		body: body === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(body) : body,
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`${method} ${url.replace(/\?.*$/, '')}: HTTP ${res.status} ${text}`);
	}
	return text ? JSON.parse(text) : {};
}

/** Runs fn with an edit of the app pkg open, as { id, url, commit }, where
 *  commit validates the edit and commits it, which sends its changes for
 *  review. After a rejection the API refuses that, and
 *  commit({ notSentForReview: true }) commits with changesNotSentForReview,
 *  which the API takes unvalidated: Publishing overview in Play Console then
 *  sends the changes. An edit fn leaves uncommitted is deleted: an open edit
 *  holds the app's pending changes, and the Console would show it as a
 *  stranger's draft. */
export async function withEdit(token, pkg, fn) {
	const app = `${API}/${encodeURIComponent(pkg)}`;
	const { id } = await call(token, 'POST', `${app}/edits`, {});
	const url = `${app}/edits/${id}`;
	let committed = false;
	const commit = async ({ notSentForReview = false } = {}) => {
		if (!notSentForReview) {
			await call(token, 'POST', `${url}:validate`);
		}
		const done = await call(token, 'POST', `${url}:commit${notSentForReview ? '?changesNotSentForReview=true' : ''}`);
		committed = true;
		return done;
	};
	try {
		return await fn({ id, url, commit });
	} finally {
		if (!committed) {
			await call(token, 'DELETE', url).catch(() => {});
		}
	}
}
