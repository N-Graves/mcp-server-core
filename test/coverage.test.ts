import { describe, it, expect } from "vitest";
import {
  checkCoverage,
  formatCoverage,
  operationsFromOpenApi,
  type Operation,
} from "../src/coverage.js";

const provider = [
  { method: "GET", path: "/articles" },
  { method: "POST", path: "/articles" },
  { method: "GET", path: "/articles/{id}" },
];

describe("coverage", () => {
  it("passes when every provider operation is accounted for", () => {
    const cat: Operation[] = [
      { id: "list", method: "GET", path: "/articles", status: "covered", tool: "x_list" },
      { id: "create", method: "POST", path: "/articles", status: "covered", tool: "x_create" },
      { id: "get", method: "GET", path: "/articles/{id}", status: "covered", tool: "x_get" },
    ];
    const r = checkCoverage(cat, provider);
    expect(r.ok).toBe(true);
    expect(r.covered).toBe(3);
  });

  it("flags an operation the provider has that the catalogue does not", () => {
    // This is the case that matters: the provider shipped something new and
    // the README's "full coverage" quietly became false.
    const cat: Operation[] = [
      { id: "list", method: "GET", path: "/articles", status: "covered", tool: "x_list" },
      { id: "create", method: "POST", path: "/articles", status: "covered", tool: "x_create" },
    ];
    const r = checkCoverage(cat, provider);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["GET /articles/{}"]);
  });

  it("flags a catalogue entry the provider no longer has", () => {
    const cat: Operation[] = [
      ...provider.map((p, i) => ({
        id: `op${i}`,
        method: p.method as Operation["method"],
        path: p.path,
        status: "covered" as const,
        tool: "x",
      })),
      { id: "gone", method: "DELETE", path: "/articles/{id}", status: "covered", tool: "x_delete" },
    ];
    const r = checkCoverage(cat, provider);
    expect(r.ok).toBe(false);
    expect(r.stale).toEqual(["DELETE /articles/{}"]);
  });

  it("refuses an exclusion with no reason", () => {
    // "We do not support this" without a why is how a gap becomes permanent.
    const cat: Operation[] = [
      { id: "list", method: "GET", path: "/articles", status: "covered", tool: "x_list" },
      { id: "create", method: "POST", path: "/articles", status: "excluded" },
      { id: "get", method: "GET", path: "/articles/{id}", status: "covered", tool: "x_get" },
    ];
    const r = checkCoverage(cat, provider);
    expect(r.ok).toBe(false);
    expect(r.malformed[0]).toContain("no reason given");
  });

  it("accepts an exclusion that gives one", () => {
    const cat: Operation[] = [
      { id: "list", method: "GET", path: "/articles", status: "covered", tool: "x_list" },
      {
        id: "create",
        method: "POST",
        path: "/articles",
        status: "excluded",
        reason: "Requires the Partner Program; returns 403 ACCESS_DENIED on a standard app.",
      },
      { id: "get", method: "GET", path: "/articles/{id}", status: "covered", tool: "x_get" },
    ];
    const r = checkCoverage(cat, provider);
    expect(r.ok).toBe(true);
    expect(r.excluded).toBe(1);
  });

  it("refuses a covered operation that names no tool", () => {
    const cat: Operation[] = [
      { id: "list", method: "GET", path: "/articles", status: "covered" },
      { id: "create", method: "POST", path: "/articles", status: "covered", tool: "x_create" },
      { id: "get", method: "GET", path: "/articles/{id}", status: "covered", tool: "x_get" },
    ];
    expect(checkCoverage(cat, provider).malformed[0]).toContain("no tool named");
  });

  it("treats differently-named path parameters as the same operation", () => {
    // The provider says {id}; a catalogue might say {article_id}. Same endpoint.
    const cat: Operation[] = [
      { id: "get", method: "GET", path: "/articles/{article_id}", status: "covered", tool: "x_get" },
    ];
    const r = checkCoverage(cat, [{ method: "GET", path: "/articles/{id}" }]);
    expect(r.ok).toBe(true);
  });

  it("extracts operations from an OpenAPI document", () => {
    const ops = operationsFromOpenApi({
      paths: {
        "/articles": { get: {}, post: {}, parameters: [] },
        "/articles/{id}": { get: {}, put: {} },
      },
    });
    expect(ops).toHaveLength(4);
    // `parameters` is a sibling of the verbs, not a verb.
    expect(ops.map((o) => o.method)).not.toContain("PARAMETERS");
  });

  it("formats a failure into something a human can act on", () => {
    const r = checkCoverage([], provider);
    const text = formatCoverage(r);
    expect(text).toContain("GET /articles");
    expect(text).toContain("not in the catalogue");
  });
});
