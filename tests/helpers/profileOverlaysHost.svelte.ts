/* A host for the profile overlays (components/profileOverlays.svelte.ts):
 * the builder created in an effect root over a fixed source, the way the
 * route modal creates it, so a client spec reads its deriveds. */
import {
	createProfileOverlays,
	type ProfileOverlays,
	type ProfileOverlaySource,
} from '$lib/components/profileOverlays.svelte';

export function mountOverlays(src: ProfileOverlaySource): { overlays: ProfileOverlays; stop: () => void } {
	let overlays: ProfileOverlays | null = null;
	const stop = $effect.root(() => {
		overlays = createProfileOverlays(src);
	});
	if (!overlays) {
		throw new Error('createProfileOverlays ran outside the root');
	}
	return { overlays, stop };
}
