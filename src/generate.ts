/**
 * Turn a provider's OpenAPI document into an operation catalogue.
 *
 * Build-time only — exported from "@nasdigitaluk/mcp-server-core/generate" so it
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
  /**
   * OAuth scopes the operation requires, flattened from the spec's `security`
   * block. Empty means public, or that the spec does not say.
   *
   * Worth carrying because it turns an unexplained 403 into an actionable one.
   * Etsy is the clearest case: of its thirteen DELETE endpoints, exactly ONE
   * needs the `listings_d` scope - deleting a whole live listing - and the
   * other twelve ride on scopes you already hold to edit anything at all. Not
   * requesting `listings_d` therefore makes exactly the catastrophic delete
   * impossible while leaving normal work intact, and that is only obvious if
   * the scopes are visible.
   */
  scopes: string[];
}

export interface CatalogueEntry extends SpecOperation {
  status: "covered" | "excluded";
  reason?: string;
  tool?: string;
  /**
   * Consequence, not HTTP verb. read / write / destructive, where destructive
   * means irreversible OR chargeable - see AuthorizationRequest.action. The
   * default derives it from the method, which is right often enough to be a
   * sensible default and wrong often enough that servers should override it:
   * Printify's POST /orders.json places a real, paid order.
   */
  action: "read" | "write" | "destructive";
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
 * Resolve a parameter that may be a `$ref` into components.parameters.
 *
 * This is not an edge case. Printify declares EVERY parameter this way -
 * `{ "$ref": "#/components/parameters/shop_id" }` - and a naive
 * `params.filter(p => p.in === "path")` silently drops all of them, because a
 * $ref object has no `in`. The catalogue then claims those operations take no
 * path parameters, and the first call builds a URL with a literal "{shop_id}"
 * in it.
 *
 * It surfaced because the dispatcher refuses a path it cannot fully resolve
 * and blames the catalogue rather than the caller. Without that guard this
 * would have reached the provider as an opaque 404.
 */
function resolveParam(param: unknown, spec: Record<string, any>): Record<string, any> | undefined {
  if (!param || typeof param !== "object") return undefined;
  const p = param as Record<string, any>;
  if (typeof p.$ref !== "string") return p;

  // Only local refs; a remote one cannot be resolved without fetching, and
  // silently treating it as absent is how this bug happened in the first place.
  const path = p.$ref.replace(/^#\//, "").split("/");
  let node: any = spec;
  for (const segment of path) {
    node = node?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (node === undefined) return undefined;
  }
  // A ref can point at another ref.
  return typeof node?.$ref === "string" ? resolveParam(node, spec) : node;
}

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
  /**
   * Consequence of an operation. Defaults to GET=read, DELETE=destructive,
   * everything else=write — a reasonable guess that is wrong wherever a POST
   * spends money or commits something irreversibly, which is why it is
   * overridable per server.
   */
  actionFor?: (op: SpecOperation) => "read" | "write" | "destructive";
}

const defaultAction = (op: SpecOperation): "read" | "write" | "destructive" =>
  op.method === "GET" ? "read" : op.method === "DELETE" ? "destructive" : "write";

export interface BuildResult {
  operations: CatalogueEntry[];
  covered: number;
  excluded: number;
  /** How many operations each exclusion rule caught. A rule catching zero is
   *  dead code, and a dead rule in a generator is invisible unless reported —
   *  one written as `/api/openapi` never fired because the real route was
   *  `/api/v1/openapi.json`. */
  ruleHits: { label: string; count: number }[];
  /**
   * Routes whose template contains a parameter the spec never declares. Not
   * fatal - the template is used regardless, so the operation still works -
   * but a spec disagreeing with its own routes is worth seeing.
   */
  undeclaredPathParams: string[];
}

export function buildCatalogue(
  spec: { paths?: Record<string, Record<string, any>> },
  opts: BuildOptions = {},
): BuildResult {
  const exclusions = opts.exclusions ?? [];
  const hits = new Map<string, number>();
  for (const r of exclusions) hits.set(r.label ?? r.reason.slice(0, 60), 0);

  const operations: CatalogueEntry[] = [];
  /** Path parameters present in a route template but not declared in the spec. */
  const undeclaredPathParams: string[] = [];

  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    // A path item can carry shared parameters alongside its verbs.
    const shared = Array.isArray(item.parameters) ? item.parameters : [];

    for (const [verb, op] of Object.entries(item)) {
      if (!VERBS.has(verb.toLowerCase())) continue;
      const o = op as Record<string, any>;
      const params = [...shared, ...(Array.isArray(o.parameters) ? o.parameters : [])]
        .map((p) => resolveParam(p, spec as Record<string, any>))
        .filter((p): p is Record<string, any> => Boolean(p));

      const declaredPath = params.filter((p: any) => p?.in === "path").map((p: any) => String(p.name));

      /**
       * The path TEMPLATE is the authority on what the path contains, not the
       * parameter list. A spec can fail to declare a path parameter, or
       * declare it somewhere this code cannot see, and either way an
       * undeclared `{shop_id}` still has to be filled in or the request goes
       * out with a literal brace in the URL.
       *
       * So the two are unioned, and any that only the template knew about are
       * reported - because a spec and its own routes disagreeing is worth
       * seeing rather than silently papering over.
       */
      const templatePath = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
      const undeclared = templatePath.filter((n) => !declaredPath.includes(n));
      if (undeclared.length) {
        for (const n of undeclared) {
          undeclaredPathParams.push(`${verb.toUpperCase()} ${path} → {${n}}`);
        }
      }

      const entry: SpecOperation = {
        id: o.operationId || deriveId(verb, path, opts.stripPrefix),
        method: verb.toUpperCase() as SpecOperation["method"],
        path,
        tags: Array.isArray(o.tags) ? o.tags : [],
        summary: String(o.summary || o.description || "").split("\n")[0]!.trim(),
        pathParams: [...new Set([...declaredPath, ...templatePath])],
        queryParams: params.filter((p: any) => p?.in === "query").map((p: any) => String(p.name)),
        hasBody: Boolean(o.requestBody),
        scopes: [
          ...new Set(
            (Array.isArray(o.security) ? o.security : [])
              .flatMap((s: any) => Object.values(s ?? {}))
              .flat()
              .filter((s: unknown): s is string => typeof s === "string"),
          ),
        ],
      };

      const rule = exclusions.find((r) => r.match(entry));
      if (rule) {
        const key = rule.label ?? rule.reason.slice(0, 60);
        hits.set(key, (hits.get(key) ?? 0) + 1);
        operations.push({
          ...entry,
          status: "excluded",
          reason: rule.reason,
          action: (opts.actionFor ?? defaultAction)(entry),
        });
      } else {
        operations.push({
          ...entry,
          status: "covered",
          tool: opts.toolFor?.(entry) ?? "call",
          action: (opts.actionFor ?? defaultAction)(entry),
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
    undeclaredPathParams,
  };
}

/** Render a catalogue as the TypeScript module a server imports. */
export function renderCatalogue(result: BuildResult, header: string): string {
  return `${header}
import type { Operation } from "@nasdigitaluk/mcp-server-core";

export interface CataloguedOperation extends Operation {
  tags: string[];
  summary: string;
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
  /** Consequence, not HTTP verb: destructive means irreversible OR chargeable. */
  action: "read" | "write" | "destructive";
  /** OAuth scopes required. Empty means public, or unstated by the spec. */
  scopes: string[];
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

  if (result.undeclaredPathParams.length) {
    const n = result.undeclaredPathParams.length;
    console.log(`\nℹ️  ${n} path parameter(s) appear in a route but are not declared in the spec:`);
    for (const u of result.undeclaredPathParams.slice(0, 8)) console.log(`      ${u}`);
    if (n > 8) console.log(`      ...and ${n - 8} more`);
    console.log(`    Taken from the route template, so they work - but the spec is inconsistent.`);
  }
}
