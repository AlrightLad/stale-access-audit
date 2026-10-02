// A single JSON file as the store. Enough to run the audit on a schedule from any host; swap it
// for a database by implementing the same shape.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { DimRow, Grant, LoginEvent } from "../dormancy.ts";
import type { RmmLocation, RmmOrg } from "../join.ts";
import type { DeviceSite } from "../reconcile.ts";

export type PollState = {
  last_run?: Record<string, unknown> & { at: string };
  last_complete_sweep?: { count: number; at: string };
};

export type State = {
  version: 1;
  dim: DimRow[];
  ledger: LoginEvent[];
  grants: Grant[];
  devices: DeviceSite[];
  orgs: RmmOrg[];
  locations: RmmLocation[];
  poll_state: PollState;
  token?: { token: string; obtained_at: number } | null;
};

export const emptyState = (): State => ({ version: 1, dim: [], ledger: [], grants: [], devices: [], orgs: [], locations: [], poll_state: {}, token: null });

export class JsonStore {
  private readonly path: string;
  constructor(path: string) { this.path = path; }
  load(): State {
    if (!existsSync(this.path)) return emptyState();
    const raw = JSON.parse(readFileSync(this.path, "utf8"));
    return { ...emptyState(), ...raw };
  }
  /** Atomic: write a sibling then rename, so a crash mid-write never leaves a half file. */
  save(s: State): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 1), "utf8");
    renameSync(tmp, this.path);
  }
}
