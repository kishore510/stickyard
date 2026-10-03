/* Values injected at build time by vite.config.ts (`define`). See src/build/buildInfo.ts. */

/** Root package.json version. */
declare const __APP_VERSION__: string;
/** Short git commit SHA, or "dev". */
declare const __APP_COMMIT__: string;
/** ISO date and time of the build. */
declare const __APP_BUILD_DATE__: string;
/** The packages named in About's credits, with version and licence. */
declare const __APP_CREDITS__: import("./buildInfo").Credit[];
/** Every package bundled into the app. */
declare const __APP_BUNDLED__: import("./buildInfo").Credit[];
