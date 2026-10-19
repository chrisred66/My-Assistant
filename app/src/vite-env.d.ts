/// <reference types="vite/client" />

/** The version next to the app's name: this build's ("0.4.2"), or in the dev version the next release's (vite.config.ts). */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Default server address for this build (app/.env.local). */
  readonly VITE_DEFAULT_SERVER_URL?: string;
}
