/* The NOTAM Viewer's boot (loxodrome.fr/notam).
 *
 * Deliberately shorter than src/main.ts, and the differences are the point:
 * no shared-mode boot sweep (this app has no accounts, so there is nothing to
 * sweep and no reason to defer the mount behind a lock query), no Capacitor
 * init (it ships only as a web page), and no service worker (see
 * vite.notam.config.ts). What is left is the two document-level input rules,
 * which are the app's and not the flight app's.
 */

import { markNotamViewer } from '$lib/state/appIdentity';
import './app.css';
import { mount } from 'svelte';
import { installNumberStepAnchor } from '$lib/ui/numberStepAnchor';
import { installNumberWheelGuard } from '$lib/ui/numberWheelGuard';
import { resetLayerChoices } from '$lib/state/layers.svelte';

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

void import('./App.svelte').then(({ default: App }) => mount(App, { target }));
