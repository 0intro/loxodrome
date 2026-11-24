/* The committed place names agree with their index (docs/places.md "The
 * files"): the index lists exactly the files committed, each file holds the
 * rows, envelope and fields the index states, every id is its country's and
 * unique across the files, every division is named. */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PlacesIndex } from '$lib/data/places';

const DIR = 'public/data';
const FIELDS = ['id', 'name', 'lat', 'lon', 'pop', 'admin', 'alt'];

interface Doc {
	fields: string[];
	admins: Record<string, string>;
	rows: [string, string, number, number, number | null, string | null, string][];
}

const index = JSON.parse(readFileSync(`${DIR}/places.meta.json`, 'utf8')) as PlacesIndex;
const files = readdirSync(DIR).filter((f) => /^places-[a-z]+\.json$/.test(f));
const isoOf = (f: string): string => f.slice('places-'.length, -'.json'.length);

describe('the committed place names', () => {
	it('are the files the index lists, and no other', () => {
		expect(files.map(isoOf).sort()).toEqual(Object.keys(index.countries).sort());
		const rows = Object.values(index.countries).reduce((n, c) => n + c.rows, 0);
		expect(index.placeCount).toBe(rows);
	});

	it('hold what the index says of each, every id its own country\'s and unique', () => {
		const seen = new Set<string>();
		const wrong: string[] = [];
		for (const f of files) {
			const iso = isoOf(f);
			const doc = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')) as Doc;
			const entry = index.countries[iso];
			if (doc.fields.join() !== FIELDS.join()) {
				wrong.push(`${f}: fields ${doc.fields.join()}`);
			}
			if (doc.rows.length !== entry.rows) {
				wrong.push(`${f}: ${doc.rows.length} rows, the index says ${entry.rows}`);
			}
			const [minLon, minLat, maxLon, maxLat] = entry.bbox ?? [-180, -90, 180, 90];
			for (const [id, name, lat, lon, pop, admin] of doc.rows) {
				if (!id.startsWith(`${iso}:`) || seen.has(id)) {
					wrong.push(`${f}: id ${id}`);
				}
				seen.add(id);
				if (!name.trim()) {
					wrong.push(`${f}: ${id} has no name`);
				}
				if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) {
					wrong.push(`${f}: ${id} at ${lat}, ${lon} outside its file's box`);
				}
				if (pop !== null && !(Number.isInteger(pop) && pop >= 0)) {
					wrong.push(`${f}: ${id} population ${pop}`);
				}
				if (admin !== null && !(admin in doc.admins)) {
					wrong.push(`${f}: ${id} division ${admin} unnamed`);
				}
			}
		}
		expect(wrong.slice(0, 20)).toEqual([]);
		expect(seen.size).toBe(index.placeCount);
	});
});
