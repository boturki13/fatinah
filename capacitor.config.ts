import { CapacitorConfig } from '@capacitor/cli';

const playerTestOrigin = process.env.FATINAH_PLAYER_TEST_ORIGIN?.trim();

const config: CapacitorConfig = {
  appId: 'com.fatinah.game',
  appName: 'فطنة',
  webDir: 'www',
  backgroundColor: '#120B24',
  ...(playerTestOrigin ? {
    server: {
      url: playerTestOrigin,
      cleartext: playerTestOrigin.startsWith('http://')
    }
  } : {}),
  ios: {
    contentInset: 'always',
    backgroundColor: '#120B24',
    scrollEnabled: true,
    limitsNavigationsToAppBoundDomains: false
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 700,
      backgroundColor: '#120B24',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: true
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#120B24',
      overlaysWebView: true
    },
    FirebaseAuthentication: {
      skipNativeAuth: false,
      providers: ['apple.com', 'google.com', 'phone']
    },
    FirebaseMessaging: {
      presentationOptions: ['alert', 'badge', 'sound']
    }
  }
};

export default config;
