// node src/cli.ts poll [--preview]      collect: users sweep, login feed behind the cursor, GUID pair
// node src/cli.ts report [--md]         reconcile the store against the PSA directory and print the report
import { writeFileSync } from "node:fs";
import { readConfig } from "./config.ts";
import { runPoll } from "./poll.ts";
import { NinjaOneAdapter } from "./rmm/ninjaone.ts";
import { JsonFileDirectory } from "./psa/directory.ts";
import { reconcile, renderMarkdown } from "./reconcile.ts";
import { JsonStore } from "./store/json.ts";

try { process.loadEnvFile(); } catch { /* no .env: the environment is the configuration */ }

async function main() {
  const cmd = process.argv[2] ?? "report";
  const cfg = readConfig();
  const store = new JsonStore(cfg.stateFile);
  const state = store.load();
  if (cmd === "poll") {
    const tokens = { get: () => state.token ?? null, set: (t: { token: string; obtained_at: number }) => { state.token = t; } };
    const rmm = new NinjaOneAdapter(cfg.rmm, tokens);
    const { state: next, summary } = await runPoll(rmm, state, { preview: process.argv.includes("--preview"), pageSize: cfg.pageSize, orgGuidField: cfg.orgGuidField, siteGuidField: cfg.siteGuidField });
    if (summary.written) store.save({ ...next, token: state.token });
    else if (state.token) store.save({ ...state, token: state.token });   // keep the bearer even on a dry run
    process.stdout.write(JSON.stringify({ ...summary, rmm_api_calls: rmm.apiCalls, token_source: rmm.tokenSource }, null, 2) + "\n");
    if (!summary.ok) process.exitCode = 2;
    return;
  }
  if (cmd === "report") {
    const psa = new JsonFileDirectory(cfg.psaDirectoryFile, cfg.psaClientGuidField, cfg.psaSiteGuidField);
    const rep = reconcile({ dim: state.dim, grants: state.grants, devices: state.devices, orgs: state.orgs, locations: state.locations,
      psaClients: await psa.clients(), psaSites: await psa.sites(), psaAccounts: await psa.accounts(), nowIso: new Date().toISOString() });
    const out = process.argv.includes("--md") ? renderMarkdown(rep) : JSON.stringify(rep, null, 2) + "\n";
    const i = process.argv.indexOf("--out");
    if (i > 0 && process.argv[i + 1]) writeFileSync(process.argv[i + 1], out, "utf8"); else process.stdout.write(out);
    return;
  }
  throw new Error(`unknown command '${cmd}' (poll | report)`);
}

main().catch((e) => { process.stderr.write(`${e?.message ?? e}\n`); process.exitCode = 1; });
