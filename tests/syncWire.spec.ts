/* The golden wire fixture replayed against the SIMULATION server: the
 * worker suite replays the same file against the real handler
 * (account-api/test/worker.test.ts), which is what holds the two
 * implementations of the push/changes semantics in step. Neither side
 * may change the fixture unilaterally (docs/accounts-sync.md, Testing;
 * the internal/docpack cross-language pattern). */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PushDoc } from '$lib/sync/model';
import { SimServer } from './helpers/syncSimServer';

interface WireStep {
	name?: string;
	push?: PushDoc[];
	changes?: { since: number; full?: boolean };
	expect: unknown;
}

const fixture = JSON.parse(
	readFileSync(
		fileURLToPath(new URL('../account-api/test/fixtures/wire.json', import.meta.url)),
		'utf8',
	),
) as { steps: WireStep[] };

describe('the golden wire fixture', () => {
	it('replays byte-for-byte against the simulation server', () => {
		const server = new SimServer();
		for (const step of fixture.steps) {
			if (step.push) {
				const results = server.push(step.push);
				expect(JSON.parse(JSON.stringify({ results }))).toEqual(step.expect);
			} else if (step.changes) {
				const out = server.changes(step.changes.since, step.changes.full ?? false);
				expect(JSON.parse(JSON.stringify(out))).toEqual(step.expect);
			}
		}
	});
});
