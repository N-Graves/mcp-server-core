/**
 * Machine-checkable API coverage.
 *
 * The claim "this server covers the whole API" is worth nothing if it is only
 * a sentence in a README, because a provider adds an endpoint and the sentence
 * silently becomes false. So each server declares a catalogue of the
 * provider's operations, and a test compares that catalogue against the
 * provider's own published surface.
 *
 * Two things fail the test, and the second matters more:
 *
 *  - an operation the provider has that the catalogue does not mention, which
 *    means the provider moved and nobody noticed;
 *  - an operation marked excluded with no reason given, because "we do not
 *    support this" without a why is how a gap becomes permanent.
 *
 * Where completeness is genuinely unachievable - an API that is partner-gated,
 * tier-gated, or effectively unbounded - the honest answer is a catalogue full
 * of `excluded` entries with sourced reasons, not a quietly smaller claim.
 */

export type OperationStatus = "covered" | "excluded";

export interface Operation {
  /** Stable id. The provider's operationId where it publishes one. */
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Template path as the provider documents it, e.g. /articles/{id}. */
  path: string;
  /** Which tool exposes it. Required when covered. */
  tool?: string;
  status: OperationStatus;
  /** Required when excluded. Say why, and cite something. */
  reason?: string;
}

export interface CoverageReport {
  total: number;
  covered: number;
  excluded: number;
  /** In the provider's surface, absent from the catalogue. */
  missing: string[];
  /** In the catalogue, absent from the provider's surface. Usually a removal. */
  stale: string[];
  /** Excluded with no reason, or covered with no tool. */
  malformed: string[];
  ok: boolean;
}

const key = (op: { method: string; path: string }) =>
  `${op.method.toUpperCase()} ${op.path.replace(/\{[^}]+\}/g, "{}")}`;

/**
 * Compare a catalogue against the provider's operations.
 *
 * `providerOps` normally comes from the provider's own OpenAPI document,
 * vendored into the repo so the test does not need the network and so a change
 * upstream shows up as a diff in a pull request rather than a surprise.
 */
export function checkCoverage(
  catalogue: readonly Operation[],
  providerOps: readonly { method: string; path: string }[],
): CoverageReport {
  const cat = new Map(catalogue.map((o) => [key(o), o]));
  const provider = new Set(providerOps.map(key));

  const missing = [...provider].filter((k) => !cat.has(k)).sort();
  const stale = [...cat.keys()].filter((k) => !provider.has(k)).sort();

  const malformed = catalogue
    .filter((o) =>
      (o.status === "excluded" && !o.reason?.trim()) ||
      (o.status === "covered" && !o.tool?.trim()),
    )
    .map((o) => `${key(o)} (${o.status === "excluded" ? "no reason given" : "no tool named"})`)
    .sort();

  const covered = catalogue.filter((o) => o.status === "covered").length;

  return {
    total: catalogue.length,
    covered,
    excluded: catalogue.length - covered,
    missing,
    stale,
    malformed,
    ok: missing.length === 0 && stale.length === 0 && malformed.length === 0,
  };
}

/** Human-readable summary, for a test failure message or a README table. */
export function formatCoverage(report: CoverageReport): string {
  const lines = [
    `${report.covered} of ${report.total} operations covered` +
      (report.excluded ? `, ${report.excluded} excluded with reasons` : ""),
  ];
  if (report.missing.length) {
    lines.push(`\nIn the provider's API but not in the catalogue (${report.missing.length}):`);
    lines.push(...report.missing.map((m) => `  + ${m}`));
  }
  if (report.stale.length) {
    lines.push(`\nIn the catalogue but no longer in the provider's API (${report.stale.length}):`);
    lines.push(...report.stale.map((m) => `  - ${m}`));
  }
  if (report.malformed.length) {
    lines.push(`\nCatalogue entries that need attention (${report.malformed.length}):`);
    lines.push(...report.malformed.map((m) => `  ! ${m}`));
  }
  return lines.join("\n");
}

/** Pull { method, path } pairs out of an OpenAPI 3 document. */
export function operationsFromOpenApi(doc: {
  paths?: Record<string, Record<string, unknown>>;
}): { method: string; path: string }[] {
  const verbs = new Set(["get", "post", "put", "patch", "delete"]);
  const out: { method: string; path: string }[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const verb of Object.keys(item ?? {})) {
      if (verbs.has(verb.toLowerCase())) {
        out.push({ method: verb.toUpperCase(), path });
      }
    }
  }
  return out;
}
