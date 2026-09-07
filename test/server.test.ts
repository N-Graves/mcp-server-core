import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createServer, type ToolDefinition } from "../src/server.js";
import { AuthorizationError, type Authorizer } from "../src/authorize.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * The SDK's Server keeps its handlers private, so these drive them the way the
 * transport does: build the server, then invoke the registered handler.
 */
function handlersOf(server: ReturnType<typeof createServer>) {
  const map = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
  return {
    list: () => map.get(ListToolsRequestSchema.shape.method.value)!({ method: "tools/list" }, {}),
    call: (name: string, args: unknown) =>
      map.get(CallToolRequestSchema.shape.method.value)!(
        { method: "tools/call", params: { name, arguments: args } },
        {},
      ),
  };
}

const echoTool: ToolDefinition = {
  name: "thing_echo",
  description: "Echoes a bounded string back.",
  action: "read",
  input: z.object({ text: z.string().max(10) }),
  handler: async (args) => ({ echoed: (args as { text: string }).text }),
};

const writeTool: ToolDefinition = {
  name: "thing_write",
  description: "Pretends to write.",
  action: "write",
  input: z.object({}),
  handler: async () => ({ written: true }),
};

const textOf = (res: unknown) =>
  (res as { content: { text: string }[] }).content[0]!.text;

describe("dispatch", () => {
  it("advertises every tool with a generated JSON schema", async () => {
    const s = createServer({ name: "t", version: "0", tools: [echoTool, writeTool] });
    const listed = (await handlersOf(s).list()) as { tools: { name: string; inputSchema: unknown }[] };
    expect(listed.tools.map((t) => t.name)).toEqual(["thing_echo", "thing_write"]);
    expect(listed.tools[0]!.inputSchema).toMatchObject({ type: "object" });
  });

  it("refuses to start with duplicate tool names", () => {
    // A duplicate silently shadows, so the advertised surface stops matching
    // the code. Better to fail at startup.
    expect(() =>
      createServer({ name: "t", version: "0", tools: [echoTool, { ...echoTool }] }),
    ).toThrow(/duplicate/i);
  });

  it("validates arguments before the handler runs", async () => {
    let ran = false;
    const s = createServer({
      name: "t",
      version: "0",
      tools: [{ ...echoTool, handler: async () => ((ran = true), {}) }],
    });
    const res = await handlersOf(s).call("thing_echo", { text: "far too long to pass" });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/invalid arguments/i);
    expect(ran).toBe(false);
  });

  it("names the offending field", async () => {
    const s = createServer({ name: "t", version: "0", tools: [echoTool] });
    const res = await handlersOf(s).call("thing_echo", { text: 42 });
    expect(textOf(res)).toContain("text");
  });

  it("authorizes after validation and before the handler", async () => {
    const order: string[] = [];
    const auth: Authorizer = {
      authorize() {
        order.push("authorize");
        throw new AuthorizationError("nope");
      },
    };
    const s = createServer({
      name: "t",
      version: "0",
      authorizer: auth,
      tools: [{ ...writeTool, handler: async () => (order.push("handler"), {}) }],
    });
    const res = await handlersOf(s).call("thing_write", {});
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(order).toEqual(["authorize"]);
  });

  it("passes the action through so a policy can discriminate", async () => {
    const seen: string[] = [];
    const s = createServer({
      name: "t",
      version: "0",
      authorizer: { authorize: (r) => void seen.push(`${r.tool}:${r.action}`) },
      tools: [echoTool, writeTool],
    });
    await handlersOf(s).call("thing_echo", { text: "hi" });
    await handlersOf(s).call("thing_write", {});
    expect(seen).toEqual(["thing_echo:read", "thing_write:write"]);
  });

  it("sanitises a handler throwing something with a path in it", async () => {
    const s = createServer({
      name: "t",
      version: "0",
      logger: () => {},
      tools: [
        {
          ...echoTool,
          handler: async () => {
            throw new Error(`failed reading /home/iffyn/.creds`);
          },
        },
      ],
    });
    const res = await handlersOf(s).call("thing_echo", { text: "hi" });
    expect(textOf(res)).not.toContain("/home/iffyn");
  });

  it("answers an unknown tool without throwing", async () => {
    const s = createServer({ name: "t", version: "0", tools: [echoTool] });
    const res = await handlersOf(s).call("nope", {});
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/no such tool/i);
  });
});
