import type { Capabilities, Clock } from "./contracts.ts";

/** Local copy of the host's structural contract; no host checkout is required. */
export interface DriverProvider {
  capabilities: Capabilities;
  version?: string;
  onDisconnect(handler: (error: Error) => void): void;
  close(): void | Promise<void>;
}

export interface DriverCreateOptions {
  port?: number;
  clock: Clock;
}
