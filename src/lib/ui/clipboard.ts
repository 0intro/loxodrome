/* Clipboard write with a synchronous execCommand fallback for browsers that
 * block navigator.clipboard when the page isn't focused. Returns whether the
 * text was copied. */

let warned = false;

export async function copyText(text: string): Promise<boolean> {
	if (!text) {
		return false;
	}
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch (err) {
		if (!warned) {
			console.warn('Clipboard write failed; falling back to execCommand', err);
			warned = true;
		}
		// execCommand is deprecated but synchronous and still widely supported,
		// so it works without an async permissions check.
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.style.position = 'fixed';
		ta.style.opacity = '0';
		document.body.appendChild(ta);
		ta.select();
		try {
			const ok = document.execCommand('copy');
			document.body.removeChild(ta);
			return ok;
		} catch {
			document.body.removeChild(ta);
			return false;
		}
	}
}
