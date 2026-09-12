/* TEMSI / WINTEM catalog client (src/lib/sofia/charts.ts) against the
 * live-recorded response shape (2026-07-04; tokens scrubbed): the Sling
 * envelope, the per-entry link -> aviation.meteo.fr URL, the WINTEM
 * per-level extraction from the layer path, and the date parsing. */

import { describe, expect, it } from 'vitest';
import { SOFIA_ZONES, chartsRequestBody, parseSofiaCharts } from '$lib/sofia/charts';

const envelope = (message: unknown): Record<string, unknown> => ({
	'status.message': typeof message === 'string' ? message : JSON.stringify(message),
});

const CATALOG = {
	zones: [
		{
			id: 'FRANCE',
			name: 'FRANCE',
			temsi: [
				{
					type: 'TEMSI',
					level: 'FL20-150',
					zone: 'FRANCE',
					date: '04 07 2026 15:00',
					deadline: '15 UTC',
					link: '/FR/aviation/affiche_image.php?login=TOKEN&layer=sigwx/fr/france&echeance=20260704150000',
				},
				{
					type: 'TEMSI',
					level: 'FL20-150',
					zone: 'FRANCE',
					date: '04 07 2026 12:00',
					deadline: '12 UTC',
					link: '/FR/aviation/affiche_image.php?login=TOKEN&layer=sigwx/fr/france&echeance=20260704120000',
				},
			],
			wintem: [
				{
					type: 'WINTEM',
					level: 'FL20-100',
					zone: 'FRANCE',
					date: '04 07 2026 12:00',
					deadline: '12 UTC',
					link: '/FR/aviation/affiche_image.php?login=TOKEN&layer=wintemp/fr/france/fl100&echeance=20260704120000',
				},
				{
					type: 'WINTEM',
					level: 'FL20-100',
					zone: 'FRANCE',
					date: '04 07 2026 12:00',
					deadline: '12 UTC',
					link: '/FR/aviation/affiche_image.php?login=TOKEN&layer=wintemp/fr/france/fl020&echeance=20260704120000',
				},
			],
		},
	],
};

describe('chartsRequestBody', () => {
	it('builds the Sling catalog operations', () => {
		const temsi = chartsRequestBody('TEMSI', 'FRANCE');
		expect(temsi).toContain('operation=postTemsi');
		expect(temsi).toContain('zone=FRANCE');
		expect(temsi).not.toContain('level=');
		const wintem = chartsRequestBody('WINTEM', 'EUROC');
		expect(wintem).toContain('operation=postWintem');
		expect(wintem).toContain('zone=EUROC');
		expect(wintem).toContain('level=100');
	});
});

describe('parseSofiaCharts', () => {
	it('shapes TEMSI entries, validity-sorted, onto aviation.meteo.fr', () => {
		const charts = parseSofiaCharts(envelope(CATALOG), 'TEMSI');
		expect(charts).toHaveLength(2);
		expect(charts[0].deadline).toBe('12 UTC');
		expect(charts[1].deadline).toBe('15 UTC');
		expect(charts[0].level).toBe('FL20-150');
		expect(charts[0].validAtMs).toBe(Date.UTC(2026, 6, 4, 12, 0));
		expect(charts[0].url).toBe(
			'https://aviation.meteo.fr/FR/aviation/affiche_image.php?login=TOKEN&layer=sigwx/fr/france&echeance=20260704120000',
		);
	});

	it('reads the WINTEM per-chart level from the layer path, level-sorted', () => {
		const charts = parseSofiaCharts(envelope(CATALOG), 'WINTEM');
		expect(charts.map((c) => c.level)).toEqual(['FL020', 'FL100']);
	});

	it('drops link-less entries and tolerates missing groups', () => {
		expect(
			parseSofiaCharts(envelope({ zones: [{ name: 'X', temsi: [{ type: 'TEMSI' }] }] }), 'TEMSI'),
		).toEqual([]);
		expect(parseSofiaCharts(envelope({ zones: [] }), 'WINTEM')).toEqual([]);
	});

	it('surfaces SOFIA plain-text server errors readably', () => {
		expect(() => parseSofiaCharts(envelope('Erreur serveur : indisponible'), 'TEMSI')).toThrow(
			/SOFIA: Erreur serveur/,
		);
	});
});

describe('SOFIA_ZONES', () => {
	it('leads with FRANCE and EUROC and matches the portal vocabulary size', () => {
		expect(SOFIA_ZONES[0]).toBe('FRANCE');
		expect(SOFIA_ZONES[1]).toBe('EUROC');
		expect(SOFIA_ZONES).toHaveLength(28);
		expect(new Set(SOFIA_ZONES).size).toBe(SOFIA_ZONES.length);
	});
});
