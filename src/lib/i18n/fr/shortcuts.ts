/* Miroir français de ../en/shortcuts.ts. Les intitulés de touches suivent le
 * clavier français (Échap, Suppr, Maj, Entrée, Début, Fin) et les gestes le
 * vocabulaire français du pointeur (Molette, Glisser, Clic milieu); les
 * flèches et les chords Ctrl restent des glyphes invariants. */

import type { Messages } from '../en';

export const shortcuts = {
	title: 'Raccourcis et gestes',
	groups: [
		{
			title: 'Partout',
			rows: [
				{ keys: ['?'], text: 'Ouvrir ou fermer cette liste' },
				{ keys: ['Ctrl+K'], text: 'Ouvrir ou fermer la recherche' },
				{ keys: ['Échap'], text: 'Fermer le menu, la boîte de dialogue ou la surface au premier plan' },
				{ keys: ['Ctrl+Z'], text: 'Annuler une modification de route' },
				{ keys: ['Ctrl+Maj+Z', 'Ctrl+Y'], text: 'Rétablir une modification de route' },
				{ keys: ['Suppr'], text: 'Supprimer le point de cheminement sélectionné' },
			],
		},
		{
			title: 'Carte (avec le focus)',
			rows: [
				{ keys: ['←', '↑', '↓', '→'], text: 'Déplacer la carte' },
				{ keys: ['+', '-'], text: 'Zoom avant / arrière' },
			],
		},
		{
			title: 'Panneau de détail',
			rows: [{ keys: ['←', '→'], text: 'NOTAM précédent / suivant de la liste' }],
		},
		{
			title: 'Log de navigation et profil vertical',
			rows: [{ keys: ['←', '→'], text: 'Afficher la route précédente / suivante' }],
		},
		{
			title: 'Profils d’altitude (graphique avec le focus)',
			rows: [
				{ keys: ['↑', '↓'], text: 'Déplacer la fenêtre d’altitude' },
				{ keys: ['PgPréc', 'PgSuiv'], text: 'Déplacer d’une fenêtre entière' },
				{ keys: ['+', '-'], text: 'Zoomer la fenêtre' },
				{ keys: ['Début'], text: 'Ajuster la fenêtre à la pile' },
				{ keys: ['Entrée'], text: 'Ouvrir la colonne ciblée' },
			],
		},
		{
			title: 'Profils verticaux de la route et de la trace (graphique avec le focus)',
			rows: [
				{ keys: ['←', '→'], text: 'Déplacer la fenêtre de distance' },
				{ keys: ['↑', '↓'], text: 'Déplacer la fenêtre d’altitude' },
				{ keys: ['PgPréc', 'PgSuiv'], text: 'Déplacer l’altitude d’une fenêtre entière' },
				{ keys: ['+', '-'], text: 'Zoomer la fenêtre de distance' },
				{ keys: ['Début'], text: 'Ajuster les deux fenêtres' },
			],
		},
		{
			title: 'Profils verticaux de la route et de la trace (pointeur)',
			rows: [
				{ keys: ['Molette'], text: 'Zoomer la fenêtre de distance au curseur' },
				{
					keys: ['Maj+Molette'],
					text: 'Zoomer la fenêtre d’altitude, comme la molette sur l’axe d’altitude',
				},
				{
					keys: ['Molette ←→'],
					text: 'Déplacer la fenêtre de distance (balayage à deux doigts sur pavé tactile)',
				},
				{
					keys: ['Glisser'],
					text: 'Déplacer les deux fenêtres\u202f; sur le profil de trace, déplacer la lecture',
				},
				{ keys: ['Clic milieu'], text: 'Déplacer les deux fenêtres depuis tout le graphique' },
				{ keys: ['Glisser un axe'], text: 'Déplacer cet axe seul' },
				{ keys: ['Deux doigts'], text: 'Pincer pour zoomer, glisser pour déplacer' },
				{ keys: ['Clic droit', 'Appui long'], text: 'Lister les espaces aériens et les NOTAM ici' },
			],
		},
		{
			title: 'Profils d’altitude (pointeur)',
			rows: [
				{ keys: ['Molette'], text: 'Zoomer la fenêtre d’altitude autour du sol' },
				{ keys: ['Glisser', 'Clic milieu'], text: 'Déplacer la fenêtre d’altitude' },
				{ keys: ['Double-clic'], text: 'Ajuster la fenêtre à la pile' },
			],
		},
		{
			title: 'Profil vertical de la route (segment avec le focus)',
			rows: [
				{ keys: ['↑', '↓'], text: 'Ajuster le niveau du segment de 100 ft' },
				{ keys: ['Maj+↑', 'Maj+↓'], text: 'Ajuster le niveau du segment de 500 ft' },
				{ keys: ['Entrée'], text: 'Ouvrir le point, la bande ou l’obstacle ciblé' },
			],
		},
		{
			title: 'Onglet Route (bandeau des routes avec le focus)',
			rows: [
				{ keys: ['←', '→'], text: 'Route précédente / suivante' },
				{ keys: ['Début', 'Fin'], text: 'Première / dernière route' },
			],
		},
		{
			title: 'Bords des panneaux et des volets ancrés (poignée avec le focus)',
			rows: [
				{ keys: ['←', '↑', '↓', '→'], text: 'Redimensionner le panneau, le volet ancré ou la feuille' },
				{ keys: ['Début'], text: 'Rétablir la taille par défaut d’un volet ancré' },
				{ keys: ['Entrée'], text: 'Alterner la feuille mobile\u202f: aperçu, moitié, plein écran' },
			],
		},
	],
} satisfies Messages['shortcuts'];
