/**
 * A credentials file that survives a crash and two concurrent processes.
 *
 * ── What this replaces ─────────────────────────────────────────────────────
 * The servers this package was extracted from stored rotating OAuth tokens
 * like this:
 *
 *     private writeAll(lines: string[]): void {
 *       writeFileSync(this.path, lines.join("\n"), { mode: 0o600 });
 *     }
 *
 * Three problems, and the third is the one that loses your account access:
 *
 *  1. `mode` only applies when the file is CREATED. A credentials file that
 *     already existed as 0644 stayed world-readable forever, and the code
 *     read as though it had been secured.
 *
 *  2. No atomic write. `writeFileSync` truncates and then writes, so a crash
 *     or a full disk between those two leaves a truncated file.
 *
 *  3. No lock. X's OAuth2 refresh tokens are SINGLE USE and rotate on every
 *     refresh, so two server processes refreshing at once means one of them
 *     persists a token that has already been spent. The refresh chain is then
 *     permanently broken and the only fix is a fresh manual authorisation.
 *
 * This writes to a temp file in the same directory, fsyncs it, chmods it
 * explicitly, and renames over the target - rename being atomic within a
 * filesystem. Refreshes are serialised through a lockfile with stale-lock
 * detection, so a process killed mid-refresh does not wedge the next one.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";

const LOCK_STALE_MS = 30_000;

export class TokenStore {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  read(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    const out: Record<string, string> = {};
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return out;
  }

  get(key: string): string | undefined {
    return this.read()[key];
  }

  /** Merge values in and write atomically. Keys absent from `values` survive. */
  write(values: Record<string, string>): void {
    const merged = { ...this.read(), ...values };
    const body =
      "# Written by an MCP server. Treat as a secret.\n" +
      Object.entries(merged)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") +
      "\n";

    const tmp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, body);
      // Without the fsync the rename can land before the contents do, which on
      // a crash leaves an atomically-renamed empty file - the same outcome the
      // atomic write was meant to prevent.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
    // Explicitly, every time: `mode` on open only applies to a file being
    // created, so a pre-existing 0644 file would otherwise stay readable.
    chmodSync(this.path, 0o600);
  }

  /**
   * Run `fn` with an exclusive lock on this store.
   *
   * For a rotating single-use refresh token this is not optional. Two
   * processes refreshing concurrently both spend the token; whichever writes
   * second persists one the provider has already invalidated, and the chain is
   * broken until somebody re-authorises by hand.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + LOCK_STALE_MS;

    for (;;) {
      try {
        // O_EXCL: succeeds only if we created it, which is what makes this a lock.
        const fd = openSync(lock, "wx");
        writeSync(fd, String(process.pid));
        closeSync(fd);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

        // A process killed mid-refresh must not wedge every later one.
        try {
          const age = Date.now() - statSync(lock).mtimeMs;
          if (age > LOCK_STALE_MS) {
            unlinkSync(lock);
            continue;
          }
        } catch {
          continue; // vanished underneath us; try again
        }

        if (Date.now() > deadline) {
          throw new Error(
            `Timed out waiting for the credentials lock at ${lock}. ` +
              `If no other process is running, delete that file.`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    try {
      return await fn();
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }
  }
}
