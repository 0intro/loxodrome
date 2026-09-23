/* The SOFIA briefing is capped on both sides, and the two caps have to stay
 * ordered: the client must outlast the worker, so the worker always answers
 * first and the pilot reads its framed 502 instead of a bare "Failed to
 * fetch". They were once both 30 s, which is exactly the race this locks out.
 *
 * notam-proxy/worker.js is a separate sub-project with no exports, so the
 * constants are read from its source, the paletteSync.spec.ts precedent for
 * a mirror that cannot be imported. Both regexes failing is a test failure by
 * design: this pin exists to be maintained. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string =>
	readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** A `const NAME = 12_345;` or a `name: 12_345,` value, in ms. */
function constMs(source: string, re: RegExp): number {
	const m = re.exec(source);
	expect(m, `no match for ${re}`).not.toBeNull();
	return Number(m![1].replace(/_/g, ''));
}

describe('the SOFIA briefing budgets stay ordered', () => {
	const client = read('src/lib/sofia/fetch.ts');
	const worker = read('notam-proxy/worker.js');

	const clientBriefing = constMs(client, /const BRIEFING_TIMEOUT_MS = ([\d_]+);/);
	const clientSession = constMs(client, /const SESSION_TIMEOUT_MS = ([\d_]+);/);
	const workerSofia = constMs(worker, /\bsofia: ([\d_]+),/);
	const workerSession = constMs(worker, /\bsession: ([\d_]+),/);

	it('gives one briefing POST longer than the worker can spend on it', () => {
		// The worker runs the handshake inline whenever ?session= is missing,
		// so its worst case for one POST is session + sofia, not sofia alone.
		expect(clientBriefing).toBeGreaterThan(workerSession + workerSofia);
	});

	it('gives the session handshake longer than the worker can spend on it', () => {
		expect(clientSession).toBeGreaterThan(workerSession);
	});

	it('leaves a cold PIB room to answer', () => {
		// A cold SOFIA briefing has been measured at 18.6 s; the worker's cap
		// carries roughly twice that, and 30 s was too thin.
		expect(workerSofia).toBeGreaterThanOrEqual(35_000);
	});
});
