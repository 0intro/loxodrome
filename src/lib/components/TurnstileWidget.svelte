<script lang="ts">
	/* The Turnstile widget, rendered lazily: the external script loads
	 * only when the sign-in flow actually opens (the app is otherwise
	 * self-contained; challenges.cloudflare.com is the one scripted
	 * exception and only here). With NO sitekey configured
	 * (TURNSTILE_SITEKEY '', the dev/e2e posture) the widget renders
	 * nothing and answers a placeholder token at once, which the worker's
	 * DEV_CODE bypass accepts and production ignores. */

	import { onMount } from 'svelte';
	import { TURNSTILE_SITEKEY } from '$lib/net/endpoints';

	let { onToken }: { onToken: (token: string) => void } = $props();

	let host = $state<HTMLDivElement | null>(null);

	onMount(() => {
		if (TURNSTILE_SITEKEY === '') {
			onToken('dev');
			return;
		}
		let cancelled = false;
		let widgetId: string | null = null;
		const render = () => {
			if (cancelled || !host || !window.turnstile) {
				return;
			}
			widgetId = window.turnstile.render(host, {
				sitekey: TURNSTILE_SITEKEY,
				theme: 'auto',
				callback: onToken,
				'expired-callback': () => onToken(''),
			});
		};
		if (window.turnstile) {
			render();
		} else {
			const script = document.createElement('script');
			script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
			script.async = true;
			script.onload = render;
			document.head.appendChild(script);
		}
		return () => {
			cancelled = true;
			if (widgetId !== null) {
				window.turnstile?.remove(widgetId);
			}
		};
	});
</script>

{#if TURNSTILE_SITEKEY !== ''}
	<div bind:this={host} class="turnstile"></div>
{/if}

<style>
	.turnstile {
		min-height: 65px;
	}
</style>
