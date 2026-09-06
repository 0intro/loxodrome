import type { CapacitorConfig } from '@capacitor/cli';

// The Capacitor Android app (docs/android.md). The WebView serves the built
// dist/ (BASE_PATH=/, `npm run android:sync`) from the https://localhost
// origin: androidScheme https + hostname localhost are the defaults, kept
// deliberately, and both Cloudflare workers allow-list that exact origin.
const config: CapacitorConfig = {
	appId: 'fr.loxodrome.app',
	appName: 'Loxodrome',
	webDir: 'dist',
};

export default config;
