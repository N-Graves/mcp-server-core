/**
 * Turn a provider's OpenAPI document into an operation catalogue.
 *
 * Build-time only — exported from "@nasdigital/mcp-server-core/generate" so it
 * never ends up in a server's runtime bundle.
 *
 * Each server supplies its own exclusion rules, because "which of these can an
 * ordinary account actually call" is a question only somebody who has read
 * that provider's docs can answer. Everything else — deriving stable ids,
 * pulling out path and query parameters, working out which operations take a
 * body — is identical across providers and belongs here rather than copied
 * into nine repos, which is exactly how the modules this package replaced
 * drifted apart.
 */

export interface SpecOperation {
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  tags: string[];
  summary: string;
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
}

export interface CatalogueEntry extends SpecOperation {
  status: "covered" | "excluded";
  reason?: string;
  tool?: string;
}

export interface ExclusionRule {
  /** Return true to exclude the operation. */
  match: (op: SpecOperation) => boolean;
  /** Why. Required — the coverage check refuses an exclusion without one. */
  reason: string;
  /** Optional label, so the generator can report which rule fired how often. */
  label?: string;
}

const VERBS = new Set(["get", "post", "put", "patch", "delete"]);

/**
 * A stable id for an operation the provider did not name.
 *
 * Not every spec supplies operationId — all eight of Forem's analytics
 * endpoints omit it — so one is derived from the route. It must be stable
 * across regenerations, or every refresh churns the whole catalogue.
 */
function deriveId(method: string, path: string, stripPrefix?: string): string {
  const cleaned = stripPrefix && path.startsWith(stripPrefix) ? path.slice(stripPrefix.length) : path;
  const words = cleaned
    .replace(/[{}]/g, "")
    .split(/[/_.-]/)
    .filter(Boolean)
    .map((s) => s[0]!.toUpperCase() + s.slice(1));
  return method.toLowerCase() + words.join("");
}

export interface BuildOptions {
  /** Dropped from derived ids, e.g. "/api" or "/v5". Cosmetic only. */
  stripPrefix?: string;
  /** Applied in order; the first match wins, so put specific rules first. */
  exclusions?: ExclusionRule[];
  /** Which tool a covered operation is reachable through. */
  toolFor?: (op: SpecOperation) => string;
}

export interface BuildResult {
  operations: CatalogueEntry[];
  covered: number;
  excluded: number;
  /** How many operations each exclusion rule caught. A rule catching zero is
   *  dead code, and a dead rule in a generator is invisible unless reported —
   *  one written as `/api/openapi` never fired because the real route was
   *  `/api/v1/openapi.json`. */
  ruleHits: { label: string; count: number }[];
}

export function buildCatalogue(
  spec: { paths?: Record<string, Record<string, any>> },
  opts: BuildOptions = {},
): BuildResult {
  const exclusions = opts.exclusions ?? [];
  const hits = new Map<string, number>();
  for (const r of exclusions) hits.set(r.label ?? r.reason.slice(0, 60), 0);

  const operations: CatalogueEntry[] = [];

  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    // A path item can carry shared parameters alongside its verbs.
    const shared = Array.isArray(item.parameters) ? item.parameters : [];

    for (const [verb, op] of Object.entries(item)) {
      if (!VERBS.has(verb.toLowerCase())) continue;
      const o = op as Record<string, any>;
      const params = [...shared, ...(Array.isArray(o.parameters) ? o.parameters : [])];

      const entry: SpecOperation = {
        id: o.operationId || deriveId(verb, path, opts.stripPrefix),
        method: verb.toUpperCase() as SpecOperation["method"],
        path,
        tags: Array.isArray(o.tags) ? o.tags : [],
        summary: String(o.summary || o.description || "").split("\n")[0]!.trim(),
        pathParams: params.filter((p: any) => p?.in === "path").map((p: any) => String(p.name)),
        queryParams: params.filter((p: any) => p?.in === "query").map((p: any) => String(p.name)),
        hasBody: Boolean(o.requestBody),
      };

      const rule = exclusions.find((r) => r.match(entry));
      if (rule) {
        const key = rule.label ?? rule.reason.slice(0, 60);
        hits.set(key, (hits.get(key) ?? 0) + 1);
        operations.push({ ...entry, status: "excluded", reason: rule.reason });
      } else {
        operations.push({
          ...entry,
          status: "covered",
          tool: opts.toolFor?.(entry) ?? "call",
        });
      }
    }
  }

  operations.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));

  const covered = operations.filter((o) => o.status === "covered").length;
  return {
    operations,
    covered,
    excluded: operations.length - covered,
    ruleHits: [...hits.entries()].map(([label, count]) => ({ label, count })),
  };
}

/** Render a catalogue as the TypeScript module a server imports. */
export function renderCatalogue(result: BuildResult, header: string): string {
  return `${header}
import type { Operation } from "@nasdigital/mcp-server-core";

export interface CataloguedOperation extends Operation {
  tags: string[];
  summary: string;
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
}

export const OPERATIONS: CataloguedOperation[] = ${JSON.stringify(result.operations, null, 2)};

export const OPERATIONS_BY_ID = new Map(OPERATIONS.map((o) => [o.id, o]));
`;
}

/** Print a summary, and shout about any rule that caught nothing. */
export function reportBuild(result: BuildResult): void {
  console.log(`${result.operations.length} operations`);
  console.log(`  covered:  ${result.covered}`);
  console.log(`  excluded: ${result.excluded}`);
  for (const { label, count } of result.ruleHits) {
    console.log(`    ${String(count).padStart(3)}  ${label}`);
  }
  const dead = result.ruleHits.filter((r) => r.count === 0);
  if (dead.length) {
    console.log(`\n⚠️  ${dead.length} exclusion rule(s) matched nothing and are dead code:`);
    for (const d of dead) console.log(`      ${d.label}`);
    console.log(`    Usually a path that has changed shape. Check it before trusting the counts.`);
  }
}
