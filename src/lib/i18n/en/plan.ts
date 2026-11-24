/* The flight plan as a document (state/planDocument.svelte.ts): saving it,
 * and the question asked before unsaved work is replaced. The plan's words
 * are SkyDemon's, Save / Open / New (docs/i18n-glossary.md, "The flight plan
 * as a document"). */

export const plan = {
	replaceDirty: (plan: string): string => `The plan ${plan} has unsaved changes. Save it first?`,
	replaceNew: (plan: string): string => `The plan ${plan} is not saved yet. Save it first?`,
	saveAndContinue: 'Save and continue',
	discard: 'Discard',
	newPlan: 'New flight plan',
	newPlanTip: 'Start an empty flight plan. The aircraft and your pilot details stay.',
	title: 'Flight plan',
	chipTitle: (plan: string, state: string): string =>
		plan === '' ? `Flight plan. ${state}` : `Flight plan: ${plan}. ${state}`,
	nameTip: 'Name this plan. Left empty, it goes by its route.',
	stateEmpty: 'Plan a route to save it.',
	stateNew: 'Not saved yet. Kept on this device.',
	stateNewShared: 'Not saved yet. It goes when this shared session ends.',
	stateDirty: 'Unsaved changes.',
	stateLossy: 'Opened with waypoints missing: saving replaces the fuller original.',
	stateSaved: (at: string): string => `Saved ${at}.`,
	saveShort: 'Save',
	saveKey: 'Ctrl+S',
	savingPlan: 'Saving the plan…',
	saveFailed: (detail: string): string => `Save failed: ${detail}`,
	downloadFailed: (detail: string): string => `The file could not be made: ${detail}`,
	openFailed: (detail: string): string => `The file could not be read: ${detail}`,
	save: 'Save flight plan',
	saveTip:
		'Save the flight plan in your saved plans (the Flights library, Plans view): over the entry it was opened from, or as a new entry when it was never saved. Greyed when nothing has changed since it was opened or saved.',
	saveAsNew: 'Save as a new plan',
	saveAsNewTip:
		'Add the flight plan to your saved plans as a new entry, named by its aerodromes until you name it',
	openSaved: 'Open a saved plan…',
	openFile: 'Open a file…',
	openFileTip: 'Open a flight plan from a YAML, FPL, GPX, KML or PLN file',
	download: 'Download the plan file (YAML)',
	downloadTip:
		'Download the whole flight plan (routes, flight parameters, preparation) as a YAML file',
	preparingFile: 'Preparing the file…',
	lossyConfirm:
		'This copy lost waypoints when it was opened (the data has changed). Save it anyway, replacing the fuller original?',
	lossyAction: 'Save',
	conflictConfirm:
		'The saved plan changed since you opened it. Replace it with this flight plan?',
	conflictAction: 'Replace',
	savedNotice: 'Flight plan saved.',
	savedAsNotice: 'Saved as a new plan.',
	syncHint: 'Saved plans follow you to your other devices.',
};
