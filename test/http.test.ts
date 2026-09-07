import { describe, it, expect } from "vitest";
import { HttpClient, HttpError, HttpTimeoutError } from "../src/http.js";

/** A fetch stand-in returning a controlled response. */
function stubFetch(init: {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  throws?: Error;
}) {
  return (async (_url: string, opts: RequestInit = {}) => {
    if (init.throws) throw init.throws;
    if (init.delayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, init.delayMs);
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    }
    return new Response(init.body ?? "{}", {
      status: init.status ?? 200,
      headers: init.headers ?? { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("HttpClient", () => {
  it("parses a successful JSON response", async () => {
    const c = new HttpClient({ baseUrl: "https://x.test", fetchImpl: stubFetch({ body: '{"a":1}' }) });
    await expect(c.get("/thing")).resolves.toEqual({ a: 1 });
  });

  it("times out rather than hanging forever", async () => {
    const c = new HttpClient({
      baseUrl: "https://x.test",
      timeoutMs: 30,
      fetchImpl: stubFetch({ delayMs: 5000 }),
    });
    await expect(c.get("/slow")).rejects.toBeInstanceOf(HttpTimeoutError);
  });

  it("throws on a non-2xx instead of returning the error body as data", async () => {
    // The original servers did `return res.json()` with no res.ok check, so a
    // 401 came back looking like a successful result.
    const c = new HttpClient({
      baseUrl: "https://x.test",
      fetchImpl: stubFetch({ status: 401, body: '{"error":"bad token"}' }),
    });
    await expect(c.get("/x")).rejects.toBeInstanceOf(HttpError);
  });

  it("never puts the provider's error body in the thrown message", async () => {
    const secret = "request context and possibly a token";
    const c = new HttpClient({
      baseUrl: "https://x.test",
      fetchImpl: stubFetch({ status: 500, body: secret }),
    });
    const err = (await c.get("/x").catch((e) => e)) as HttpError;
    expect(err.message).not.toContain(secret);
    // ...but it is still available for the server to log.
    expect(err.providerBody).toContain(secret);
  });

  it("refuses a body larger than the cap, by declared length", async () => {
    const c = new HttpClient({
      baseUrl: "https://x.test",
      maxBytes: 100,
      fetchImpl: stubFetch({
        body: "x".repeat(500),
        headers: { "content-length": "500", "content-type": "application/json" },
      }),
    });
    await expect(c.get("/big")).rejects.toThrow(/too large/i);
  });

  it("refuses an oversized body even when content-length lies", async () => {
    // Chunked responses have no content-length, so the declared-length check
    // cannot be the only one.
    const c = new HttpClient({
      baseUrl: "https://x.test",
      maxBytes: 100,
      fetchImpl: stubFetch({ body: "x".repeat(500) }),
    });
    await expect(c.get("/big")).rejects.toThrow(/exceeded/i);
  });

  it("summarises a transport failure rather than forwarding it", async () => {
    const c = new HttpClient({
      baseUrl: "https://x.test",
      fetchImpl: stubFetch({ throws: new Error("getaddrinfo ENOTFOUND internal.host.local") }),
    });
    const err = (await c.get("/x").catch((e) => e)) as HttpError;
    expect(err.message).toBe("Could not reach the provider.");
    expect(err.message).not.toContain("internal.host.local");
  });

  it("drops empty query values rather than sending key=", async () => {
    let seen = "";
    const c = new HttpClient({
      baseUrl: "https://x.test",
      fetchImpl: (async (url: string) => {
        seen = url;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await c.get("/a", { keep: "yes", drop: undefined, blank: "" });
    expect(seen).toContain("keep=yes");
    expect(seen).not.toContain("drop=");
    expect(seen).not.toContain("blank=");
  });

  it("resolves dynamic headers on every request, not once at construction", async () => {
    // X's OAuth2 user tokens last about two hours. A static Authorization
    // header is correct for the first two hours and silently wrong afterwards.
    let n = 0;
    const seen: (string | undefined)[] = [];
    const c = new HttpClient({
      baseUrl: "https://x.test",
      dynamicHeaders: () => ({ Authorization: `Bearer token-${++n}` }),
      fetchImpl: (async (_url: string, opts: RequestInit = {}) => {
        seen.push((opts.headers as Record<string, string>).Authorization);
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await c.get("/a");
    await c.get("/b");
    expect(seen).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("lets a per-call header override a dynamic one", async () => {
    let seen: string | undefined;
    const c = new HttpClient({
      baseUrl: "https://x.test",
      headers: { "X-Static": "s" },
      dynamicHeaders: () => ({ Authorization: "Bearer dynamic" }),
      fetchImpl: (async (_url: string, opts: RequestInit = {}) => {
        seen = (opts.headers as Record<string, string>).Authorization;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await c.request("/a", { headers: { Authorization: "Bearer explicit" } });
    expect(seen).toBe("Bearer explicit");
  });

  it("reports invalid JSON as such rather than crashing", async () => {
    const c = new HttpClient({ baseUrl: "https://x.test", fetchImpl: stubFetch({ body: "<html>nope" }) });
    await expect(c.get("/x")).rejects.toThrow(/not valid JSON/i);
  });

  it("can hand back response headers, not only the body", async () => {
    // Some providers put the result somewhere other than the body: LinkedIn
    // returns a newly created post's URN in the x-restli-id header and leaves
    // the body empty, so a client that only reads bodies cannot tell the
    // caller what it just published.
    const c = new HttpClient({
      baseUrl: "https://x.test",
      fetchImpl: (async () =>
        new Response("", {
          status: 201,
          headers: { "x-restli-id": "urn:li:share:123" },
        })) as unknown as typeof fetch,
    });
    const res = await c.requestWithMeta("/posts", { method: "POST", body: {} });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-restli-id")).toBe("urn:li:share:123");
    expect(res.data).toBeUndefined();
  });

  it("still refuses a non-2xx through the metadata path", async () => {
    // The status is not a way around the error handling.
    const c = new HttpClient({
      baseUrl: "https://x.test",
      fetchImpl: (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch,
    });
    await expect(c.requestWithMeta("/x")).rejects.toThrow(/HTTP 403/);
  });
});
