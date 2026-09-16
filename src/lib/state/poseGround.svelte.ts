/* The ground under the aircraft: ONE sample, refreshed by movement, read by
 * the airspace-alert engine (its AGL judgement) and the in-flight band (the
 * GPS ALT cell's AGL reading), so the two never disagree about the height
 * the pilot is at. Lifted out of airspaceAlert.svelte.ts unchanged in its
 * rules: a sample is refreshed once the aircraft moved GROUND_REFRESH_M from
 * it and answers for a position within GROUND_VALID_M of it; one fetch in
 * flight at a time, never queued (the cursorElevation rate doctrine).
 *
 * The mosaic answers synchronously for a tile it already holds
 * (peekElevationFtAt), so the fetch is the exception rather than the rule
 * along a flight: the trace stays in the tiles the map is drawing. The
 * synchronous answer is still committed asynchronously (a microtask): the
 * ensure runs from the alert evaluation, which is a derived, and a derived
 * may not write state.
 *
 * Reactivity: `ground.sample` is written only from settles, never inside the
 * caller's own run, so a $derived / $effect calling ensurePoseGround tracks
 * the sample without the effect-writes-subscribe footgun. */

import { elevationFtAt, peekElevationFtAt } from '$lib/map/terrain';
import { equirectangularDistanceM } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';

/** Refresh the ground sample once the aircraft moved this far. */
export const GROUND_REFRESH_M = NM_TO_METERS;
/** A sample farther than this from the pose no longer answers for it. */
export const GROUND_VALID_M = 2 * NM_TO_METERS;

export interface GroundSample {
	readonly lat: number;
	readonly lon: number;
	/** Feet; null where the source states no data. */
	readonly ft: number | null;
}

const ground = $state<{ sample: GroundSample | null }>({ sample: null });
let pending = false;

/** Keep the sample fresh for the position. Cheap when the aircraft has not
 *  moved a mile; safe to call per fix from a derived or an effect. */
export function ensurePoseGround(lat: number, lon: number): void {
	if (pending) {
		return;
	}
	const s = ground.sample;
	if (s && equirectangularDistanceM(lat, lon, s.lat, s.lon) < GROUND_REFRESH_M) {
		return;
	}
	pending = true;
	const peek = peekElevationFtAt(lat, lon);
	if (peek !== undefined) {
		queueMicrotask(() => {
			ground.sample = { lat, lon, ft: peek };
			pending = false;
		});
		return;
	}
	elevationFtAt(lat, lon)
		.then((ft) => {
			ground.sample = { lat, lon, ft };
		})
		.catch(() => {
			ground.sample = { lat, lon, ft: null };
		})
		.finally(() => {
			pending = false;
		});
}

/** The ground a position can be read against: the sample while it lies
 *  within GROUND_VALID_M of (lat, lon), else null (not sampled yet, or the
 *  aircraft has left it behind). A non-null answer whose `ft` is null means
 *  the terrain source has no data there: known, and empty. The SAMPLE
 *  object itself, stable until the next one lands, so a caller may key a
 *  memo on its identity (the alert engine does). */
export function poseGround(lat: number, lon: number): GroundSample | null {
	const s = ground.sample;
	if (!s || equirectangularDistanceM(lat, lon, s.lat, s.lon) > GROUND_VALID_M) {
		return null;
	}
	return s;
}

/** The ground elevation (ft) under the position, null when unknown. */
export function poseGroundFt(lat: number, lon: number): number | null {
	return poseGround(lat, lon)?.ft ?? null;
}

/** Tests only: forget the sample and any fetch in flight. */
export function resetPoseGround(): void {
	ground.sample = null;
	pending = false;
}
