/* The NOTAM Viewer's boot (loxodrome.fr/notam).
 *
 * Deliberately shorter than src/main.ts, and the differences are the point:
 * a SWEEP-ONLY shared-session gate (this app has no accounts, so it joins no
 * session, but it reads many of the flight app's keys on the origin the two
 * share, so an ended shared session is swept here too and followed out when
 * another tab ends one), no Capacitor init (it ships only as a web page), and
 * no service worker (see vite.notam.config.ts). What is left is the two
 * document-level input rules, which are the app's and not the flight app's.
 */

import { markNotamViewer } from '$lib/state/appIdentity';
import './app.css';
import { mount } from 'svelte';
import { installNumberStepAnchor } from '$lib/ui/numberStepAnchor';
import { installNumberWheelGuard } from '$lib/ui/numberWheelGuard';
import { resetLayerChoices } from '$lib/state/layers.svelte';
import { sealStorage } from '$lib/state/persist';
import { bootSweepGate } from '$lib/sync/bootSweep';
import { sharedSessionEndedBy } from '$lib/sync/keys';

// First, and before App's module graph evaluates (it is imported dynamically
// below for that reason): the shared state modules that act on the flight
// app's storage at load read it (state/appIdentity.ts).
markNotamViewer();

const target = document.getElementById('app');
if (!target) {
	throw new Error('NOTAM Viewer: missing #app mount point');
}

// Stop a stray mouse wheel from silently stepping a focused number input (the
// level band's two boxes are the ones this app has).
installNumberWheelGuard();

// Step an empty number input from the value its placeholder shows, the
// automatic one in force, rather than from the browser's zero.
installNumberStepAnchor();

// Start from the default layers, whatever the flight app stored on the origin
// the two share: this app persists none and cannot reach them all. Before the
// mount, so no effect ever sees the inherited ones.
resetLayerChoices();

// A shared session another tab ended took its preferences with it, and this
// document still holds them, the NOTAM filters, the level band and the
// display choices this app reads from the flight app's keys: follow it out
// as the flight app's own tabs do (docs/accounts-sync.md, "Other tabs
// follow"). No recording can hold a tab of this app.
window.addEventListener('storage', (e) => {
	if (e.storageArea === localStorage && sharedSessionEndedBy(e)) {
		sealStorage();
		location.replace(location.pathname);
	}
});

// App is imported dynamically so that it loads after the mark above AND
// after the sweep: the state modules read their storage at evaluation, so a
// shared session that ended must be swept before that tree loads, or its
// preferences would already be in memory and painted (docs/accounts-sync.md,
// "The boot sweep"; tests/notamViewerIdentity.spec.ts walks the static
// imports above).
function boot(): void {
	void import('./App.svelte').then(({ default: App }) =>
		mount(App, { target: target as HTMLElement }),
	);
}

const gate = bootSweepGate({ join: false });
if (gate) {
	void gate.then(boot);
} else {
	boot();
}
