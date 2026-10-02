// The PSA side of the join: which clients and sites exist, carrying the organisation's GUIDs in
// their custom fields, and which accounts the PSA believes should hold access.
//
// The production source collected the RMM half of the pair and stopped there; the PSA half was
// a documented mapping with no adapter yet. This interface is that adapter's shape, and the
// JSON-file implementation lets the whole reconciliation run from an export while a live PSA
// adapter is written against the same interface.
import { readFileSync } from "node:fs";
import type { PsaClient, PsaSite } from "../join.ts";
import type { PsaAccount } from "../reconcile.ts";
import { pickGuid } from "../join.ts";

export interface PsaDirectory {
  clients(): Promise<PsaClient[]>;
  sites(): Promise<PsaSite[]>;
  accounts(): Promise<PsaAccount[]>;
}

/**
 * Expected file shape (any extra keys are ignored; custom_fields may carry anything, only the
 * configured GUID field names are read):
 * {
 *   "clients":  [{ "id": "12", "name": "Client", "custom_fields": { "<clientGuidField>": "…" } }],
 *   "sites":    [{ "id": "40", "client_id": "12", "name": "HQ", "custom_fields": { "<siteGuidField>": "…" } }],
 *   "accounts": [{ "client_id": "12", "site_id": "40", "email": "a@b", "name": "A B", "active": true, "privileged": true }]
 * }
 */
export class JsonFileDirectory implements PsaDirectory {
  private readonly path: string;
  private readonly clientGuidField: string;
  private readonly siteGuidField: string;
  constructor(path: string, clientGuidField: string, siteGuidField: string) {
    this.path = path; this.clientGuidField = clientGuidField; this.siteGuidField = siteGuidField;
  }
  private read(): any { return JSON.parse(readFileSync(this.path, "utf8")); }
  async clients(): Promise<PsaClient[]> {
    return (this.read().clients ?? []).map((c: any) => ({ client_id: String(c.id), name: String(c.name ?? ""), client_guid: pickGuid(c.custom_fields, this.clientGuidField) }));
  }
  async sites(): Promise<PsaSite[]> {
    return (this.read().sites ?? []).map((s: any) => ({ client_id: String(s.client_id), site_id: String(s.id), name: String(s.name ?? ""), site_guid: pickGuid(s.custom_fields, this.siteGuidField) }));
  }
  async accounts(): Promise<PsaAccount[]> {
    return (this.read().accounts ?? []).map((a: any) => ({ client_id: String(a.client_id), site_id: a.site_id != null ? String(a.site_id) : null,
      email: a.email ? String(a.email) : null, name: String(a.name ?? ""), active: a.active !== false, privileged: a.privileged === true }));
  }
}
