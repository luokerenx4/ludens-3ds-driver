import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createAzaharProvider } from "./provider.ts";
import type { DriverCreateOptions, DriverProvider } from "./registration.ts";

export { createAzaharProvider };
export type { DriverCreateOptions, DriverProvider };

// Resolve at discovery time so launchd receives the invoking user's app selection.
const cache = resolve(process.env.RSA_AZAHAR_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ludens/azahar/2126.2-rsa.3"));
const build = resolve(process.env.RSA_AZAHAR_BUILD ?? join(cache, "build"));
const app = resolve(process.env.RSA_AZAHAR_APP ?? join(build, "bundle/azahar.app"));

const registration = {
  id: "azahar",
  version: "2126.2-rsa.3",
  transport: "bridge" as const,
  defaultPort: 47673,
  needsGame: true,
  launchCommand: [join(app, "Contents/MacOS/azahar")],
  // launchd does not inherit arbitrary variables from the invoking shell.
  launchEnv: { RSA_AZAHAR_APP: app },
  launchHint: "Build the patched Azahar with this package's emulator:build command, or set RSA_AZAHAR_APP to an existing patched .app. Load a game before connecting; see the driver README.",
  load: (options: DriverCreateOptions): Promise<DriverProvider> =>
    createAzaharProvider({ port: options.port ?? 47673, clock: options.clock }),
};

export default registration;
