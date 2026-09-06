/* Miroir français de ../en/conditions.ts. « Niveau » suit la définition
 * générique de l'OACI (Annexe 2: hauteur, altitude ou niveau de vol), et
 * « période » la période de validité des items B) et C) d'un NOTAM. Du / Au
 * suivent la convention SIA; ft, FL et h restent invariants. */

import type { Messages } from '../en';

export const conditions = {
	allLevels: 'Tous niveaux',
	ceiling: 'Plafond',
	ceilingAria: 'Plafond de la bande',
	chipTitle: (p: { axis: string; value: string }) =>
		`${p.axis}\u202f: ${p.value}\nRégler la période et les niveaux de lecture de la carte`,
	custom: 'Personnalisée',
	flight: 'Vol',
	flightNeedsRoute: 'Tracez une route pour utiliser la période du vol.',
	flightNoEtd:
		'Aucune heure de départ définie\u202f; l’heure ronde suivante est utilisée.',
	flightWindow: (window: string) => `Votre vol\u202f: ${window}.`,
	floor: 'Plancher',
	floorAria: 'Plancher de la bande',
	from: 'Du',
	fromDateAria: 'Date de début',
	fromTimeAria: 'Heure de début (00:00 par défaut)',
	horizonAll: 'Tout',
	horizonHours: (h: number) => `${h} h`,
	horizonLegend: 'Anticipation',
	levels: 'Niveaux',
	levelsLegend: 'Niveaux',
	levelsNote:
		'S’applique aux NOTAM (leurs limites F/G, sinon la bande de la ligne Q), aux espaces aériens, aux zones de SUP AIP et aux SIGMET.',
	limitToBand: 'Limiter à une bande de niveaux',
	next: (h: number) => `${h} h à venir`,
	now: 'Maintenant',
	nowNote:
		'La carte montre ce qui est en vigueur maintenant et ce qui vient dans la période d’anticipation.',
	period: 'Période',
	periodInvalid: 'Période non définie',
	periodLegend: 'Période (UTC)',
	title: 'Période et niveaux',
	to: 'Au',
	toDateAria: 'Date de fin',
	toTimeAria: 'Heure de fin (00:00 par défaut)',
} satisfies Messages['conditions'];
