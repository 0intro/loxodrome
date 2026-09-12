import { describe, expect, it } from 'vitest';
import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';
import { plural as pluralEn } from '$lib/i18n/en/plural';
import { plural as pluralFr } from '$lib/i18n/fr/plural';

/* Runtime guard behind the compile-time `satisfies` contract: the two
 * catalogs stay structurally identical (svelte-check already fails on a
 * missing key; this spec also catches a key whose KIND diverges after a
 * type widening) and every leaf renders non-empty in both languages. */

type Node = Record<string, unknown>;

interface Leaf {
	path: string;
	en: unknown;
	fr: unknown;
}

function collectLeaves(a: Node, b: Node, path: string, out: Leaf[]): void {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) {
		const pa = a[key];
		const pb = b[key];
		const here = path === '' ? key : `${path}.${key}`;
		expect(key in a, `fr has extra key ${here}`).toBe(true);
		expect(key in b, `fr misses key ${here}`).toBe(true);
		if (
			typeof pa === 'object' &&
			pa !== null &&
			typeof pb === 'object' &&
			pb !== null
		) {
			collectLeaves(pa as Node, pb as Node, here, out);
		} else {
			out.push({ path: here, en: pa, fr: pb });
		}
	}
}

/** A stand-in for any message parameter: interpolates as a number and hands
 *  back another stand-in for any property access or call, so every message
 *  function can be smoke-called without knowing its signature. */
function chameleon(): unknown {
	const target = function () {
		/* callable shell for the proxy */
	};
	const proxy: unknown = new Proxy(target, {
		get(_t, prop) {
			if (prop === Symbol.toPrimitive) {
				return () => 2;
			}
			return proxy;
		},
		apply() {
			return proxy;
		},
	});
	return proxy;
}

describe('i18n catalogs', () => {
	const leaves: Leaf[] = [];
	collectLeaves(en, fr, '', leaves);

	it('has leaves', () => {
		expect(leaves.length).toBeGreaterThan(0);
	});

	it('keeps every leaf the same kind in both languages', () => {
		for (const leaf of leaves) {
			expect(typeof leaf.fr, leaf.path).toBe(typeof leaf.en);
		}
	});

	it('renders every string leaf non-empty', () => {
		for (const leaf of leaves) {
			if (typeof leaf.en === 'string') {
				expect(leaf.en.trim(), `en ${leaf.path}`).not.toBe('');
				expect((leaf.fr as string).trim(), `fr ${leaf.path}`).not.toBe('');
			}
		}
	});

	// weather.wx renders a parsed WeatherGroup (present-weather decode), not
	// string / number message params, so the chameleon stand-in cannot drive
	// it; it is pinned with real inputs in both languages in weather.spec.ts.
	const SMOKE_SKIP = new Set(['weather.wx']);

	it('smoke-calls every message function in both languages', () => {
		const arg = chameleon();
		for (const leaf of leaves) {
			if (SMOKE_SKIP.has(leaf.path)) {
				continue;
			}
			if (typeof leaf.en === 'function') {
				for (const [lang, fn] of [
					['en', leaf.en],
					['fr', leaf.fr],
				] as const) {
					const result: unknown = (
						fn as (...args: unknown[]) => unknown
					)(arg, arg, arg);
					expect(typeof result, `${lang} ${leaf.path}`).toBe('string');
					expect((result as string).trim(), `${lang} ${leaf.path}`).not.toBe('');
				}
			}
		}
	});

	// Belt-and-braces behind fr/qcode.ts's `satisfies Messages['qcode']`: the
	// decode tables carry one entry per ICAO code on both sides, as key SETS.
	it('keeps the Q-code decode tables key-equal across languages', () => {
		expect(new Set(Object.keys(fr.qcode.subjects))).toEqual(
			new Set(Object.keys(en.qcode.subjects)),
		);
		expect(new Set(Object.keys(fr.qcode.conditions))).toEqual(
			new Set(Object.keys(en.qcode.conditions)),
		);
	});

	it('applies each plural rule correctly (0 is singular in French only)', () => {
		expect(pluralEn(0, 'day', 'days')).toBe('days');
		expect(pluralEn(1, 'day', 'days')).toBe('day');
		expect(pluralEn(2, 'day', 'days')).toBe('days');
		expect(pluralFr(0, 'jour', 'jours')).toBe('jour');
		expect(pluralFr(1, 'jour', 'jours')).toBe('jour');
		expect(pluralFr(2, 'jour', 'jours')).toBe('jours');
	});
});
