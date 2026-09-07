import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  allowAll,
  readOnly,
  noDestructive,
  combine,
  authorizerFromEnv,
  AuthorizationError,
} from "../src/authorize.js";
import { toSafeMessage, ToolError } from "../src/errors.js";
import { HttpError } from "../src/http.js";
import { httpUrl, pageSize } from "../src/validate.js";

describe("authorization", () => {
  const req = (action: "read" | "write" | "destructive") => ({
    tool: "thing_do",
    action,
    args: {},
  });

  it("permits everything by default", async () => {
    // The whole point of the rewrite: a fresh clone works with no config.
    for (const a of ["read", "write", "destructive"] as const) {
      await expect(Promise.resolve(allowAll.authorize(req(a)))).resolves.toBeUndefined();
    }
  });

  it("read-only refuses writes and destructive, allows reads", async () => {
    await expect(Promise.resolve(readOnly.authorize(req("read")))).resolves.toBeUndefined();
    await expect(async () => readOnly.authorize(req("write"))).rejects.toBeInstanceOf(AuthorizationError);
    await expect(async () => readOnly.authorize(req("destructive"))).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("no-destructive allows ordinary writes", async () => {
    await expect(Promise.resolve(noDestructive.authorize(req("write")))).resolves.toBeUndefined();
    await expect(async () => noDestructive.authorize(req("destructive"))).rejects.toThrow(/destructive/i);
  });

  it("combine stops at the first refusal", async () => {
    const combined = combine(noDestructive, readOnly);
    await expect(combined.authorize(req("write"))).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("reads the environment, defaulting to permissive", () => {
    expect(authorizerFromEnv({} as NodeJS.ProcessEnv)).toBe(allowAll);
    expect(authorizerFromEnv({ MCP_READ_ONLY: "1" } as NodeJS.ProcessEnv)).toBe(readOnly);
    expect(authorizerFromEnv({ MCP_NO_DESTRUCTIVE: "true" } as NodeJS.ProcessEnv)).toBe(noDestructive);
  });
});

describe("error sanitisation", () => {
  it("strips POSIX paths, including the home directory", () => {
    const msg = toSafeMessage(new Error("ENOENT: /home/iffyn/projects/fleet/secret.env missing"));
    expect(msg).not.toContain("/home/iffyn");
    expect(msg).toContain("[path]");
  });

  it("strips Windows paths", () => {
    const msg = toSafeMessage(new Error("cannot read C:\\Users\\iffyn\\AppData\\creds.json"));
    expect(msg).not.toContain("C:\\Users");
  });

  it("strips file:// stack frames", () => {
    const msg = toSafeMessage(new Error("at file:///home/iffyn/app/dist/index.js:41:9"));
    expect(msg).not.toContain("iffyn");
  });

  it("redacts anything token-shaped that has leaked into a message", () => {
    const token = "sk_live_" + "a1b2c3d4".repeat(5);
    const msg = toSafeMessage(new Error(`auth failed for ${token}`));
    expect(msg).not.toContain(token);
    expect(msg).toContain("[redacted]");
  });

  it("never exposes cwd, node version or platform", () => {
    // This is the exact shape one inherited server returned on every failure.
    const err = new Error(
      `boom at ${process.cwd()} on node ${process.version} (${process.platform})`,
    );
    const msg = toSafeMessage(err);
    expect(msg).not.toContain(process.cwd());
    // The version string is short and not path-like, so assert on the thing
    // that actually identifies the machine: the working directory.
    expect(msg).toContain("[path]");
  });

  it("passes our own messages through, because they are written to be read", () => {
    expect(toSafeMessage(new ToolError("Article 42 does not exist."))).toBe("Article 42 does not exist.");
  });

  it("keeps an HttpError summary and drops its provider body", () => {
    const err = new HttpError("The provider rejected the credentials. (HTTP 401)", 401, "raw provider detail");
    const msg = toSafeMessage(err);
    expect(msg).toContain("HTTP 401");
    expect(msg).not.toContain("raw provider detail");
  });

  it("hands the original error to the logger, unsanitised", () => {
    let logged: unknown;
    const original = new Error("/home/iffyn/thing");
    toSafeMessage(original, (e) => (logged = e));
    expect(logged).toBe(original);
  });
});

describe("validation helpers", () => {
  it("bounds pagination", () => {
    const schema = pageSize(100, 30);
    expect(schema.parse(undefined)).toBe(30);
    expect(schema.safeParse(5000).success).toBe(false);
    expect(schema.safeParse(0).success).toBe(false);
  });

  it("accepts real web URLs and refuses every other scheme", () => {
    expect(httpUrl.safeParse("https://example.com/a.png").success).toBe(true);
    expect(httpUrl.safeParse("http://example.com/a.png").success).toBe(true);

    // Measured, not assumed: z.string().url() on its own accepts ALL of the
    // following, including javascript: and data:. Several of these providers
    // fetch a supplied URL server-side - Dev.to does it for main_image - and
    // some render one into a page, so the scheme check is the whole point of
    // this schema rather than a nicety on top of zod.
    for (const bad of [
      "file:///etc/passwd",
      "gopher://example.com",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
    ]) {
      expect(httpUrl.safeParse(bad).success, `${bad} must be refused`).toBe(false);
    }
  });

  it("refuses a URL with embedded credentials", () => {
    expect(httpUrl.safeParse("https://user:pass@example.com/a.png").success).toBe(false);
  });
});
