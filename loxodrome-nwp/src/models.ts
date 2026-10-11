/* The ingested models, as internal/nwp states them (the suite holds this
 * table to the models.json fixture Go writes), and the chains the read API
 * answers each models= value with. */

import type { GridDesc, Level } from './archive.ts';

export type ModelId = 'arome0025' | AromeOmId | 'arpege01' | 'ifs025';
export type AromeOmId = 'aromeomantil' | 'aromeomguyane' | 'aromeomindien' | 'aromeomncaled' | 'aromeompolyn';

export interface Block {
	first: number;
	last: number;
	name: string;
}

export interface ModelSpec {
	id: ModelId;
	name: string;
	producer: string;
	grid: GridDesc;
	levels: readonly number[];
	cycleHours: number;
	/** Last forecast hour of a run starting at this UTC hour. */
	horizon(runHour: number): number;
	blocks(runHour: number): Block[];
	pyramid: Level[];
	cloud: 'native' | 'sundqvist';
	/** Hours after a run's start past which its successor is overdue:
	 *  the published run older than this raises the stale alert. */
	staleHours: number;
	/** Hours after a run's start past which it is published truncated once
	 *  its first 24 hours are built, and an older run still collecting is
	 *  given up behind a newer one served: past the publisher's usual
	 *  landing, so a run on time is published once, whole. */
	truncateAfterHours: number;
	/** Blocks a job takes at most: about 2 GB of source, as AROME's three
	 *  blocks are; twelve for IFS, which ECMWF posts whole at once. */
	jobBlocks: number;
	/** Where the source files are listed (discover.ts). */
	source: 'meteofrance' | 'ecmwf';
	/** Météo-France's store coordinates, as internal/nwp names them: the
	 *  directory under a run, the file stem, the cloud package, the width of
	 *  an hour in a label, and whether a file holds one forecast hour rather
	 *  than a block's hour group. */
	mf?: { dir: string; stem: string; cloudPkg: string; labelWidth: number; hourly: boolean };
}

function blockName(first: number, last: number): string {
	return `b${String(first).padStart(3, '0')}-${String(last).padStart(3, '0')}`;
}

function blocksOf(edges: readonly (readonly [number, number])[]): Block[] {
	return edges.map(([first, last]) => ({ first, last, name: blockName(first, last) }));
}

const MF_LEVELS = [1000, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300] as const;
const IFS_LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300] as const;

/** A model's pyramid, native level first, as internal/nwp's Pyramid lays
 *  it out and refusing what it refuses: each coarse level's points fall on
 *  the map lattice's multiples, and its zoom lies below the finer level's.
 *  The registry is built at import, so a grid it cannot lay out throws there
 *  rather than loop for ever. */
export function pyramid(grid: GridDesc, factors: readonly number[]): Level[] {
	const out: Level[] = [];
	const add = (factor: number, i0: number, j0: number): void => {
		let ni = Math.floor((grid.ni - 1 - i0) / factor) + 1;
		const nj = Math.floor((grid.nj - 1 - j0) / factor) + 1;
		if (grid.wraps && factor > 1) {
			if (grid.ni % factor !== 0) {
				throw new Error(`pyramid: factor ${factor} does not divide the ${grid.ni} columns`);
			}
			ni = grid.ni / factor;
		}
		const tx = Math.ceil(ni / 16);
		const ty = Math.ceil(nj / 16);
		let z = 0;
		while (2 ** z < Math.max(tx, ty)) {
			z++;
		}
		if (out.length > 0) {
			z = Math.min(z, out[out.length - 1].z - 1);
		}
		if (z < 0 || 2 ** z < Math.max(tx, ty)) {
			throw new Error(`pyramid: factor ${factor} needs a zoom the finer levels took`);
		}
		out.push({ z, factor, i0, j0, ni, nj, tx, ty });
	};
	add(1, 0, 0);
	const mod = (a: number, m: number): number => ((a % m) + m) % m;
	for (const f of factors) {
		const step = f * grid.diE6;
		if (f * grid.djE6 !== step) {
			throw new Error(`pyramid: factor ${f} is not square`);
		}
		let i0 = -1;
		for (let i = 0; i < f && i0 < 0; i++) {
			if (mod(grid.westE6 + i * grid.diE6, step) === 0) {
				i0 = i;
			}
		}
		let j0 = -1;
		for (let j = 0; j < f && j0 < 0; j++) {
			if (mod(grid.northE6 - j * grid.djE6, step) === 0) {
				j0 = j;
			}
		}
		if (i0 < 0 || j0 < 0) {
			throw new Error(`pyramid: factor ${f} puts no native point on the lattice`);
		}
		add(f, i0, j0);
	}
	return out;
}

const AROME_GRID: GridDesc = { ni: 1121, nj: 717, northE6: 55_400_000, westE6: -12_000_000, diE6: 25_000, djE6: 25_000, wraps: false };
const ARPEGE_GRID: GridDesc = { ni: 741, nj: 521, northE6: 72_000_000, westE6: -32_000_000, diE6: 100_000, djE6: 100_000, wraps: false };
const IFS_GRID: GridDesc = { ni: 1440, nj: 721, northE6: 90_000_000, westE6: -180_000_000, diE6: 250_000, djE6: 250_000, wraps: true };

/** AROME-OM's ladder within 1000..300 hPa: its files carry 19 levels to
 *  100 hPa, without 750, 650, 550 or 450. */
const OM_LEVELS = [1000, 950, 925, 900, 850, 800, 700, 600, 500, 400, 350, 300] as const;
const OM_EDGES: [number, number][] = [[0, 6], [7, 12], [13, 18], [19, 24], [25, 30], [31, 36], [37, 42], [43, 48]];

function omGrid(ni: number, nj: number, northE6: number, westE6: number): GridDesc {
	return { ni, nj, northE6, westE6, diE6: 25_000, djE6: 25_000, wraps: false };
}

/** One AROME-OM domain, as internal/nwp's aromeOM states it: 0.025° over a
 *  French overseas territory, four runs a day to +48 h, a file per hour.
 *  A run lands 6.5 to 8 hours after its start (the Indian Ocean last), so
 *  it is published truncated only past 10 h, and stale past 18 h (its
 *  successor, six hours on, is published by about 14.3 h). */
function aromeOm(id: AromeOmId, dom: string, grid: GridDesc, factors: readonly number[], jobBlocks: number): ModelSpec {
	return {
		id,
		name: `AROME-OM ${dom}`,
		producer: 'Météo-France',
		grid,
		levels: OM_LEVELS,
		cycleHours: 6,
		horizon: () => 48,
		blocks: () => blocksOf(OM_EDGES),
		pyramid: pyramid(grid, factors),
		cloud: 'native',
		staleHours: 18,
		truncateAfterHours: 10,
		jobBlocks,
		source: 'meteofrance',
		mf: { dir: `arome-om/${dom}/0025`, stem: `arome-om-${dom}__0025`, cloudPkg: 'IP2', labelWidth: 3, hourly: true },
	};
}

/** The five AROME-OM domains. A job takes about 2 GB of source: two
 *  blocks of the Indian Ocean's, four of the Antilles', a whole run of the
 *  three small domains'. A small grid has no zoom left for a 2° level. */
const AROME_OM: Record<AromeOmId, ModelSpec> = {
	aromeomantil: aromeOm('aromeomantil', 'ANTIL', omGrid(945, 529, 22_900_000, -75_300_000), [5, 10, 20, 40, 80], 4),
	aromeomguyane: aromeOm('aromeomguyane', 'GUYANE', omGrid(419, 317, 8_950_000, -56_750_000), [5, 10, 20, 40], 8),
	aromeomindien: aromeOm('aromeomindien', 'INDIEN', omGrid(1395, 899, -3_450_000, 32_750_000), [5, 10, 20, 40, 80], 2),
	aromeomncaled: aromeOm('aromeomncaled', 'NCALED', omGrid(521, 491, -13_750_000, 158_500_000), [5, 10, 20, 40], 8),
	aromeompolyn: aromeOm('aromeompolyn', 'POLYN', omGrid(521, 507, -12_600_000, -157_500_000), [5, 10, 20, 40], 8),
};

const IFS_SHORT: [number, number][] = [
	[0, 12], [15, 24], [27, 36], [39, 48], [51, 60], [63, 72], [75, 84], [87, 96], [99, 108], [111, 120], [123, 132], [135, 144],
];
const IFS_LONG: [number, number][] = [
	[150, 168], [174, 192], [198, 216], [222, 240], [246, 264], [270, 288], [294, 312], [318, 336], [342, 360],
];

export const MODELS: Record<ModelId, ModelSpec> = {
	arome0025: {
		id: 'arome0025',
		name: 'AROME',
		producer: 'Météo-France',
		grid: AROME_GRID,
		levels: MF_LEVELS,
		cycleHours: 3,
		horizon: () => 51,
		blocks: () => blocksOf([[0, 6], [7, 12], [13, 18], [19, 24], [25, 30], [31, 36], [37, 42], [43, 48], [49, 51]]),
		pyramid: pyramid(AROME_GRID, [5, 10, 20, 40, 80]),
		cloud: 'native',
		staleHours: 10,
		truncateAfterHours: 8,
		jobBlocks: 3,
		source: 'meteofrance',
		mf: { dir: 'arome/0025', stem: 'arome__0025', cloudPkg: 'IP2', labelWidth: 2, hourly: false },
	},
	...AROME_OM,
	arpege01: {
		id: 'arpege01',
		name: 'ARPEGE',
		producer: 'Météo-France',
		grid: ARPEGE_GRID,
		levels: MF_LEVELS,
		cycleHours: 6,
		horizon: () => 102,
		blocks: () => blocksOf([[0, 12], [13, 24], [25, 36], [37, 48], [49, 60], [61, 72], [73, 84], [85, 96], [97, 102]]),
		pyramid: pyramid(ARPEGE_GRID, [5, 10, 20, 40]),
		cloud: 'native',
		staleHours: 14,
		truncateAfterHours: 8,
		jobBlocks: 3,
		source: 'meteofrance',
		mf: { dir: 'arpege/01', stem: 'arpege__01', cloudPkg: 'IP3', labelWidth: 3, hourly: false },
	},
	ifs025: {
		id: 'ifs025',
		name: 'IFS',
		producer: 'ECMWF',
		grid: IFS_GRID,
		levels: IFS_LEVELS,
		cycleHours: 6,
		horizon: (h) => (h % 12 === 0 ? 360 : 144),
		blocks: (h) => blocksOf(h % 12 === 0 ? [...IFS_SHORT, ...IFS_LONG] : IFS_SHORT),
		pyramid: pyramid(IFS_GRID, [2, 4, 8, 16]),
		cloud: 'sundqvist',
		staleHours: 18,
		truncateAfterHours: 8,
		jobBlocks: 12,
		source: 'ecmwf',
	},
};

export const MODEL_IDS = Object.keys(MODELS) as ModelId[];

/** The models= values the read API answers, each a chain of members tried
 *  in order per point and hour. AROME-OM rides Auto alone: in the
 *  Météo-France pick an overseas point would read nulls past +48 h, where
 *  that pick, served by Open-Meteo's ARPEGE World there, reaches 102 h. */
export const CHAINS: Record<string, readonly ModelId[]> = {
	auto_chain: ['arome0025', 'aromeomantil', 'aromeomguyane', 'aromeomindien', 'aromeomncaled', 'aromeompolyn', 'arpege01', 'ifs025'],
	meteofrance_seamless: ['arome0025', 'arpege01'],
	arome_france: ['arome0025'],
	arpege_europe: ['arpege01'],
	ecmwf_ifs025: ['ifs025'],
};

/** A block's Météo-France file labels: its hour group's (00H06H,
 *  000H012H), or one per hour (007H) for a model publishing a file per
 *  hour. */
export function mfLabels(spec: ModelSpec, b: Block): string[] {
	const w = spec.mf?.labelWidth ?? 2;
	const hour = (h: number): string => `${String(h).padStart(w, '0')}H`;
	if (spec.mf?.hourly) {
		return Array.from({ length: b.last - b.first + 1 }, (_, k) => hour(b.first + k));
	}
	return [`${hour(b.first)}${hour(b.last)}`];
}
