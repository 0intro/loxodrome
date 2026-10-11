/* The SOFIA requests are capped on both sides, and the two caps have to stay
 * ordered: the client must outlast the worker, so the worker always answers
 * first and the pilot reads its framed 502 instead of a bare "Failed to
 * fetch". They were once both 30 s, which is exactly the race this locks out;
 * the TEMSI / WINTEM catalog once gave up at 15 s and lost both charts of a
 * printed dossier while SOFIA itself answered in 0.2 s.
 *
 * loxodrome-proxy/worker.js is a separate sub-project with no exports, so the
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

const worker = read('loxodrome-proxy/worker.js');
const workerSofia = constMs(worker, /\bsofia: ([\d_]+),/);
const workerSession = constMs(worker, /\bsession: ([\d_]+),/);
const clientSession = constMs(read('src/lib/sofia/session.ts'), /const SESSION_TIMEOUT_MS = ([\d_]+);/);

describe('the SOFIA briefing budgets stay ordered', () => {
	const clientBriefing = constMs(read('src/lib/sofia/fetch.ts'), /const BRIEFING_TIMEOUT_MS = ([\d_]+);/);

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

describe('the TEMSI / WINTEM catalog budget stays ordered', () => {
	const clientCatalog = constMs(read('src/lib/sofia/charts.ts'), /const CATALOG_TIMEOUT_MS = ([\d_]+);/);

	it('gives one catalog POST longer than the worker can spend on it', () => {
		// The retry goes without ?session=, so the inline handshake is in play.
		expect(clientCatalog).toBeGreaterThan(workerSession + workerSofia);
	});
});

describe('the chart download budget stays ordered', () => {
	const clientChart = constMs(read('src/lib/weather/tripCharts.ts'), /const CHART_TIMEOUT_MS = ([\d_]+);/);
	const workerChart = constMs(worker, /\bchart: ([\d_]+),/);

	it('gives one chart download longer than the worker can spend on it', () => {
		expect(clientChart).toBeGreaterThan(workerChart);
	});
});
