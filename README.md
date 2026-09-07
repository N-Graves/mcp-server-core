# @nasdigitaluk/mcp-server-core

The shared spine for a family of [Model Context Protocol](https://modelcontextprotocol.io) servers.

It gives you a fetch layer that cannot hang, cannot read an unbounded body and cannot hand a provider's error text back to a model; pluggable authorization that permits everything by default; error sanitisation; one dispatch choke point where validation and authorization actually happen; and machine-checkable API coverage.

MIT licensed. No runtime dependencies beyond the MCP SDK and zod.

```bash
npm install @nasdigitaluk/mcp-server-core
```

## Why it exists

It was extracted from nine MCP servers that had each copied the same three modules byte-for-byte, and the copies had drifted. Everything here is a response to something that actually went wrong:

| In the original servers | Here |
|---|---|
| `return res.json()` with no `res.ok` check, so a 401 came back looking like data | `HttpClient` throws `HttpError` on any non-2xx |
| No timeout anywhere; a stalled provider hung the call indefinitely | 30s default, per-request override, real `AbortController` |
| No size cap; a large response was read entirely into memory | Declared-length check *and* a streaming cap, because chunked responses have no length |
| Provider error bodies passed through verbatim | Summarised by status; the raw body is kept on the error for logging, never in the message |
| `error.stack`, `process.cwd()`, `process.version` and `process.platform` returned to the model on every failure | `toSafeMessage` scrubs paths, `file://` frames and token-shaped strings |
| Bare `as` casts — `args.id as number` — so bad input reached the provider as an opaque 400 | zod schema per tool, validated before the handler runs, error names the field |
| A hardcoded call to a private task board that **failed closed**, so a fresh clone had every write tool permanently broken | `Authorizer` interface, `allowAll` by default |
| `agent_id` a required field on every write tool, with a private system's capability vocabulary in the tool descriptions | Nothing. Authorization is the host's business, not the schema's |

## Quick start

```ts
import { z } from "zod";
import {
  runServer, HttpClient, authorizerFromEnv, requireEnv, pageSize, ToolError,
} from "@nasdigitaluk/mcp-server-core";

const http = new HttpClient({
  baseUrl: "https://api.example.com",
  headers: { Authorization: `Bearer ${requireEnv("EXAMPLE_TOKEN", "Create one at example.com/settings.")}` },
});

await runServer({
  name: "example-mcp",
  version: "1.0.0",
  authorizer: authorizerFromEnv(),
  tools: [
    {
      name: "example_list_widgets",
      description: "List the widgets on the authenticated account.",
      action: "read",
      input: z.object({ per_page: pageSize(100, 30) }),
      handler: (args) => http.get("/widgets", { per_page: args.per_page }),
    },
    {
      name: "example_delete_widget",
      description: "Permanently delete a widget.",
      action: "destructive",
      input: z.object({ id: z.string().min(1) }),
      handler: async (args) => {
        await http.delete(`/widgets/${encodeURIComponent(args.id)}`);
        return { deleted: args.id };
      },
    },
  ],
});
```

## Authorization

The default permits everything, and that is deliberate.

A stdio MCP server runs as you, holding a credential you configured, in a process you started. Anything reaching it is already running as you. A permission layer inside that boundary protects nothing — and when the original servers put one there, hardcoded to a private HTTP service and failing closed, every write tool was broken for everyone who was not the author.

Two policies are built in for when you want them:

```bash
MCP_READ_ONLY=1        # refuse anything that changes state
MCP_NO_DESTRUCTIVE=1   # allow writes, refuse deletes
```

For anything else, implement the interface. It is one method:

```ts
import { type Authorizer, AuthorizationError } from "@nasdigitaluk/mcp-server-core";

const officeHours: Authorizer = {
  authorize({ tool, action }) {
    const hour = new Date().getHours();
    if (action !== "read" && (hour < 9 || hour > 17)) {
      throw new AuthorizationError(`${tool} is only available between 09:00 and 17:00.`);
    }
  },
};
```

`combine(a, b, c)` runs several in order; the first to throw wins.

## Coverage

"This server covers the whole API" is worth nothing as a sentence in a README, because the provider adds an endpoint and the sentence silently becomes false. Declare a catalogue instead and let a test check it:

```ts
import { checkCoverage, formatCoverage, operationsFromOpenApi } from "@nasdigitaluk/mcp-server-core";
import spec from "./vendor/provider-openapi.json" with { type: "json" };

const report = checkCoverage(CATALOGUE, operationsFromOpenApi(spec));
expect(report.ok, formatCoverage(report)).toBe(true);
```

Two things fail, and the second matters more:

- an operation the provider has that your catalogue does not mention — the provider moved and nobody noticed;
- an operation marked `excluded` with no `reason` — "we do not support this" without a why is how a gap becomes permanent.

Where completeness genuinely is not achievable — a partner-gated, tier-gated or unbounded API — the honest answer is a catalogue full of `excluded` entries with sourced reasons, not a quietly smaller claim.

## Testing

```bash
npm test                        # 42 tests
node scripts/prove-guards.mjs   # disable each guard, require its test to fail
```

The second matters more than the first. A test that passes whether or not the protection is present proves nothing, so `prove-guards.mjs` removes each guard in turn and requires the corresponding test to go red. It refuses to run a probe whose anchor does not match exactly once, and treats a filter that matches no tests as a broken probe rather than a pass — which is a real bug it caught in itself.

## Licence

MIT.
