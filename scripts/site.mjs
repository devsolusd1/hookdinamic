// Serves site/ for local viewing: `npm run site`.
//
// --config and --log swap in another config.js and log.jsonl. That is how the page is pointed
// at the local validator (see scripts/seed-site.ts) without touching the files that ship.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { port: { type: "string", default: "4321" }, config: { type: "string" }, log: { type: "string" } } });
const root = resolve(import.meta.dirname, "../site");
const swaps = new Map(Object.entries({ "/config.js": values.config, "/data/log.jsonl": values.log }).filter(([, file]) => file));
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jsonl": "application/x-ndjson; charset=utf-8",
};

createServer(async (request, response) => {
  const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const file = swaps.has(path) ? resolve(swaps.get(path)) : join(root, path === "/" ? "index.html" : path);
  if (!swaps.has(path) && file !== root && !file.startsWith(root + sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
  }
}).listen(Number(values.port), () => console.log(`site on http://localhost:${values.port}`));
