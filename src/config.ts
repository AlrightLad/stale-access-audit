import type { RmmConfig } from "./rmm/ninjaone.ts";

export type Config = {
  rmm: RmmConfig;
  orgGuidField: string;
  siteGuidField: string;
  psaClientGuidField: string;
  psaSiteGuidField: string;
  psaDirectoryFile: string;
  stateFile: string;
  pageSize: number;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const need = (k: string): string => { const v = env[k]?.trim(); if (!v) throw new Error(`${k} is required and empty`); return v; };
  const opt = (k: string, d: string): string => env[k]?.trim() || d;
  return {
    rmm: {
      baseUrl: need("RMM_BASE_URL"),
      tokenUrl: need("RMM_TOKEN_URL"),
      clientId: need("RMM_CLIENT_ID"),
      clientSecret: need("RMM_CLIENT_SECRET"),
      scope: opt("RMM_SCOPE", "monitoring management"),
      fetchTimeoutMs: Number(opt("RMM_FETCH_TIMEOUT_MS", "120000")),
      tokenMaxAgeMs: Number(opt("RMM_TOKEN_MAX_AGE_MS", String(30 * 60_000))),
    },
    orgGuidField: need("RMM_ORG_GUID_FIELD"),
    siteGuidField: need("RMM_SITE_GUID_FIELD"),
    psaClientGuidField: need("PSA_CLIENT_GUID_FIELD"),
    psaSiteGuidField: need("PSA_SITE_GUID_FIELD"),
    psaDirectoryFile: opt("PSA_DIRECTORY_FILE", "./psa-directory.json"),
    stateFile: opt("STATE_FILE", "./state/stale-access-audit.json"),
    pageSize: Number(opt("PAGE_SIZE", "500")),
  };
}
