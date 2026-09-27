// MapLibre GL 6 runs its tile work in a module worker loaded from next to its own script, which
// the Next.js bundler doesn't copy. Serve the worker (and the shared chunk it imports) from
// public/maplibre/ instead; VectorBasemap points setWorkerUrl() there. Runs after npm install.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve("maplibre-gl/package.json")) + "/dist";
const out = new URL("../public/maplibre/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) copyFileSync(join(dist, f), join(out, f));
console.log("maplibre worker copied to public/maplibre/");
