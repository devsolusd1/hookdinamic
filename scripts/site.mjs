// Serves site/ for local viewing: `npm run site`.
//
// --config, --log and --ledger swap in another config.js, log.jsonl and ledger-head.json. That
// is how the page is pointed at the local validator (see scripts/seed-site.ts), or shown a
// keeper's ledger, without touching the files that ship:
//   --config <file>   served as /config.js
//   --log <file>      served as /data/log.jsonl, the agent's log
//   --ledger <file>   served as /data/ledger-head.json, the keeper's running totals and last lines.
//                     If a ledger.jsonl sits next to it, as it does in the keeper's own folder
//                     (keeper/public), that one is served as /data/ledger.jsonl, the whole ledger.
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { port: { type: "string", default: "4321" }, config: { type: "string" }, log: { type: "string" }, ledger: { type: "string" } } });
const root = resolve(import.meta.dirname, "../site");
const wholeLedger = values.ledger ? join(dirname(resolve(values.ledger)), "ledger.jsonl") : undefined;
const swaps = new Map(
  Object.entries({
    "/config.js": values.config,
    "/data/log.jsonl": values.log,
    "/data/ledger-head.json": values.ledger,
    "/data/ledger.jsonl": wholeLedger && existsSync(wholeLedger) ? wholeLedger : undefined,
  }).filter(([, file]) => file),
);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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
    // Each record is named by the address it is served at, whatever the file put in its place is called.
    response.writeHead(200, { "content-type": types[extname(swaps.has(path) ? path : file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
  }
}).listen(Number(values.port), () => console.log(`site on http://localhost:${values.port}`));
