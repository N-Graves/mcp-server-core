/**
 * The server bootstrap and the single dispatch choke point.
 *
 * Every tool goes through one place, which is what makes it possible to say
 * anything true about all of them: validation runs, authorization runs, errors
 * are sanitised. The servers this replaces each had their own hand-rolled
 * switch statement with the checks copied per case, and the copies had drifted
 * - in one, article updates skipped a gate that article creation applied.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ZodIssue, ZodTypeAny, z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { allowAll, type Authorizer } from "./authorize.js";
import { errorResult, okResult, ToolError } from "./errors.js";

export interface ToolDefinition<S extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  /** Zod schema for the arguments. Also generates the advertised JSON schema. */
  input: S;
  /** Governs authorization and is stated in the generated documentation. */
  action: "read" | "write" | "destructive";
  handler: (args: z.infer<S>) => Promise<unknown>;
}

export interface ServerOptions {
  name: string;
  version: string;
  tools: ToolDefinition<any>[];
  authorizer?: Authorizer;
  /** Where internal detail goes. Defaults to stderr, which is correct for
   *  stdio transport - stdout is the protocol channel and writing to it
   *  corrupts the session. */
  logger?: (message: string, err?: unknown) => void;
}

const defaultLogger = (message: string, err?: unknown) => {
  console.error(`[${new Date().toISOString()}] ${message}`, err ?? "");
};

export function createServer(opts: ServerOptions) {
  const log = opts.logger ?? defaultLogger;
  const authorizer = opts.authorizer ?? allowAll;
  const byName = new Map(opts.tools.map((t) => [t.name, t]));

  if (byName.size !== opts.tools.length) {
    // A duplicate name means one tool silently shadows another. Better to
    // refuse to start than to serve a surface that does not match the code.
    const seen = new Set<string>();
    const dupes = opts.tools.map((t) => t.name).filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
    throw new Error(`Duplicate tool names: ${[...new Set(dupes)].join(", ")}`);
  }

  const server = new Server(
    { name: opts.name, version: opts.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.input, { $refStrategy: "none" }) as Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const tool = byName.get(name);
    if (!tool) {
      return errorResult(new ToolError(`No such tool: ${name}`));
    }

    try {
      // 1. Validate. Bad input fails here with a message naming the field,
      //    rather than reaching the provider as a malformed request.
      const parsed = tool.input.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue: ZodIssue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new ToolError(`Invalid arguments for ${name} — ${detail}`);
      }

      // 2. Authorize, before anything happens and after we know the values.
      await authorizer.authorize({ tool: name, action: tool.action, args: parsed.data });

      // 3. Run.
      return okResult(await tool.handler(parsed.data));
    } catch (err) {
      return errorResult(err, (e) => log(`${name} failed`, e));
    }
  });

  return server;
}

/** Create the server and connect it to stdio. The usual entry point. */
export async function runServer(opts: ServerOptions): Promise<void> {
  const server = createServer(opts);
  await server.connect(new StdioServerTransport());
  // stderr, not stdout - stdout carries the protocol.
  console.error(`${opts.name} v${opts.version} ready (${opts.tools.length} tools)`);
}
