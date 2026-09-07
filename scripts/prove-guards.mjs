/**
 * Prove each safety guard is load-bearing.
 *
 *   node scripts/prove-guards.mjs
 *
 * A test that passes whether or not the protection is present proves nothing.
 * This disables one guard at a time by patching its source, runs the test that
 * is supposed to catch it, and requires that test to FAIL. Then it restores
 * the file and moves on.
 *
 * Every anchor must match exactly once. A probe that matches zero times
 * silently "proves" a guard that was never disabled, and one that matches
 * twice may be disabling something other than the thing under test - both have
 * happened in this codebase's history, which is why the count is asserted.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const PROBES = [
  {
    name: "http: non-2xx must throw rather than return the error body as data",
    file: "src/http.ts",
    find: `    if (!res.ok) {
      throw new HttpError(\`\${describeStatus(res.status)} (HTTP \${res.status})\`, res.status, text);
    }`,
    replace: `    // guard disabled by prove-guards.mjs`,
    test: "throws on a non-2xx",
  },
  {
    name: "http: the provider's error body must stay out of the message",
    file: "src/http.ts",
    find: `      throw new HttpError(\`\${describeStatus(res.status)} (HTTP \${res.status})\`, res.status, text);`,
    replace: `      throw new HttpError(text, res.status, text);`,
    test: "never puts the provider",
  },
  {
    name: "http: the streaming size cap must refuse an oversized body",
    file: "src/http.ts",
    find: `      if (total > this.maxBytes) {`,
    replace: `      if (false) {`,
    test: "even when content-length lies",
  },
  {
    name: "http: a stalled request must time out",
    file: "src/http.ts",
    find: `    const timer = setTimeout(() => controller.abort(), timeoutMs);`,
    replace: `    const timer = setTimeout(() => {}, timeoutMs);`,
    test: "times out rather than hanging",
  },
  {
    name: "errors: host paths must be scrubbed from unexpected errors",
    file: "src/errors.ts",
    find: `    return \`Unexpected error: \${scrubHostDetail(err.message)}\`;`,
    replace: `    return \`Unexpected error: \${err.message}\`;`,
    test: "strips POSIX paths",
  },
  {
    name: "errors: an HttpError's provider body must not reach the caller",
    file: "src/errors.ts",
    find: `  if (err instanceof HttpError) {
    return err.message;
  }`,
    replace: `  if (err instanceof HttpError) {
    return err.message + " " + (err.providerBody ?? "");
  }`,
    test: "keeps an HttpError summary",
  },
  {
    name: "server: arguments must be validated before the handler runs",
    file: "src/server.ts",
    find: `      if (!parsed.success) {`,
    replace: `      if (false) {`,
    test: "validates arguments before the handler runs",
  },
  {
    name: "server: authorization must run before the handler",
    file: "src/server.ts",
    find: `      await authorizer.authorize({ tool: name, action: tool.action, args: parsed.data });`,
    replace: `      // guard disabled by prove-guards.mjs`,
    test: "authorizes after validation and before the handler",
  },
  {
    name: "server: duplicate tool names must be refused at startup",
    file: "src/server.ts",
    find: `  if (byName.size !== opts.tools.length) {`,
    replace: `  if (false) {`,
    test: "refuses to start with duplicate tool names",
  },
  {
    name: "coverage: a provider operation absent from the catalogue must fail",
    file: "src/coverage.ts",
    find: `  const missing = [...provider].filter((k) => !cat.has(k)).sort();`,
    replace: `  const missing = [];`,
    test: "flags an operation the provider has",
  },
  {
    name: "coverage: an exclusion with no reason must fail",
    file: "src/coverage.ts",
    find: `      (o.status === "excluded" && !o.reason?.trim()) ||`,
    replace: `      (false) ||`,
    test: "refuses an exclusion with no reason",
  },
  {
    name: "validate: non-http schemes must be refused",
    file: "src/validate.ts",
    find: `    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;`,
    replace: `    // guard disabled by prove-guards.mjs`,
    test: "accepts real web URLs and refuses every other scheme",
  },
];

let red = 0;
let broken = 0;

for (const probe of PROBES) {
  const path = join(ROOT, probe.file);
  const original = readFileSync(path, "utf8");

  const count = original.split(probe.find).length - 1;
  if (count !== 1) {
    console.log(`✗ ANCHOR  ${probe.name}`);
    console.log(`          matched ${count} times in ${probe.file}, expected exactly 1 — skipped`);
    broken++;
    continue;
  }

  writeFileSync(path, original.replace(probe.find, probe.replace), "utf8");
  let failedAsItShould = false;
  let output = "";
  try {
    // -t is a REGEX, not a substring. A test named "accepts http(s) and ..."
    // read as a pattern means "accepts https and ...", which matches nothing -
    // and vitest exits 0 when nothing matches, so the probe reported the guard
    // as still-passing when in fact no test had run at all. Escape it.
    const pattern = probe.test.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = execSync(`npx vitest run -t ${JSON.stringify(pattern)} --reporter=dot`, {
      cwd: ROOT,
      stdio: "pipe",
    }).toString();
  } catch (err) {
    failedAsItShould = true;
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  } finally {
    writeFileSync(path, original, "utf8");
  }

  // A probe that runs no tests proves nothing, and must never read as a pass.
  const ran = /Tests\s+\d+\s+(passed|failed)/.test(output) && !/No test files found/.test(output);
  if (!ran) {
    console.log(`✗ NO-RUN  ${probe.name}`);
    console.log(`          the filter matched no tests, so nothing was exercised`);
    broken++;
    continue;
  }

  if (failedAsItShould) {
    console.log(`✓ RED     ${probe.name}`);
    red++;
  } else {
    console.log(`✗ GREEN   ${probe.name}`);
    console.log(`          the test still passed with the guard removed — it proves nothing`);
    broken++;
  }
}

console.log(`\n${red}/${PROBES.length} guards proven load-bearing.`);
if (broken) {
  console.log(`${broken} probe(s) did not discriminate. Fix the test or the probe before trusting either.`);
  process.exit(1);
}
