/* A telephone number as a link a phone dials: the number as a supplement or
 * the AIP prints it ("03 87 15 58 87", "+33 1 34 91 21 64") to its tel: URI
 * (RFC 3966), a French national number taking the +33 prefix in place of its
 * trunk 0. Pure. */

/** The tel: URI of a printed number, or null for one holding no digits. */
export function telHref(printed: string): string | null {
	const digits = printed.replace(/[^\d+]/g, '');
	if (!/\d/.test(digits)) {
		return null;
	}
	if (digits.startsWith('+')) {
		return `tel:${digits}`;
	}
	return digits.startsWith('0') ? `tel:+33${digits.slice(1)}` : `tel:${digits}`;
}
