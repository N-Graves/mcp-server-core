import { z } from "zod";

const bare = z.string().url();
const cases = [
  "https://example.com/a.png",
  "http://example.com/a.png",
  "file:///etc/passwd",
  "gopher://example.com",
  "javascript:alert(1)",
  "data:text/html,<script>",
  "https://user:pass@example.com/a.png",
];

console.log("what z.string().url() alone accepts:\n");
for (const c of cases) {
  const ok = bare.safeParse(c).success;
  console.log(`  ${ok ? "ACCEPTS" : "refuses"}  ${c}`);
}
