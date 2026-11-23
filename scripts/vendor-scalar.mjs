// Copies the Scalar API reference bundle into `public/vendor/scalar/` so `/docs` works offline
// (no CDN). Runs before `next dev` and `next build`; the output is git-ignored.
// The bundle is not in the package `exports`, so it is read from the direct dependency's folder.
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const source = path.join(root, "node_modules", "@scalar", "api-reference", "dist", "browser");
const targetDir = path.join(root, "public", "vendor", "scalar");

mkdirSync(targetDir, { recursive: true });
copyFileSync(path.join(source, "standalone.js"), path.join(targetDir, "standalone.js"));
