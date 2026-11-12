/* Miroir français de ../en/plan.ts. ENREGISTRER le plan de vol, toujours
 * avec son objet: seul, le mot dit aussi l'enregistrement GPS d'une trace. */

import type { Messages } from '../en';

export const plan = {
	replaceDirty: (plan: string): string =>
		`Le plan ${plan} comporte des modifications non enregistrées. L’enregistrer d’abord\u202f?`,
	replaceNew: (plan: string): string =>
		`Le plan ${plan} n’est pas encore enregistré. L’enregistrer d’abord\u202f?`,
	saveAndContinue: 'Enregistrer et continuer',
	discard: 'Abandonner',
	newPlan: 'Nouveau plan de vol',
	newPlanTip: 'Commencer un plan de vol vide. L’aéronef et vos informations pilote restent.',
	title: 'Plan de vol',
	chipTitle: (plan: string, state: string): string =>
		plan === '' ? `Plan de vol. ${state}` : `Plan de vol\u202f: ${plan}. ${state}`,
	nameTip: 'Nommez ce plan. Laissé vide, il porte le nom de sa route.',
	stateEmpty: 'Tracez une route pour l’enregistrer.',
	stateNew: 'Pas encore enregistré. Conservé sur cet appareil.',
	stateNewShared: 'Pas encore enregistré. Il disparaît à la fin de cette session partagée.',
	stateDirty: 'Modifications non enregistrées.',
	stateLossy:
		'Ouvert avec des points manquants\u202f: l’enregistrer remplace l’original plus complet.',
	stateSaved: (at: string): string => `Enregistré le ${at}.`,
	saveShort: 'Enregistrer',
	saveKey: 'Ctrl+S',
	savingPlan: 'Enregistrement du plan…',
	saveFailed: (detail: string): string => `Échec de l’enregistrement du plan\u202f: ${detail}`,
	downloadFailed: (detail: string): string => `Le fichier n’a pas pu être préparé\u202f: ${detail}`,
	openFailed: (detail: string): string => `Le fichier n’a pas pu être lu\u202f: ${detail}`,
	save: 'Enregistrer le plan de vol',
	saveTip:
		'Enregistre le plan de vol dans vos plans enregistrés (bibliothèque Vols, vue Plans)\u202f: sur l’entrée d’où il a été ouvert, ou comme nouvelle entrée s’il n’a jamais été enregistré. Grisé quand rien n’a changé depuis son ouverture ou son enregistrement.',
	saveAsNew: 'Enregistrer comme nouveau plan',
	saveAsNewTip:
		'Ajoute le plan de vol à vos plans enregistrés comme nouvelle entrée, désignée par ses aérodromes tant que vous ne le nommez pas',
	openSaved: 'Ouvrir un plan enregistré…',
	openFile: 'Ouvrir un fichier…',
	openFileTip: 'Ouvrir un plan de vol depuis un fichier YAML, FPL, GPX, KML ou PLN',
	download: 'Télécharger le fichier du plan (YAML)',
	downloadTip:
		'Télécharger tout le plan de vol (routes, paramètres du vol, préparation) dans un fichier YAML',
	preparingFile: 'Préparation du fichier…',
	lossyConfirm:
		'Cette copie a perdu des points à son ouverture (les données ont changé). L’enregistrer malgré tout, en remplaçant l’original plus complet\u202f?',
	lossyAction: 'Enregistrer',
	conflictConfirm:
		'Le plan enregistré a changé depuis son ouverture. Le remplacer par ce plan de vol\u202f?',
	conflictAction: 'Remplacer',
	savedNotice: 'Plan de vol enregistré.',
	savedAsNotice: 'Enregistré comme nouveau plan.',
	syncHint: 'Les plans enregistrés vous suivent sur vos autres appareils.',
} satisfies Messages['plan'];
