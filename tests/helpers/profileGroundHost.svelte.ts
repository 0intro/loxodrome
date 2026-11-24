/* Hosts for the column profiles' ground read: the detail panel's model over
 * a point that moves, and the map profile's ground keyed the way
 * MapProfileModal keys it, each in its own root so its effects run. */
import { altitudeProfileModel } from '$lib/components/detail/altitudeProfileModel.svelte';
import { useProfileGround } from '$lib/components/profileGround.svelte';
import { mapProfileModal } from '$lib/state/mapProfileModal.svelte';

export interface PanelHost {
	s: { lat: number; lon: number; groundFt: number | null };
	ground: () => number | null;
	stop: () => void;
}

export function mountPanelModel(init: { lat: number; lon: number; groundFt?: number | null }): PanelHost {
	const s = $state({ groundFt: null, ...init });
	let model: ReturnType<typeof altitudeProfileModel> | null = null;
	const stop = $effect.root(() => {
		model = altitudeProfileModel(() => ({
			airspaces: [],
			highlightKey: null,
			overlays: [],
			groundFt: s.groundFt,
			lat: s.lat,
			lon: s.lon,
		}));
	});
	return { s, ground: () => model?.groundFt ?? null, stop };
}

export interface MapHost {
	ground: () => number | null;
	stop: () => void;
}

export function mountMapGround(): MapHost {
	let g: { readonly ft: number | null } | null = null;
	const stop = $effect.root(() => {
		g = useProfileGround(() => {
			const p = mapProfileModal.point;
			return p ? { lat: p.lat, lon: p.lng, key: mapProfileModal.opened } : null;
		});
	});
	return { ground: () => g?.ft ?? null, stop };
}
