/* Pins the sync document model (docs/accounts-sync.md): the canonical
 * serializers whose bytes the content hashes key on (two devices or two
 * app versions emitting the same data must hash it identically), the
 * authored-fields rule that keeps a DERIVED_V bump from dirtying every
 * outing on every device, the envelope, and the policy table. */
import { describe, expect, it } from 'vitest';
import {
	COLLECTION_POLICY,
	SYNC_COLLECTIONS,
	acstatePayload,
	canonicalJson,
	contentHashInput,
	outingPayload,
	pilotPayload,
	pointsPayload,
	unwrapBlobBytes,
	unwrapInline,
	wrapBlobBytes,
	wrapInline,
} from '$lib/sync/model';
import { outingPointsFingerprint, sha256HexOfText } from '$lib/sync/fingerprint';
import type { OutingMeta } from '$lib/state/flightsDb';
import type { TrackPoint } from '$lib/nav/trace';

describe('canonicalJson', () => {
	it('sorts object keys recursively and independently of construction order', () => {
		expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
			canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
		);
		expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
	});

	it('omits undefined-valued properties and keeps nulls', () => {
		expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
		expect(canonicalJson([1, undefined, null])).toBe('[1,null,null]');
	});

	it('refuses non-finite numbers rather than hashing them apart', () => {
		expect(() => canonicalJson({ a: Number.NaN })).toThrow();
		expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
	});
});

function traceMeta(): OutingMeta {
	return {
		id: 1735689600000,
		savedAtMs: 1735693200000,
		datum: 'msl',
		aircraftKey: 'F-GORQ',
		remarks: '',
		source: 'trace',
		derivedV: 4,
		flights: [{ blockOffMs: 1 } as never],
	};
}

describe('outingPayload', () => {
	it('carries the authored fields of a trace row and NOTHING derived', () => {
		const text = outingPayload(traceMeta());
		const back = JSON.parse(text) as Record<string, unknown>;
		expect(Object.keys(back).sort()).toEqual([
			'aircraftKey',
			'datum',
			'id',
			'remarks',
			'savedAtMs',
			'source',
		]);
		expect(text).not.toContain('derivedV');
		expect(text).not.toContain('flights');
	});

	it('is invariant under re-derivation (the DERIVED_V storm guard)', () => {
		const a = traceMeta();
		const b = { ...traceMeta(), derivedV: 99, flights: [] };
		expect(outingPayload(a)).toBe(outingPayload(b));
	});

	it('keeps a logbook row summary and declared cells as source data', () => {
		const meta: OutingMeta = {
			...traceMeta(),
			source: 'logbook',
			declared: { pic_name: 'SELF' },
		};
		const back = JSON.parse(outingPayload(meta)) as Record<string, unknown>;
		expect(back.flights).toBeDefined();
		expect(back.declared).toEqual({ pic_name: 'SELF' });
	});
});

describe('pointsPayload', () => {
	it('normalizes the two spellings of an unknown optional to omission', () => {
		const withNull: TrackPoint = { lat: 1, lon: 2, altFt: null, timeMs: 3, speedKt: null };
		const withAbsent: TrackPoint = { lat: 1, lon: 2, altFt: null, timeMs: 3 };
		expect(pointsPayload([withNull])).toBe(pointsPayload([withAbsent]));
		// A meaningful null (the device omits altitude) is kept.
		expect(pointsPayload([withAbsent])).toContain('"altFt":null');
	});

	it('keeps stated optionals', () => {
		const p: TrackPoint = { lat: 1, lon: 2, altFt: 300, timeMs: 3, speedKt: 95, trackDeg: 270 };
		const text = pointsPayload([p]);
		expect(text).toContain('"speedKt":95');
		expect(text).toContain('"trackDeg":270');
	});
});

describe('singleton payloads', () => {
	it('acstate sorts the plane keys', () => {
		expect(acstatePayload({ 'F-GORQ': 'avgas', 'F-BRUE': 'avgas' })).toBe(
			acstatePayload({ 'F-BRUE': 'avgas', 'F-GORQ': 'avgas' }),
		);
	});

	it('pilot serializes the three identity fields', () => {
		const text = pilotPayload({ name: 'A', sepValidUntil: null, medicalValidUntil: '2027-01-01' });
		expect(JSON.parse(text)).toEqual({
			medicalValidUntil: '2027-01-01',
			name: 'A',
			sepValidUntil: null,
		});
	});
});

describe('the content-hash input', () => {
	it('covers the blob refs, sorted, so a Continue-extend reads as a change', async () => {
		const a = contentHashInput('p', [
			{ h: 'bb', n: 2 },
			{ h: 'aa', n: 1 },
		]);
		const b = contentHashInput('p', [
			{ h: 'aa', n: 1 },
			{ h: 'bb', n: 2 },
		]);
		expect(a).toBe(b);
		expect(await sha256HexOfText(a)).not.toBe(await sha256HexOfText(contentHashInput('p')));
	});
});

describe('the envelope', () => {
	it('round-trips inline text and refuses an unknown algorithm', () => {
		const env = wrapInline('yaml: 1\n');
		expect(unwrapInline(env)).toBe('yaml: 1\n');
		expect(() => unwrapInline({ alg: 'aes-gcm', iv: 'x', data: 'y' })).toThrow();
	});

	it('round-trips the blob frame and refuses a foreign one', () => {
		const bytes = new Uint8Array([1, 2, 3]);
		expect(Array.from(unwrapBlobBytes(wrapBlobBytes(bytes)))).toEqual([1, 2, 3]);
		expect(() => unwrapBlobBytes(new Uint8Array([9, 9, 9, 9]))).toThrow();
	});
});

describe('the policy table', () => {
	it('pins every collection to its contract policy', () => {
		expect(SYNC_COLLECTIONS).toEqual(['plans', 'outings', 'aircraft', 'acstate', 'pilot']);
		expect(COLLECTION_POLICY).toEqual({
			plans: 'copy',
			outings: 'lww',
			aircraft: 'copy',
			acstate: 'lww',
			pilot: 'lww',
		});
	});
});

describe('the outing fingerprint', () => {
	it('is count plus last instant, the Continue-extend detector', () => {
		expect(outingPointsFingerprint([])).toBe('0:0');
		expect(outingPointsFingerprint([{ timeMs: 5 }, { timeMs: 9 }])).toBe('2:9');
	});
});
