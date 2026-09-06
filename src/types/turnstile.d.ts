/* Cloudflare Turnstile's explicit-render surface, the two calls the
 * sign-in widget uses (components/TurnstileWidget.svelte injects the
 * script lazily; the ambient global is Turnstile's own). */

interface TurnstileApi {
	render(
		element: HTMLElement,
		options: {
			sitekey: string;
			callback: (token: string) => void;
			'expired-callback'?: () => void;
			theme?: 'auto' | 'light' | 'dark';
		},
	): string;
	remove(widgetId: string): void;
}

interface Window {
	turnstile?: TurnstileApi;
}
