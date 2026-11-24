/* The data workflows commit what their builds wrote, and a commit gate
 * that misses a file loses it. Five gated on git diff --quiet, which
 * compares the tracked files alone: a run whose only change was a .next
 * pair main never held (a pre-release posted after the run that retired
 * the last one) printed "No data changes." and the pair never shipped.
 * git status --porcelain lists an untracked file too. And data-de built
 * its chart links in the step that builds the AIXM slots, so a failed
 * fetch of the DFS permalinks index threw away that week's refresh.
 * Built in the step of the AIM datasets, data-at's chart links would
 * throw that week's AIM refresh away over one failed page of the
 * Austrian eAIP. cmd/vacgeo exits 1 on a stale overrides.tsv row once
 * it has written the rest of the cycle, and data-aipdocs commits that
 * and the fuel, and uploads the packs, before it fails. */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
	id?: string;
	if?: string;
	run?: string;
	'continue-on-error'?: boolean;
}

interface Workflow {
	jobs: Record<string, { steps?: Step[] }>;
}

const DIR = '.github/workflows';
const DATA = readdirSync(DIR).filter((f) => /^data-.*\.yml$/.test(f));

/** Every step of a workflow's jobs, in file order. */
function steps(file: string): Step[] {
	const w = parse(readFileSync(`${DIR}/${file}`, 'utf8')) as Workflow;
	return Object.values(w.jobs).flatMap((j) => j.steps ?? []);
}

describe('the data workflows', () => {
	it('gate a commit over a glob on git status, which lists untracked files', () => {
		expect(DATA.length).toBeGreaterThan(20);
		const diffGated = DATA.filter((f) =>
			steps(f).some((s) => /git diff --quiet\b.*\*/.test(s.run ?? '')),
		);
		expect(diffGated).toEqual([]);
	});

	it.each(['data-de.yml', 'data-at.yml'])('%s builds its chart links in a step of their own, failing the job at its end', (file) => {
		expectCarriesOnThenFails(file, '-only adcharts');
	});

	it('measures the VAC panels in a step that carries on, failing the job at its end', () => {
		expectCarriesOnThenFails('data-aipdocs.yml', 'go run ./cmd/vacgeo');
	});
});

/** The one step of file whose run holds needle carries on past a failure
 *  ahead of the commit, and a later step fails the job on it. */
function expectCarriesOnThenFails(file: string, needle: string): void {
	const all = steps(file);
	const hits = all.filter((s) => (s.run ?? '').includes(needle));
	expect(hits).toHaveLength(1);
	const [step] = hits;
	expect(step['continue-on-error']).toBe(true);
	expect(step.id).toBeTruthy();
	const commit = all.findIndex((s) => (s.run ?? '').includes('git commit'));
	expect(all.indexOf(step)).toBeLessThan(commit);
	const fail = all
		.slice(commit + 1)
		.find((s) => s.if === `steps.${step.id}.outcome == 'failure'`);
	expect(fail?.run).toContain('exit 1');
}
