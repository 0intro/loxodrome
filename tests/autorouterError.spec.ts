/* Pins humanErrorDetail ($lib/autorouter/errorDetail.ts): the unwrap of an
 * autorouter / proxy error body into its human-readable message. The token
 * endpoint's RFC 6749 section 5.2 shape is documented on the autorouter wiki
 * (/wiki/api/authentication/); the message-field shape and the proxy's
 * plain-text errors ("origin not allowed", "upstream error: ...") are what
 * the wire actually carries. */

import { describe, it, expect } from 'vitest';
import { humanErrorDetail } from '$lib/autorouter/errorDetail';

describe('humanErrorDetail', () => {
	it('unwraps the documented RFC 6749 token error', () => {
		expect(
			humanErrorDetail(
				'{"error": "invalid_client", "error_description": "The client credentials are invalid"}',
			),
		).toBe('The client credentials are invalid');
	});

	it('prefers error_description over the error code', () => {
		expect(
			humanErrorDetail('{"error_description": "Account disabled", "error": "access_denied"}'),
		).toBe('Account disabled');
	});

	it('unwraps a message field', () => {
		expect(
			humanErrorDetail('{"status": 403, "message": "API access is not enabled for this account"}'),
		).toBe('API access is not enabled for this account');
	});

	it('falls back to the bare error code', () => {
		expect(humanErrorDetail('{"error": "access_denied"}')).toBe('access_denied');
	});

	it('skips non-string and empty fields', () => {
		expect(humanErrorDetail('{"error_description": 42, "message": "  ", "error": "slow_down"}')).toBe(
			'slow_down',
		);
	});

	it('passes plain text through trimmed', () => {
		expect(humanErrorDetail('  origin not allowed \n')).toBe('origin not allowed');
		expect(humanErrorDetail('upstream error: fetch failed')).toBe('upstream error: fetch failed');
	});

	it('keeps unusable JSON verbatim', () => {
		expect(humanErrorDetail('{"code": 403}')).toBe('{"code": 403}');
		expect(humanErrorDetail('["a", "b"]')).toBe('["a", "b"]');
		expect(humanErrorDetail('403')).toBe('403');
	});

	it('returns empty for an empty body', () => {
		expect(humanErrorDetail('')).toBe('');
		expect(humanErrorDetail('  \n ')).toBe('');
	});

	it('caps both extracted and raw detail at 240 chars', () => {
		const long = 'x'.repeat(500);
		expect(humanErrorDetail(JSON.stringify({ message: long }))).toBe('x'.repeat(240));
		expect(humanErrorDetail('<html>' + long)).toHaveLength(240);
	});
});
