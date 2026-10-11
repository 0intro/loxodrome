/* Test helpers: an in-memory R2 bucket (optionally seeded from a fixture
 * directory), the fixture models of internal/nwp's TestChainFixture, and the
 * synthetic values it wrote, mirrored. */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pyramid, type ModelSpec } from '../src/models.ts';
import type { Receipt } from '../src/plan.ts';

export const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

interface Stored {
	data: Uint8Array;
	contentType?: string | undefined;
}

/** The R2 bucket surface the Worker uses, over a Map. */
export class FakeBucket {
	readonly objects = new Map<string, Stored>();
	readonly uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
	gets = 0;

	static fromDir(dir: string): FakeBucket {
		const b = new FakeBucket();
		const walk = (d: string): void => {
			for (const name of readdirSync(d)) {
				const p = join(d, name);
				if (statSync(p).isDirectory()) {
					walk(p);
				} else if (name.endsWith('.pmtiles')) {
					b.objects.set(relative(dir, p), { data: new Uint8Array(readFileSync(p)) });
				}
			}
		};
		walk(dir);
		return b;
	}

	private body(data: Uint8Array): R2ObjectBody {
		return {
			arrayBuffer: () => Promise.resolve(data.slice().buffer),
			json: () => Promise.resolve(JSON.parse(new TextDecoder().decode(data)) as unknown),
			text: () => Promise.resolve(new TextDecoder().decode(data)),
			body: new Blob([data.slice()]).stream(),
			size: data.length,
		} as unknown as R2ObjectBody;
	}

	get(key: string, opts?: { range?: { offset: number; length: number } }): Promise<R2ObjectBody | null> {
		this.gets++;
		const o = this.objects.get(key);
		if (!o) {
			return Promise.resolve(null);
		}
		if (opts?.range) {
			const { offset, length } = opts.range;
			if (offset >= o.data.length) {
				return Promise.reject(new Error('range not satisfiable'));
			}
			return Promise.resolve(this.body(o.data.subarray(offset, Math.min(o.data.length, offset + length))));
		}
		return Promise.resolve(this.body(o.data));
	}

	async put(key: string, value: unknown, opts?: { httpMetadata?: { contentType?: string } }): Promise<void> {
		this.objects.set(key, { data: await toBytes(value), contentType: opts?.httpMetadata?.contentType });
	}

	delete(keys: string | string[]): Promise<void> {
		for (const k of Array.isArray(keys) ? keys : [keys]) {
			this.objects.delete(k);
		}
		return Promise.resolve();
	}

	createMultipartUpload(key: string): Promise<{ uploadId: string }> {
		const uploadId = `u${this.uploads.size + 1}`;
		this.uploads.set(uploadId, { key, parts: new Map() });
		return Promise.resolve({ uploadId });
	}

	resumeMultipartUpload(key: string, uploadId: string) {
		const up = this.uploads.get(uploadId);
		if (!up || up.key !== key) {
			throw new Error('no such upload');
		}
		return {
			uploadPart: async (n: number, value: unknown) => {
				up.parts.set(n, await toBytes(value));
				return { partNumber: n, etag: `e${n}` };
			},
			complete: (parts: { partNumber: number; etag: string }[]): Promise<void> => {
				const chunks = parts.map((p) => {
					const c = up.parts.get(p.partNumber);
					if (!c || p.etag !== `e${p.partNumber}`) {
						throw new Error('bad part');
					}
					return c;
				});
				const total = chunks.reduce((n, c) => n + c.length, 0);
				const data = new Uint8Array(total);
				let off = 0;
				for (const c of chunks) {
					data.set(c, off);
					off += c.length;
				}
				this.objects.set(key, { data });
				this.uploads.delete(uploadId);
				return Promise.resolve();
			},
			abort: (): Promise<void> => {
				this.uploads.delete(uploadId);
				return Promise.resolve();
			},
		};
	}

	asR2(): R2Bucket {
		return this as object as R2Bucket;
	}
}

async function toBytes(value: unknown): Promise<Uint8Array> {
	if (typeof value === 'string') {
		return new TextEncoder().encode(value);
	}
	if (value instanceof Uint8Array) {
		return value;
	}
	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value);
	}
	if (value && typeof (value as ReadableStream).getReader === 'function') {
		return new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());
	}
	throw new Error('unsupported body');
}

export function chainReceipts(): Receipt[] {
	return JSON.parse(readFileSync(join(FIXTURES, 'chain', 'receipts.json'), 'utf8')) as Receipt[];
}

const MINI_GRID = { ni: 37, nj: 23, northE6: 50_050_000, westE6: 1_050_000, diE6: 25_000, djE6: 25_000, wraps: false };
const WIDE_GRID = { ni: 31, nj: 21, northE6: 51_000_000, westE6: 0, diE6: 100_000, djE6: 100_000, wraps: false };

/** The fixture's two models, as the read path's registry states them. */
export const MINI_MODELS: Record<string, ModelSpec> = {
	mini: {
		id: 'mini' as never,
		name: 'mini',
		producer: 'test',
		grid: MINI_GRID,
		levels: [850, 700],
		cycleHours: 3,
		horizon: () => 12,
		blocks: () => [
			{ first: 0, last: 6, name: 'b000-006' },
			{ first: 7, last: 12, name: 'b007-012' },
		],
		pyramid: pyramid(MINI_GRID, [5]),
		cloud: 'native',
		staleHours: 10,
		truncateAfterHours: 8,
		jobBlocks: 3,
		source: 'meteofrance',
	},
	miniwide: {
		id: 'miniwide' as never,
		name: 'miniwide',
		producer: 'test',
		grid: WIDE_GRID,
		levels: [850, 700],
		cycleHours: 6,
		horizon: () => 12,
		blocks: () => [{ first: 0, last: 12, name: 'b000-012' }],
		pyramid: pyramid(WIDE_GRID, [5]),
		cloud: 'sundqvist',
		staleHours: 18,
		truncateAfterHours: 8,
		jobBlocks: 12,
		source: 'ecmwf',
	},
};

export const MINI_CHAINS: Record<string, readonly string[]> = {
	mini_chain: ['mini', 'miniwide'],
	mini_only: ['mini'],
	// The wide model first, the fine one after its 12 h: a chain switching
	// models mid-column.
	wide_first: ['miniwide', 'mini'],
};

/** internal/nwp's miniValue, quantised as the archive stores it. */
export function miniValue(name: string, level: number, i: number, j: number, h: number, shift: number): number {
	const base = i * 0.5 - j * 0.25 + h + shift;
	// The fixture went through float32 and Go's math.Round (half away
	// from zero) on its way into the archive.
	const q = (x: number, scale: number, offset = 0): number => {
		const y = (Math.fround(x) - offset) / scale;
		return Math.sign(y) * Math.round(Math.abs(y)) * scale + offset;
	};
	switch (name) {
		case 'elevation':
			return i * 10 + j;
		case 'pressure_msl':
			return q(1010 + base / 10, 0.1, 1000);
		case 'surface_pressure':
			return q(990 + base / 10, 0.1, 1000);
		case 'temperature':
		case 'temperature_2m':
			return q(5 + base / 4 - level / 100, 0.1);
		case 'geopotential_height':
			return q(12000 - level * 10 + base, 1);
		case 'wind_gusts_10m':
			return q(Math.abs(base) + 2, 0.5);
		case 'cloud_cover':
			return (i + j + h) % 101;
	}
	return q(base * (1 + level / 1000), 0.5);
}

export function hourUnix(iso: string): number {
	return Date.parse(iso) / 1000;
}
