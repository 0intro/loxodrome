/* The one text fold of the search, applied to the query and to the data
 * alike, so "Angoulême", "angouleme" and "ANGOULEME" are one word, and the
 * extra spellings a data field is indexed under (docs/search.md "The fold").
 * Pure and locale-free: plain toLowerCase, never a locale's rules. */

// Letters NFKD leaves whole, written the way a keyboard without them types.
const LETTERS: Readonly<Record<string, string>> = {
	ß: 'ss',
	ẞ: 'ss',
	æ: 'ae',
	Æ: 'ae',
	œ: 'oe',
	Œ: 'oe',
	ø: 'o',
	Ø: 'o',
	ł: 'l',
	Ł: 'l',
	đ: 'd',
	Đ: 'd',
	ð: 'd',
	Ð: 'd',
	þ: 'th',
	Þ: 'th',
	ı: 'i',
	ħ: 'h',
	Ħ: 'h',
};
const LETTER_RE = /[ßẞæÆœŒøØłŁđĐðÐþÞıħĦ]/g;

/** Fold to lower-case words of letters and digits: accents and marks off,
 *  every other character a separator, the Catalan middle dot (l·l) part of
 *  its word. */
export function foldWords(s: string): string {
	let t = s;
	// Most dataset strings are plain ASCII: the Unicode passes are for the rest.
	if (!/^[\x20-\x7e]*$/.test(t)) {
		t = t
			.normalize('NFKD')
			.replace(/\p{M}/gu, '')
			.replace(LETTER_RE, (c) => LETTERS[c] ?? c)
			.replace(/·/g, '');
	}
	return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Whole words the datasets write for Saint (FR "ST ETIENNE", DE "Sankt").
const SAINT: Readonly<Record<string, string>> = { st: 'saint', ste: 'sainte', sankt: 'saint' };

/** The fold a data field is indexed under: foldWords, with the abbreviations
 *  of Saint written out. */
export function foldText(s: string): string {
	return foldWords(s)
		.split(' ')
		.map((w) => SAINT[w] ?? w)
		.join(' ');
}

/** A query word and the words it also stands for: a pilot typing "st" means
 *  Saint as often as the first letters of Stuttgart. */
export function wordAlternatives(word: string): readonly string[] {
	const saint = SAINT[word];
	return saint ? [word, saint] : [word];
}

/** Every form a data field is indexed under: its fold, plus the spellings a
 *  pilot may type for it. Apostrophes dropped (L'Isle-Adam: "lisle"),
 *  umlauts written out (Lübeck: "luebeck"), and written-out umlauts
 *  contracted, since DFS writes München as MUENCHEN and a pilot types
 *  "munchen" or "münchen". */
export function foldVariants(s: string): string[] {
	const base = foldText(s);
	const out = base ? [base] : [];
	const add = (v: string): void => {
		if (v && !out.includes(v)) {
			out.push(v);
		}
	};
	if (/['’]/.test(s)) {
		add(foldText(s.replace(/['’]/g, '')));
	}
	if (/[äöüÄÖÜ]/.test(s)) {
		add(foldText(s.replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue')));
	}
	if (/ae|oe|ue/.test(base)) {
		add(base.replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u'));
	}
	return out;
}

/** Fields' forms framed for plain substring tests: each form as "\n form\n",
 *  so every word follows a space (a word prefix is `includes(' ' + w)`) and a
 *  whole form sits between "\n " and "\n". */
export function frame(fields: readonly (string | null | undefined)[]): string {
	let s = '';
	for (const f of fields) {
		if (!f) {
			continue;
		}
		for (const v of foldVariants(f)) {
			s += '\n ' + v + '\n';
		}
	}
	return s;
}
