// The Node pipeline (dist/) runs unbundled ESM, which requires explicit
// file extensions, while Next.js/Turbopack resolves extensionless relative
// imports. TypeScript preserves specifiers as written, so after `tsc` this
// appends `.js` to extensionless relative imports in the emitted output.
// ponytail: drop this once the custom server/CLI is fully replaced by Next.js.
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const pattern = /(from\s+["']|import\s*\(\s*["'])(\.[^"']*?)(["'])/g;

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function fix(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await fix(path);
      continue;
    }
    if (!path.endsWith(".js")) continue;
    const original = await readFile(path, "utf8");
    const parts = [];
    let last = 0;
    for (const match of original.matchAll(pattern)) {
      const [full, pre, spec, post] = match;
      const index = match.index ?? 0;
      let replacement = full;
      if (
        !(await isFile(join(dirname(path), spec))) &&
        (await isFile(join(dirname(path), `${spec}.js`)))
      ) {
        replacement = `${pre}${spec}.js${post}`;
      }
      parts.push(original.slice(last, index), replacement);
      last = index + full.length;
    }
    parts.push(original.slice(last));
    const fixed = parts.join("");
    if (fixed !== original) await writeFile(path, fixed);
  }
}

await fix("dist");
