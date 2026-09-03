import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.encore.music',
  appName: 'Encore',
  webDir: 'dist',
  server: {
    // homelab deployments are frequently plain http; an https webview origin
    // would block those API calls as mixed content
    androidScheme: 'http',
    cleartext: true,
  },
};

export default config;
