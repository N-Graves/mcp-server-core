/**
 * A fetch wrapper that will not hang, will not read an unbounded body, and
 * will not hand a provider's error text back to the model.
 *
 * Every one of those is a real failure seen in the servers this package was
 * extracted from:
 *
 *  - No timeout anywhere. A provider that accepts a connection and then stalls
 *    left the tool call hanging until something further up gave up, which from
 *    the caller's side is indistinguishable from a broken server.
 *  - No size cap. An endpoint returning a very large body would be read
 *    entirely into memory before anyone looked at it.
 *  - `return res.json()` with no `res.ok` check, so a 401 or a 429 came back
 *    looking like data and the model cheerfully carried on with it.
 *  - Error bodies passed through verbatim. Provider errors routinely echo back
 *    request context, and one server logged the raw refresh-token response.
 */

export interface HttpClientOptions {
  baseUrl: string;
  /** Sent on every request. Merged with, and overridden by, per-call headers. */
  headers?: Record<string, string>;
  /**
   * Resolved before every request, and merged over the static headers.
   *
   * This is how an expiring credential is handled. X's OAuth2 user tokens last
   * about two hours, so a static Authorization header is correct for the first
   * two hours of a session and silently wrong afterwards - and the failure
   * arrives as a 401 the caller cannot do anything about. A provider that
   * refreshes supplies the header here instead.
   */
  dynamicHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
  /** Hard ceiling per request. Default 30s. */
  timeoutMs?: number;
  /** Refuse a response body larger than this. Default 8 MiB. */
  maxBytes?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  method?: string;
  /** Serialised as JSON. Sets Content-Type unless you override it. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Appended as a query string; undefined and empty values are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  timeoutMs?: number;
}

/**
 * Raised for any non-2xx response, and for transport failures.
 *
 * `message` is safe to show a model. `providerBody` is deliberately NOT
 * included in it - it is kept as a separate field so a server can log it
 * without it ending up in a tool result by accident.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly providerBody?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class HttpTimeoutError extends HttpError {
  constructor(readonly timeoutMs: number) {
    super(`The request timed out after ${timeoutMs}ms.`, 0);
    this.name = "HttpTimeoutError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** Providers vary wildly in error shape; this is a summary, never a passthrough. */
function describeStatus(status: number): string {
  if (status === 400) return "The provider rejected the request as malformed.";
  if (status === 401) return "The provider rejected the credentials.";
  if (status === 403) return "The provider refused the request. The credentials may lack the required scope.";
  if (status === 404) return "The provider has no such resource.";
  if (status === 409) return "The provider reported a conflict with the current state.";
  if (status === 422) return "The provider rejected the values supplied.";
  if (status === 429) return "The provider is rate limiting. Try again later.";
  if (status >= 500) return "The provider returned a server error.";
  return `The provider returned an unexpected status.`;
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly baseHeaders: Record<string, string>;
  private readonly dynamicHeaders?: HttpClientOptions["dynamicHeaders"];
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly doFetch: typeof fetch;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.baseHeaders = opts.headers ?? {};
    this.dynamicHeaders = opts.dynamicHeaders;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.doFetch = opts.fetchImpl ?? globalThis.fetch;
  }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }

    // Resolved per request so an expiring credential can refresh itself.
    // Explicit per-call headers still win, so a caller can override.
    const dynamic = this.dynamicHeaders ? await this.dynamicHeaders() : {};
    const headers: Record<string, string> = { ...this.baseHeaders, ...dynamic, ...opts.headers };
    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["Content-Type"] ??= "application/json";
    }

    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await this.doFetch(url.toString(), {
        method: opts.method ?? "GET",
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new HttpTimeoutError(timeoutMs);
      // Transport failure. The message can contain the resolved host and
      // internal detail, so it is summarised rather than forwarded.
      throw new HttpError("Could not reach the provider.", 0, String(err));
    } finally {
      clearTimeout(timer);
    }

    // Declared length is checked before reading, so an oversized body is
    // refused rather than downloaded and then rejected.
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > this.maxBytes) {
      throw new HttpError(
        `The provider's response was too large (${declared} bytes, limit ${this.maxBytes}).`,
        res.status,
      );
    }

    const text = await this.readCapped(res);

    if (!res.ok) {
      throw new HttpError(`${describeStatus(res.status)} (HTTP ${res.status})`, res.status, text);
    }

    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError("The provider returned a body that was not valid JSON.", res.status, text);
    }
  }

  /**
   * Streams the body and stops at the cap. A missing or lying content-length is
   * the normal case for a chunked response, so the check above cannot be the
   * only one.
   */
  private async readCapped(res: Response): Promise<string> {
    if (!res.body) return res.text();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxBytes) {
        await reader.cancel();
        throw new HttpError(
          `The provider's response exceeded the ${this.maxBytes} byte limit.`,
          res.status,
        );
      }
      chunks.push(value);
    }
    const joined = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      joined.set(c, at);
      at += c.byteLength;
    }
    return new TextDecoder().decode(joined);
  }

  get<T = unknown>(path: string, query?: RequestOptions["query"]) {
    return this.request<T>(path, { method: "GET", query });
  }
  post<T = unknown>(path: string, body?: unknown, query?: RequestOptions["query"]) {
    return this.request<T>(path, { method: "POST", body, query });
  }
  put<T = unknown>(path: string, body?: unknown, query?: RequestOptions["query"]) {
    return this.request<T>(path, { method: "PUT", body, query });
  }
  patch<T = unknown>(path: string, body?: unknown, query?: RequestOptions["query"]) {
    return this.request<T>(path, { method: "PATCH", body, query });
  }
  delete<T = unknown>(path: string, query?: RequestOptions["query"]) {
    return this.request<T>(path, { method: "DELETE", query });
  }
}
