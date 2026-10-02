/* The privacy text held to the code it describes.
 *
 * tests/privacyPage.spec.ts keeps public/privacy.html, the catalogs and the
 * About's order in step; nothing there checks that a sentence is TRUE. This
 * does, for the statements a later change could quietly falsify, reading the
 * mechanism behind each one:
 *
 * - In flight the ground under the aircraft is fetched from the fix itself
 *   (state/poseGround.svelte.ts, which the band's AGL and the airspace alert
 *   read), whatever the map shows. The position paragraph once said the
 *   requests described where you are only while the map followed the
 *   aircraft, and the Play prominent disclosure that the position was not
 *   transmitted, with no word of the tiles.
 * - The purge deletes every document of the account, tombstones included, so
 *   the 90-day deletion record belongs to a plan or a flight deleted inside a
 *   living account; the text once hung it on the account's own deletion.
 * - Erased data outlives the purge in the database's own history at
 *   Cloudflare (D1 Time Travel, which the blob grace is sized to) as well as
 *   in the daily backups; the text once named only the backups.
 * - The account syncs the pilot details, a name and two validity dates, one
 *   of them the medical certificate's; the text once listed plans, flights
 *   and aircraft only.
 * - The Android app declares the permissions the position paragraph names,
 *   "and no others": read off the manifest itself, so a permission added
 *   there (VIBRATE, the WebView's navigator.vibrate) fails until the text
 *   names it. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const asked: string[] = [];

vi.mock('$lib/offline/passiveStore', () => ({
	passiveFetchBlob: (url: string): Promise<Blob | null> => {
		asked.push(url);
		return Promise.resolve(null);
	},
}));

import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';
import { lngLatToTile } from '$lib/map/terrain';
import { ensurePoseGround } from '$lib/state/poseGround.svelte';
import { SYNC_COLLECTIONS } from '$lib/sync/model';
import { BASEMAP_PACKS } from '$lib/offline/basemapPacks';
import { CHART_WORKER } from '$lib/net/endpoints';

const root = new URL('..', import.meta.url).pathname;
const worker = readFileSync(join(root, 'account-api/worker.ts'), 'utf-8');

/** A `const NAME = N * 86_400_000;` of the worker, in days. */
function workerDays(name: string): number {
	const m = new RegExp(`const ${name} = (\\d+) \\* 86_400_000;`).exec(worker);
	expect(m, `${name} moved in account-api/worker.ts`).not.toBeNull();
	return Number(m?.[1]);
}

describe('the privacy text', () => {
	it('says the terrain tiles around the aircraft leave the device in flight', async () => {
		// The mechanism: an aircraft over the Mont Blanc massif, no map at all,
		// and the tile holding the fix is asked for.
		const fix = { lat: 45.8326, lon: 6.8652 };
		ensurePoseGround(fix.lat, fix.lon);
		for (let i = 0; i < 20 && asked.length === 0; i++) {
			await new Promise((r) => setTimeout(r, 0));
		}
		const t = lngLatToTile(fix.lat, fix.lon, 12);
		const tile = `/terrain/12/${Math.floor(t.x)}/${Math.floor(t.y)}`;
		expect(
			asked.some((u) => u.endsWith(tile)),
			'the ground under the fix is no longer fetched from the fix: re-read the text below',
		).toBe(true);

		// The position paragraph: the fix itself is never sent, the tiles are,
		// whatever the map shows.
		expect(en.about.privacyPosition).toContain('terrain tiles under and ahead of the aircraft');
		expect(en.about.privacyPosition).toContain('whatever the map shows');
		expect(fr.about.privacyPosition).toContain('tuiles de relief sous l’aéronef et devant lui');
		expect(fr.about.privacyPosition).toContain('quoi que montre la carte');
		// The terrain request lists the tile under the aircraft.
		expect(en.about.privacyTerrain).toContain('the tile under the aircraft');
		expect(fr.about.privacyTerrain).toContain('la tuile sous l’aéronef');
		// The Play prominent disclosure, shown before the location permission.
		expect(en.navigation.locationDisclosure).toContain('elevation tiles');
		expect(fr.navigation.locationDisclosure).toContain('tuiles d’altitude');
	});

	it('hangs the deletion record on a deleted plan or flight, never on the account', () => {
		// The purge deletes the account's documents whole, tombstones included.
		expect(worker).toMatch(/DELETE FROM docs WHERE user_id = \?1/);
		const days = workerDays('TOMBSTONE_KEEP_MS');
		expect(en.about.privacyAccount).toContain(
			`A plan or a flight you delete leaves a deletion record, kept up to ${days} days`,
		);
		expect(fr.about.privacyAccount).toContain(
			`Un plan ou un vol que vous supprimez laisse une trace de suppression, conservée jusqu’à ${days} jours`,
		);
	});

	it('names the pilot details among what the account syncs', () => {
		expect(SYNC_COLLECTIONS).toContain('pilot');
		expect(en.about.privacyAccount).toContain(
			'pilot details (a name and the validity dates of your SEP rating and medical certificate)',
		);
		expect(fr.about.privacyAccount).toContain(
			'informations pilote (un nom et les dates de validité de votre qualification SEP et de votre certificat médical)',
		);
	});

	it('names every permission the Android manifest declares, and claims no other', () => {
		const manifest = readFileSync(join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf-8');
		const declared = [...manifest.matchAll(/<uses-permission\s+android:name="android\.permission\.([A-Z_]+)"/g)].map(
			(m) => m[1],
		);
		expect(declared.length, 'no permission read off the manifest').toBeGreaterThan(0);
		// How each is named in the position paragraph, in both languages.
		const named: Record<string, [string, string]> = {
			INTERNET: ['internet', 'internet'],
			ACCESS_COARSE_LOCATION: ['location', 'localisation'],
			ACCESS_FINE_LOCATION: ['location', 'localisation'],
			FOREGROUND_SERVICE: ['foreground-service', 'service de premier plan'],
			FOREGROUND_SERVICE_LOCATION: ['foreground-service', 'service de premier plan'],
			POST_NOTIFICATIONS: ['notification', 'notification'],
			WAKE_LOCK: ['wake-lock', 'maintien en éveil'],
			VIBRATE: ['vibration', 'vibration'],
		};
		const clauseEn = /declares the ([^.]*) permissions, and no others/.exec(en.about.privacyPosition)?.[1] ?? '';
		const clauseFr = /déclare les autorisations ([^.]*), et aucune autre/.exec(fr.about.privacyPosition)?.[1] ?? '';
		expect(clauseEn, 'the English permission clause moved').not.toBe('');
		expect(clauseFr, 'the French permission clause moved').not.toBe('');
		for (const permission of declared) {
			const words = named[permission];
			expect(words, `${permission}: name it in about.ts privacyPosition, both languages, then here`).toBeDefined();
			expect(clauseEn, permission).toContain(words?.[0]);
			expect(clauseFr, permission).toContain(words?.[1]);
		}
	});

	it('says the base map\'s offline pack comes from the chart server, and survives a reset', () => {
		// The tiles paragraph names one server for the packs; the base-map pack
		// rides it like the charts' (offline/basemapPacks.ts).
		for (const d of BASEMAP_PACKS) {
			expect(d.archive.startsWith(`${CHART_WORKER}/`), d.id).toBe(true);
		}
		expect(en.about.privacyTiles).toContain('offline pack of the Plan IGN base map from the chart server');
		expect(fr.about.privacyTiles).toContain('paquet hors ligne du fond de carte Plan IGN depuis le serveur de cartes');
		expect(en.about.privacyStored).toContain('chart, base-map and document packs');
		expect(fr.about.privacyStored).toContain('paquets de cartes, de fonds de carte et de documents');
	});

	it('names both places erased data lingers', () => {
		// BLOB_GRACE_MS is sized to D1 Time Travel's window, so a restored
		// database still finds its blobs.
		const days = workerDays('BLOB_GRACE_MS');
		expect(en.about.privacyAccount).toContain(`kept ${days} days at Cloudflare`);
		expect(en.about.privacyAccount).toContain('daily backups');
		expect(fr.about.privacyAccount).toContain(`conservé ${days} jours chez Cloudflare`);
		expect(fr.about.privacyAccount).toContain('sauvegardes quotidiennes');
	});
});
