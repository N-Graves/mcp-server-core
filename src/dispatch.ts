/**
 * The generic caller shared by every server in this family.
 *
 * A catalogued API is reached through one tool rather than one tool per
 * operation, because every tool's name and description is paid for in the
 * model's context window on every turn, used or not. Pinterest publishes 266
 * operations; that is not a tool list, it is a catalogue with a lookup.
 *
 * The behaviour that matters is what happens on the unhappy paths:
 *  - an unknown id suggests near matches, because ids are long and mistyped;
 *  - an EXCLUDED id returns the reason it is excluded, rather than a bare
 *    refusal or, worse, a 403 from the provider after the caller has already
 *    committed to it;
 *  - a missing path parameter is named, rather than sending the provider a
 *    literal "{id}" and getting back an opaque 404.
 */

import type { HttpClient } from "./http.js";
import { ToolError } from "./errors.js";
import type { Operation } from "./coverage.js";

export interface DispatchableOperation extends Operation {
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
  summary?: string;
  tags?: string[];
}

export class Dispatcher<T extends DispatchableOperation> {
  readonly covered: T[];
  private readonly byId: Map<string, T>;

  constructor(
    private readonly http: HttpClient,
    readonly operations: T[],
    /** Shown in refusals so the caller knows which tool to use to browse. */
    private readonly listToolName = "list_operations",
  ) {
    this.byId = new Map(operations.map((o) => [o.id, o]));
    this.covered = operations.filter((o) => o.status === "covered");
  }

  resolve(id: string): T {
    const op = this.byId.get(id);
    if (!op) {
      const probe = id.toLowerCase().slice(0, 6);
      const near = this.covered
        .map((o) => o.id)
        .filter((k) => k.toLowerCase().includes(probe))
        .slice(0, 5);
      throw new ToolError(
        `No operation "${id}". ` +
          (near.length ? `Did you mean: ${near.join(", ")}? ` : "") +
          `Call ${this.listToolName} to see all ${this.covered.length}.`,
      );
    }
    if (op.status === "excluded") {
      throw new ToolError(
        `${id} is not available through this server. ${op.reason} ` +
          `It is listed in the catalogue so the omission is visible rather than silent.`,
      );
    }
    return op;
  }

  buildPath(op: T, params: Record<string, unknown>): string {
    let path = op.path;
    for (const name of op.pathParams) {
      const value = params[name];
      if (value === undefined || value === null || `${value}` === "") {
        throw new ToolError(
          `${op.id} needs the path parameter "${name}". Its route is ${op.method} ${op.path}.`,
        );
      }
      path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
    }
    // Braces left behind mean the spec declares a parameter the catalogue did
    // not capture. Refusing beats sending the provider a literal "{id}".
    const unresolved = path.match(/\{([^}]+)\}/);
    if (unresolved) {
      throw new ToolError(
        `${op.id} has an unresolved path parameter "${unresolved[1]}". ` +
          `That is a bug in the operation catalogue, not in your call.`,
      );
    }
    return path;
  }

  async call(id: string, params: Record<string, unknown> = {}, body?: unknown): Promise<unknown> {
    const op = this.resolve(id);
    const path = this.buildPath(op, params);

    // Anything that is not a path parameter becomes a query parameter. Passing
    // an unknown one is harmless; silently dropping one the caller meant is not.
    const query: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(params)) {
      if (op.pathParams.includes(k)) continue;
      if (v === undefined || v === null || v === "") continue;
      query[k] = v as string | number | boolean;
    }

    if (op.hasBody && body === undefined && op.method !== "GET") {
      throw new ToolError(`${op.id} (${op.method} ${op.path}) needs a request body.`);
    }

    return this.http.request(path, {
      method: op.method,
      query,
      body: op.method === "GET" ? undefined : body,
    });
  }

  /** Backing for the list_operations tool. */
  browse(search?: string, includeExcluded = false) {
    const pool = includeExcluded ? this.operations : this.covered;
    const q = search?.toLowerCase();
    const hits = q
      ? pool.filter((o) =>
          [o.id, o.path, o.summary ?? "", ...(o.tags ?? [])].join(" ").toLowerCase().includes(q),
        )
      : pool;
    return {
      total: hits.length,
      operations: hits.map((o) => ({
        id: o.id,
        route: `${o.method} ${o.path}`,
        summary: o.summary || undefined,
        tags: o.tags?.length ? o.tags : undefined,
        ...(o.status === "excluded" ? { available: false, why: o.reason } : {}),
      })),
    };
  }
}
