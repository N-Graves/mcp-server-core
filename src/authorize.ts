/**
 * Authorization, as something a host can plug into rather than something baked
 * into every tool.
 *
 * ── The problem this replaces ───────────────────────────────────────────────
 * These servers grew up inside one private multi-agent system. Every write tool
 * called out to that system's task board to check whether the calling agent
 * held a named capability, using a hardcoded default of http://127.0.0.1:8420,
 * and FAILED CLOSED if it could not reach it. Cloned by anyone else, every
 * write tool in every server was permanently broken and there was no way to
 * turn the check off.
 *
 * Worse, the check was baked into the public contract: `agent_id` was a
 * REQUIRED field on every gated tool's inputSchema, and the list of acceptable
 * capabilities was interpolated into the tool's description. So the private
 * system's vocabulary was visible to, and mandatory for, every user.
 *
 * ── The shape now ──────────────────────────────────────────────────────────
 * An Authorizer is asked before a tool runs. The default permits everything,
 * which is the correct default for a server a person runs on their own machine
 * against their own credentials - the credential IS the authorization.
 *
 * A host that needs more (a shared deployment, a multi-agent system, an
 * approval queue) supplies its own. The original task-board check is now just
 * one possible implementation, living in that system's own repo, and nothing
 * here knows it exists.
 */

/** What a tool is asking permission to do. */
export interface AuthorizationRequest {
  /** The tool being invoked, e.g. "devto_create_article". */
  tool: string;
  /**
   * A coarse label for what the tool does. Servers in this family use
   * "read" for anything non-mutating and "write" for anything that changes
   * state on the provider; "destructive" for anything that removes something.
   */
  action: "read" | "write" | "destructive";
  /** The arguments as received. Useful for value-dependent policies. */
  args: Readonly<Record<string, unknown>>;
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export interface Authorizer {
  /** Resolve to allow. Throw AuthorizationError to refuse. */
  authorize(request: AuthorizationRequest): Promise<void> | void;
}

/**
 * The default. Permits everything.
 *
 * This is not an oversight and it is not "no security". A stdio MCP server
 * runs as the user, holding a credential the user configured, in a process the
 * user started. Anything reaching it is already running as them. Adding a
 * permission layer inside that boundary protects nothing and, as the history
 * above shows, breaks the server for everyone who is not the author.
 */
export const allowAll: Authorizer = {
  authorize() {
    /* intentionally empty */
  },
};

/**
 * Refuses anything that changes state. Useful for pointing a server at a live
 * production account for reporting without any risk of it writing.
 *
 * Enable with MCP_READ_ONLY=1 when using {@link authorizerFromEnv}.
 */
export const readOnly: Authorizer = {
  authorize({ tool, action }) {
    if (action !== "read") {
      throw new AuthorizationError(
        `This server is running read-only, so ${tool} is refused. ` +
          `Unset MCP_READ_ONLY to allow it.`,
      );
    }
  },
};

/**
 * Refuses only destructive operations, allowing ordinary writes. A reasonable
 * middle setting for an agent you trust to publish but not to delete.
 *
 * Enable with MCP_NO_DESTRUCTIVE=1.
 */
export const noDestructive: Authorizer = {
  authorize({ tool, action }) {
    if (action === "destructive") {
      throw new AuthorizationError(
        `Destructive operations are disabled, so ${tool} is refused. ` +
          `Unset MCP_NO_DESTRUCTIVE to allow it.`,
      );
    }
  },
};

/** Runs several authorizers in order. The first to throw wins. */
export function combine(...authorizers: Authorizer[]): Authorizer {
  return {
    async authorize(request) {
      for (const a of authorizers) await a.authorize(request);
    },
  };
}

/**
 * Picks an authorizer from the environment, so the common cases need no code.
 * Defaults to {@link allowAll}.
 */
export function authorizerFromEnv(env: NodeJS.ProcessEnv = process.env): Authorizer {
  const on = (v?: string) => v === "1" || v?.toLowerCase() === "true";
  if (on(env.MCP_READ_ONLY)) return readOnly;
  if (on(env.MCP_NO_DESTRUCTIVE)) return noDestructive;
  return allowAll;
}
