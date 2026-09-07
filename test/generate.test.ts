import { describe, it, expect } from "vitest";
import { buildCatalogue, type ExclusionRule } from "../src/generate.js";

const spec = {
  paths: {
    "/api/things": {
      // A path item can carry shared parameters alongside its verbs; they
      // apply to every operation under it and are easy to miss.
      parameters: [{ in: "query", name: "locale" }],
      get: { operationId: "listThings", tags: ["things"], summary: "List things" },
      post: { operationId: "createThing", tags: ["things"], requestBody: {} },
    },
    "/api/things/{id}": {
      get: {
        operationId: "getThing",
        tags: ["things"],
        parameters: [{ in: "path", name: "id" }, { in: "query", name: "fields" }],
      },
      delete: { tags: ["things", "admin"], parameters: [{ in: "path", name: "id" }] },
    },
    "/api/analytics/totals": { get: { tags: ["analytics"] } },
  },
};

describe("buildCatalogue", () => {
  it("captures every verb and ignores non-verb keys", () => {
    const r = buildCatalogue(spec);
    expect(r.operations).toHaveLength(5);
    expect(r.operations.map((o) => o.method)).not.toContain("PARAMETERS");
  });

  it("derives a stable id when the spec supplies none", () => {
    // Forem omits operationId on all eight analytics endpoints.
    const r = buildCatalogue(spec, { stripPrefix: "/api" });
    const derived = r.operations.find((o) => o.path === "/api/analytics/totals")!;
    expect(derived.id).toBe("getAnalyticsTotals");
    // Stable across runs, or every refresh churns the whole catalogue.
    expect(buildCatalogue(spec, { stripPrefix: "/api" }).operations.find(
      (o) => o.path === "/api/analytics/totals",
    )!.id).toBe(derived.id);
  });

  it("merges path-level parameters into each operation", () => {
    const r = buildCatalogue(spec);
    const list = r.operations.find((o) => o.id === "listThings")!;
    expect(list.queryParams).toContain("locale");
  });

  it("separates path parameters from query parameters", () => {
    const r = buildCatalogue(spec);
    const get = r.operations.find((o) => o.id === "getThing")!;
    expect(get.pathParams).toEqual(["id"]);
    expect(get.queryParams).toEqual(["fields"]);
  });

  it("records which operations take a body", () => {
    const r = buildCatalogue(spec);
    expect(r.operations.find((o) => o.id === "createThing")!.hasBody).toBe(true);
    expect(r.operations.find((o) => o.id === "listThings")!.hasBody).toBe(false);
  });

  it("applies exclusions and attaches the reason", () => {
    const rules: ExclusionRule[] = [
      { match: (o) => o.tags.includes("admin"), reason: "Admin only.", label: "admin" },
    ];
    const r = buildCatalogue(spec, { exclusions: rules });
    expect(r.excluded).toBe(1);
    const gone = r.operations.find((o) => o.status === "excluded")!;
    expect(gone.reason).toBe("Admin only.");
    expect(gone.tool).toBeUndefined();
  });

  it("reports a rule that matched nothing, because a dead rule is invisible", () => {
    // Real case: a rule written for /api/openapi never fired, because the
    // actual route was /api/v1/openapi.json. The counts looked fine.
    const rules: ExclusionRule[] = [
      { match: (o) => o.path === "/api/nope", reason: "Never matches.", label: "dead" },
      { match: (o) => o.tags.includes("admin"), reason: "Admin only.", label: "admin" },
    ];
    const r = buildCatalogue(spec, { exclusions: rules });
    expect(r.ruleHits.find((h) => h.label === "dead")!.count).toBe(0);
    expect(r.ruleHits.find((h) => h.label === "admin")!.count).toBe(1);
  });

  it("uses the first matching rule, so specific rules can precede general ones", () => {
    const rules: ExclusionRule[] = [
      { match: (o) => o.method === "DELETE", reason: "Specific.", label: "specific" },
      { match: (o) => o.tags.includes("admin"), reason: "General.", label: "general" },
    ];
    const r = buildCatalogue(spec, { exclusions: rules });
    expect(r.operations.find((o) => o.method === "DELETE")!.reason).toBe("Specific.");
    expect(r.ruleHits.find((h) => h.label === "general")!.count).toBe(0);
  });

  it("names a tool for everything it covers", () => {
    const r = buildCatalogue(spec, { toolFor: () => "thing_call" });
    expect(r.operations.every((o) => o.status !== "covered" || o.tool === "thing_call")).toBe(true);
  });

  it("resolves $ref parameters", () => {
    // Not an edge case: Printify declares EVERY parameter this way. A naive
    // `p.in === "path"` filter drops all of them, because a $ref has no `in`,
    // and the catalogue then claims the operation takes no path parameters.
    const refSpec = {
      components: {
        parameters: {
          shop_id: { in: "path", name: "shop_id" },
          limit: { in: "query", name: "limit" },
        },
      },
      paths: {
        "/shops/{shop_id}/products": {
          get: {
            operationId: "listProducts",
            parameters: [
              { $ref: "#/components/parameters/shop_id" },
              { $ref: "#/components/parameters/limit" },
            ],
          },
        },
      },
    };
    const op = buildCatalogue(refSpec).operations[0]!;
    expect(op.pathParams).toEqual(["shop_id"]);
    expect(op.queryParams).toEqual(["limit"]);
  });

  it("follows a $ref that points at another $ref", () => {
    const chained = {
      components: {
        parameters: {
          real: { in: "path", name: "id" },
          alias: { $ref: "#/components/parameters/real" },
        },
      },
      paths: { "/x/{id}": { get: { parameters: [{ $ref: "#/components/parameters/alias" }] } } },
    };
    expect(buildCatalogue(chained).operations[0]!.pathParams).toEqual(["id"]);
  });

  it("takes path parameters from the route template even when undeclared", () => {
    // A spec can simply fail to declare one. The template is the authority on
    // what the URL contains - without this the request goes out with a literal
    // "{id}" in it.
    const undeclared = { paths: { "/things/{id}": { get: { operationId: "getThing" } } } };
    const r = buildCatalogue(undeclared);
    expect(r.operations[0]!.pathParams).toEqual(["id"]);
    expect(r.undeclaredPathParams).toEqual(["GET /things/{id} → {id}"]);
  });

  it("does not duplicate a parameter that is both declared and in the template", () => {
    const both = {
      paths: {
        "/things/{id}": {
          get: { operationId: "getThing", parameters: [{ in: "path", name: "id" }] },
        },
      },
    };
    const r = buildCatalogue(both);
    expect(r.operations[0]!.pathParams).toEqual(["id"]);
    expect(r.undeclaredPathParams).toEqual([]);
  });

  it("does not choke on a $ref it cannot resolve", () => {
    const broken = {
      paths: { "/x": { get: { parameters: [{ $ref: "#/components/parameters/missing" }] } } },
    };
    expect(() => buildCatalogue(broken)).not.toThrow();
    expect(buildCatalogue(broken).operations[0]!.queryParams).toEqual([]);
  });
});
