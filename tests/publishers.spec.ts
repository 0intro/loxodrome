/* The publisher registry ($lib/data/publishers) is what every per-publisher
 * list is derived from, so its invariants are the ones those lists used to
 * keep by hand: every dataset a publisher ships is declared, every declared
 * merged dataset has a place in its merge order, and the NOTAM routing reads
 * each State's own FIRs. */
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	MERGE_ORDER,
	PUBLISHERS,
	PUBLISHER_TABLE,
	firPublisher,
	publishersOf,
	publishes,
	type DatasetKind,
	type Publisher,
} from '../src/lib/data/publishers';

const FILES: Record<string, DatasetKind> = {
	airspaces: 'airspaces',
	airports: 'airports',
	navaids: 'navaids',
	obstacles: 'obstacles',
	'aerodrome-facilities': 'facilities',
	nature: 'nature',
};

describe('publisher registry', () => {
	it('lists every publisher once', () => {
		expect(new Set(PUBLISHERS).size).toBe(PUBLISHERS.length);
	});

	// A dataset committed under a registry publisher's prefix but missing
	// from its row would ship unread: no loader, no About line.
	it('declares every dataset a registry publisher ships', () => {
		const shipped = readdirSync(new URL('../public/data/', import.meta.url));
		const undeclared: string[] = [];
		for (const f of shipped) {
			const m = /^([a-z]+)-(.+?)(?:\.next)?\.json$/.exec(f);
			if (!m || f.endsWith('.meta.json')) {
				continue;
			}
			const [, id, stem] = m;
			const kind = FILES[stem];
			const row = PUBLISHER_TABLE.find((p) => p.id === id);
			if (!kind || !row || row.datasets.length === 0) {
				continue; // not a registry dataset (France, the FAA, chart indexes, SUP AIP)
			}
			if (!publishes(id as Publisher, kind)) {
				undeclared.push(f);
			}
		}
		expect(undeclared, `shipped but not in the registry: ${undeclared.join(', ')}`).toEqual([]);
	});

	// The merge order is a precedence decision written out by hand; a new
	// publisher of a merged kind must be placed in it, exactly once.
	it('places every merged dataset in its merge order', () => {
		for (const [kind, order] of Object.entries(MERGE_ORDER) as [keyof typeof MERGE_ORDER, readonly string[]][]) {
			expect(new Set(order).size, `${kind}: duplicate in the merge order`).toBe(order.length);
			for (const id of publishersOf(kind)) {
				expect(order, `${kind}: ${id} files it but has no place in the merge order`).toContain(id);
			}
			for (const id of order) {
				if (id !== 'fr' && id !== 'faa') {
					expect(publishes(id as Publisher, kind), `${kind}: ${id} is ordered but files none`).toBe(true);
				}
			}
		}
	});

	it('routes a NOTAM by its own FIR', () => {
		expect(firPublisher('LFFF')).toBe('fr');
		expect(firPublisher('TTZP')).toBe(null); // the Antilles: routed by A), not the FIR
		expect(firPublisher('EBBU')).toBe('be');
		expect(firPublisher('ELLX')).toBe('be');
		expect(firPublisher('LZBB')).toBe('sk');
		expect(firPublisher('EISN')).toBe('ie');
		expect(firPublisher('LYBA')).toBe('rs');
		expect(firPublisher('BKPR')).toBe('xk');
		expect(firPublisher('ESAA')).toBe('se');
		expect(firPublisher('EFIN')).toBe('fi');
		expect(firPublisher('BIRD')).toBe('is');
		expect(firPublisher('LECM')).toBe('es');
		expect(firPublisher('LIMM')).toBe(null); // community data, never routed as the Italian AIP
		expect(firPublisher('KZNY')).toBe(null);
	});
});
