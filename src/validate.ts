/**
 * Validation helpers for the arguments these servers keep receiving.
 *
 * The servers this replaces used bare casts throughout - `args.id as number`,
 * `args.per_page as number | undefined` - so a string where a number belonged
 * reached the provider as a malformed request and came back as an opaque 400.
 * There were no bounds on pagination, no size cap on article bodies, and no
 * scheme check on the URL fields that providers fetch server-side.
 */

import { z } from "zod";

/**
 * Pagination, bounded.
 *
 * Unbounded per_page is not just untidy: providers differ in whether they clamp
 * it, ignore it, or attempt it, and "attempt it" is how a tool call turns into
 * a multi-megabyte response.
 */
export const pageSize = (max = 100, fallback = 30) =>
  z.number().int().min(1).max(max).optional().default(fallback);

export const pageNumber = z.number().int().min(1).optional().default(1);

/**
 * An http(s) URL.
 *
 * The scheme check is the point. Several of these providers fetch a supplied
 * URL server-side - Dev.to does it for `main_image` - so accepting `file://`
 * or `gopher://` hands the provider's fetcher a scheme nobody intended. It
 * also refuses anything with credentials embedded, which is a common way to
 * smuggle a token into a log.
 */
export const httpUrl = z
  .string()
  .url()
  .refine((u) => {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    return true;
  }, "must be a plain http(s) URL with no embedded credentials");

/** Bounded free text, so a runaway body cannot be posted. */
export const boundedText = (max: number, label = "text") =>
  z.string().max(max, `${label} must be ${max} characters or fewer`);

/**
 * Read a required environment variable, failing at startup with a message that
 * says what to set rather than at first use with a 401.
 */
export function requireEnv(name: string, hint?: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set.${hint ? ` ${hint}` : ""} ` +
        `The server cannot start without it.`,
    );
  }
  return v;
}

export function optionalEnv(name: string, fallback?: string): string | undefined {
  return process.env[name] || fallback;
}
