/* The one content hash the flights modules share: the workspace's dirty
 * signature (activePlan.svelte.ts) and the plan catalog's content key
 * (flightLinks.svelte.ts) both need a short, stable, dependency-free
 * digest of a string, and each carried its own copy of the same six
 * lines.
 *
 * djb2 (Bernstein), xor variant, in 32 bits. It is a CHANGE DETECTOR, not
 * a checksum and not a security primitive: both callers pair it with
 * something else that narrows a collision (the yaml's length in the
 * catalog key, the reference checks around a store) precisely because 32
 * bits is not much. Base 36 keeps it short enough to sit in a stored
 * record. */

export function djb2(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
	}
	return h.toString(36);
}
