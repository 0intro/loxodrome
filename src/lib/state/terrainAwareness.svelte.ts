/* The relative-terrain shading's inputs and what it reports back
 * (docs/terrain-awareness.md): the altitude the ground is coloured against,
 * when the shading is withheld and why, and the tiles still missing from the
 * view.
 *
 * The reference is the POSE's height above mean sea level, through the one
 * altitude chokepoint the band's GPS ALT cell reads (poseAltMslFt): the live
 * tip while recording, the playhead in replay. Garmin's terrain functions use
 * the same GPS-derived altitude ("GSL"), never the barometric one, and they
 * withdraw the picture on a degraded fix (the TER N/A annunciation): a
 * position the recorder itself calls degraded carries an altitude that may be
 * hundreds of feet out, which is the whole of a band here. Replay has no
 * live quality, a recorded fix being a recorded fact. */

import { currentPose, nav, poseAltMslFt, positionQuality } from './navRecording.svelte';
import { layers } from './layers.svelte';
import { ui } from './ui.svelte';

export interface TerrainReference {
	/** Feet above mean sea level. */
	altFt: number;
	/** A live recording's tip or a replay's playhead. */
	source: 'live' | 'replay';
}

/** Why a pose is on the map and the shading is not drawn over it. */
export type TerrainWithheld = 'noAltitude' | 'degraded' | 'lost';

export interface TerrainReferenceState {
	ref: TerrainReference | null;
	/** Null when shaded, or when there is no pose at all (nothing to say). */
	withheld: TerrainWithheld | null;
}

/** The reference and, when there is a pose but no shading, the reason.
 *  Reads reactive state; call inside a $derived / $effect. */
export function terrainReferenceState(): TerrainReferenceState {
	const pose = currentPose();
	if (!pose) {
		return { ref: null, withheld: null };
	}
	if (nav.recording) {
		const q = positionQuality();
		if (q !== 'good') {
			return { ref: null, withheld: q };
		}
	}
	const altFt = poseAltMslFt(pose);
	if (altFt == null || !Number.isFinite(altFt)) {
		return { ref: null, withheld: 'noAltitude' };
	}
	return { ref: { altFt, source: nav.recording ? 'live' : 'replay' }, withheld: null };
}

/** The altitude the shading is read against, null when nothing is shaded. */
export function terrainReference(): TerrainReference | null {
	return terrainReferenceState().ref;
}

/** Is the shading on the map now? */
export function terrainShadingActive(): boolean {
	return layers.terrainAwareness && terrainReference() != null;
}

/** What the layer last drew: tiles of the view still loading, tiles whose
 *  load failed (drawn with the no-data dither), and a view zoomed out past
 *  the coarsest terrain level (nothing shaded). Written by the layer's stats
 *  callback, from its own draw (a microtask or a timer) and on its removal,
 *  which MapView's terrain effect runs: that effect reads none of it, so the
 *  write cannot wake it again. Read by the legend. */
export const terrainShade = $state<{ pending: number; failed: number; zoomedOut: boolean }>({
	pending: 0,
	failed: 0,
	zoomedOut: false,
});

/** The layer's stats callback. Writes only on a change. */
export function reportTerrainShade(s: { pending: number; failed: number; zoomedOut: boolean }): void {
	if (terrainShade.pending !== s.pending) {
		terrainShade.pending = s.pending;
	}
	if (terrainShade.failed !== s.failed) {
		terrainShade.failed = s.failed;
	}
	if (terrainShade.zoomedOut !== s.zoomedOut) {
		terrainShade.zoomedOut = s.zoomedOut;
	}
}

/** Decoded terrain tiles the device holds (map/terrain.ts setTerrainTileBudget):
 *  a phone half the desktop's, the radar's own split. Reads reactive state. */
export function terrainTileBudget(): number {
	return ui.isMobile ? 96 : 192;
}
