/**
 * Turning a thrown error into something safe to hand back to a model.
 *
 * ── Why this is its own module ─────────────────────────────────────────────
 * One of the servers this package was extracted from built its tool responses
 * like this:
 *
 *     text += `- **Error Stack**: ${errorStack}\n`;
 *     text += `- **Current Working Directory**: ${process.cwd()}\n`;
 *     text += `- **Node.js Version**: ${process.version}\n`;
 *     text += `- **Platform**: ${process.platform}\n`;
 *
 * That is the filesystem layout, the runtime version and a stack trace of the
 * user's machine, handed to a model on every failure - and, if the model is
 * relaying to somewhere else, onward from there. It was inherited from
 * upstream and nobody had looked at it.
 *
 * The rule here: a caller learns WHAT failed and what to do about it. It never
 * learns anything about the machine the server is running on.
 */

import { AuthorizationError } from "./authorize.js";
import { HttpError } from "./http.js";

/** Anything a tool can safely say out loud. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Paths, hostnames and anything else that describes the host machine. */
function scrubHostDetail(s: string): string {
  return s
    // POSIX absolute paths, including the home directory.
    .replace(/\/(?:home|Users|root|var|tmp|opt|etc)\/[^\s"')]*/g, "[path]")
    // Windows paths.
    .replace(/[A-Za-z]:\\[^\s"')]*/g, "[path]")
    // file:// URLs, which node stack frames are full of.
    .replace(/file:\/\/[^\s"')]*/g, "[path]")
    // Anything that looks like a bearer token or api key that has leaked into
    // a message. Deliberately greedy about what counts.
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
}

/**
 * Convert any thrown value into a message that is safe to return.
 *
 * `onInternal` is called with the original error so a server can log the full
 * detail to stderr, which is where operator-facing information belongs - it is
 * never part of the returned string.
 */
export function toSafeMessage(err: unknown, onInternal?: (err: unknown) => void): string {
  onInternal?.(err);

  // Ours, and already written for a caller to read.
  if (err instanceof ToolError || err instanceof AuthorizationError) {
    return err.message;
  }

  // Already summarised by the http layer. providerBody is deliberately not
  // included - it routinely echoes request context back.
  if (err instanceof HttpError) {
    return err.message;
  }

  if (err instanceof SyntaxError) {
    return "The provider returned something that could not be parsed.";
  }

  // Anything else is unexpected, so say so rather than guessing. The message
  // is scrubbed because unexpected errors are exactly the ones carrying paths.
  if (err instanceof Error && err.message) {
    return `Unexpected error: ${scrubHostDetail(err.message)}`;
  }

  return "Unexpected error.";
}

/** The MCP tool-result shape for a failure. */
export function errorResult(err: unknown, onInternal?: (err: unknown) => void) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: toSafeMessage(err, onInternal) }],
  };
}

/** The MCP tool-result shape for success. Objects are pretty-printed. */
export function okResult(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

export { scrubHostDetail as __scrubHostDetail };
