import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../src/token-store.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "token-store-"));
  path = join(dir, "creds.env");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("TokenStore", () => {
  it("round-trips values", () => {
    const s = new TokenStore(path);
    s.write({ ACCESS: "a", REFRESH: "r" });
    expect(s.read()).toMatchObject({ ACCESS: "a", REFRESH: "r" });
    expect(s.get("ACCESS")).toBe("a");
  });

  it("merges rather than replacing, so an unrelated key survives a refresh", () => {
    const s = new TokenStore(path);
    s.write({ CLIENT_ID: "cid", REFRESH: "r1" });
    s.write({ REFRESH: "r2" });
    expect(s.read()).toMatchObject({ CLIENT_ID: "cid", REFRESH: "r2" });
  });

  it("returns an empty object rather than throwing when the file is absent", () => {
    expect(new TokenStore(join(dir, "nope.env")).read()).toEqual({});
  });

  it("chmods an EXISTING file, not only one it creates", () => {
    // This is the actual bug in the code this replaces: `mode` on open applies
    // only at creation, so a credentials file that already existed as 0644
    // stayed world-readable while the code read as though it had secured it.
    writeFileSync(path, "OLD=1\n", { mode: 0o644 });
    expect(statSync(path).mode & 0o777).toBe(0o644);

    new TokenStore(path).write({ NEW: "2" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp file behind", () => {
    const s = new TokenStore(path);
    s.write({ A: "1" });
    const leftovers = readFileSync(path, "utf8");
    expect(leftovers).toContain("A=1");
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });

  it("ignores comments and blank lines", () => {
    writeFileSync(path, "# a comment\n\nA=1\n\n# another\nB=2\n");
    expect(new TokenStore(path).read()).toEqual({ A: "1", B: "2" });
  });

  it("keeps everything after the first = , so a token containing = survives", () => {
    const s = new TokenStore(path);
    const awkward = "abc==def=ghi";
    s.write({ TOKEN: awkward });
    expect(s.get("TOKEN")).toBe(awkward);
  });

  it("serialises concurrent refreshes", async () => {
    // X's OAuth2 refresh tokens are SINGLE USE and rotate on every refresh.
    // Two processes refreshing at once both spend the token, and whichever
    // writes second persists one the provider has already invalidated.
    const s = new TokenStore(path);
    const order: string[] = [];

    const slow = s.withLock(async () => {
      order.push("a:start");
      await new Promise((r) => setTimeout(r, 60));
      order.push("a:end");
    });
    // Give the first one a moment to take the lock.
    await new Promise((r) => setTimeout(r, 10));
    const fast = s.withLock(async () => {
      order.push("b:start");
      order.push("b:end");
    });

    await Promise.all([slow, fast]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("releases the lock even when the work throws", async () => {
    const s = new TokenStore(path);
    await expect(s.withLock(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // If the lock leaked, this would time out rather than resolve.
    await expect(s.withLock(async () => "ok")).resolves.toBe("ok");
  });

  it("breaks a stale lock left by a killed process", async () => {
    // A process killed mid-refresh must not wedge every later one.
    const s = new TokenStore(path);
    const lock = `${path}.lock`;
    writeFileSync(lock, "99999");
    const old = Date.now() - 60_000;
    const { utimesSync } = await import("node:fs");
    utimesSync(lock, old / 1000, old / 1000);

    await expect(s.withLock(async () => "recovered")).resolves.toBe("recovered");
    expect(existsSync(lock)).toBe(false);
  });
});
