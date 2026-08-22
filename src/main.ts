import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { installNumberStepAnchor } from '$lib/ui/numberStepAnchor';
import { installNumberWheelGuard } from '$lib/ui/numberWheelGuard';
import { initNativeApp } from '$lib/native/init';
// Register the service worker (offline cache + new-version prompt). A no-op in
// dev and in the Android shell; in the production build registerSW waits for
// the window load event, so this side-effect import sits with the others
// without delaying first paint.
import '$lib/state/pwa.svelte';

const target = document.getElementById('app');
if (!target) {
	throw new Error('Loxodrome: missing #app mount point');
}

// Stop a stray mouse wheel from silently stepping any focused number input or
// select (it would commit a value the user never typed; see the module).
installNumberWheelGuard();

// Step an empty number input from the value its placeholder shows (the
// automatic one in force) rather than from zero; see the module.
installNumberStepAnchor();

// Capacitor Android shell only (a web no-op): hardware Back + system-bar
// style (docs/android.md).
initNativeApp();

export default mount(App, { target });
