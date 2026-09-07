import { describe, it, expect } from "vitest";
import { HttpClient } from "../src/http.js";
import { Dispatcher, type DispatchableOperation } from "../src/dispatch.js";
import { ToolError } from "../src/errors.js";

const OPS: DispatchableOperation[] = [
  {
    id: "listThings", method: "GET", path: "/things", status: "covered", tool: "x_call",
    pathParams: [], queryParams: ["per_page"], hasBody: false, summary: "List things", tags: ["things"],
  },
  {
    id: "getThing", method: "GET", path: "/things/{id}", status: "covered", tool: "x_call",
    pathParams: ["id"], queryParams: [], hasBody: false, tags: ["things"],
  },
  {
    id: "createThing", method: "POST", path: "/things", status: "covered", tool: "x_call",
    pathParams: [], queryParams: [], hasBody: true, tags: ["things"],
  },
  {
    id: "suspendUser", method: "PUT", path: "/users/{id}/suspend", status: "excluded",
    reason: "Requires moderator privileges an ordinary key does not carry.",
    pathParams: ["id"], queryParams: [], hasBody: false, tags: ["users"],
  },
  {
    // Deliberately malformed: declares a path parameter the catalogue missed.
    id: "brokenOp", method: "GET", path: "/things/{id}/parts/{partId}", status: "covered", tool: "x_call",
    pathParams: ["id"], queryParams: [], hasBody: false, tags: [],
  },
];

function client() {
  const calls: { url: string; method: string; body?: string }[] = [];
  const http = new HttpClient({
    baseUrl: "https://api.test",
    fetchImpl: (async (url: string, opts: RequestInit = {}) => {
      calls.push({ url, method: opts.method ?? "GET", body: opts.body as string | undefined });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
  return { calls, d: new Dispatcher(http, OPS, "x_list_operations") };
}

describe("Dispatcher", () => {
  it("separates covered from excluded", () => {
    const { d } = client();
    expect(d.covered).toHaveLength(4);
    expect(d.operations).toHaveLength(5);
  });

  it("suggests near matches for a mistyped id", () => {
    const { d } = client();
    expect(() => d.resolve("listThi")).toThrow(/did you mean.*listThings/i);
  });

  it("names the browse tool when there is nothing close", () => {
    const { d } = client();
    expect(() => d.resolve("zzzzzz")).toThrow(/x_list_operations/);
  });

  it("gives the reason for an excluded operation rather than a bare refusal", () => {
    // A 403 from the provider after the caller has committed is the failure
    // this replaces.
    const { d } = client();
    expect(() => d.resolve("suspendUser")).toThrow(/moderator privileges/);
  });

  it("names a missing path parameter", () => {
    const { d } = client();
    expect(() => d.buildPath(OPS[1]!, {})).toThrow(/needs the path parameter "id"/);
  });

  it("url-encodes path parameters", () => {
    const { d } = client();
    expect(d.buildPath(OPS[1]!, { id: "a b/c" })).toBe("/things/a%20b%2Fc");
  });

  it("refuses a template it cannot fully resolve, blaming the catalogue", () => {
    const { d } = client();
    expect(() => d.buildPath(OPS[4]!, { id: 1 })).toThrow(/bug in the operation catalogue/);
  });

  it("sends non-path arguments as query parameters", async () => {
    const { d, calls } = client();
    await d.call("listThings", { per_page: 5, q: "hi" });
    expect(calls[0]!.url).toContain("per_page=5");
    expect(calls[0]!.url).toContain("q=hi");
  });

  it("never sends a body on a GET", async () => {
    const { d, calls } = client();
    await d.call("listThings", {}, { nope: true });
    expect(calls[0]!.body).toBeUndefined();
  });

  it("refuses a body-taking operation called without one", async () => {
    const { d } = client();
    await expect(d.call("createThing", {})).rejects.toBeInstanceOf(ToolError);
  });

  it("browse hides excluded operations unless asked", () => {
    const { d } = client();
    expect(d.browse().total).toBe(4);
    const all = d.browse(undefined, true);
    expect(all.total).toBe(5);
    expect(all.operations.find((o) => o.available === false)?.why).toMatch(/moderator/);
  });

  it("browse searches id, path, summary and tags", () => {
    const { d } = client();
    expect(d.browse("List things").total).toBe(1);
    expect(d.browse("/things/{id}").total).toBe(2); // getThing and brokenOp
  });
});
