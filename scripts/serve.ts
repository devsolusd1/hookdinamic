// The service: the agent and the keeper in one process, and their records over HTTP.
// Start it and leave it. On a host it is the container's only command; at home it is
// `npm run serve`.
//
// It serves four things, and nothing else:
//   /log.jsonl          the agent's log as it is on disk, one JSON object per line
//   /ledger.jsonl       the keeper's public ledger, the same way
//   /ledger-head.json   the keeper's running totals and its last lines, the one file the site reads
//   /health             how the two loops are: 200 if well, 503 with the reasons if not
// Add ?tail=500 to the log or the ledger to get only its last lines.
//
// Settings come from the environment, or at home from a .env file next to package.json:
//   RPC_URL, HOOK_PROGRAM, MINT, POOL   where the token lives
//   AGENT_KEYPAIR_JSON                  the agent's keypair file, pasted whole: [12,34,...]
//   ANTHROPIC_API_KEY                   read by the Anthropic SDK
//   KEEPER_KEYPAIR_JSON                 the keeper's keypair file, pasted the same way
//   TREASURY                            the address the treasury's share is sent to
//   DATA_DIR                            everything it keeps (default data). On a host, the mounted volume.
//   PORT                                default 8080
//   ALLOW_ORIGINS                       the pages that may read the records (default https://veluno.li,https://www.veluno.li; * for any)
//   AGENT_OFF=1, KEEPER_OFF=1           keep serving the records, leave that loop off
//   DRY_RUN=1                           both loops work out and print; nothing is sent, nothing is written.
//                                       The agent asks the model as often as it would for real, not more.
//   RESTORE_FROM                        a web address holding copies of log.jsonl and ledger.jsonl, read once if the disk comes up without them
//   AGENT_MODEL, AGENT_EFFORT, AGENT_POLL_SECS, AGENT_THINK_EVERY_SECS                as in scripts/agent.ts
//   KEEPER_EVERY_SECS, KEEPER_OWN_WALLETS, KEEPER_SETTINGS                            as in scripts/keeper.ts
// At home AGENT_KEYPAIR and KEEPER_KEYPAIR may name a keypair file instead, as the other two scripts take them.
//
// Under DATA_DIR:
//   agent-log.jsonl            the agent's log, and agent-log.jsonl.pending while an edict is on its way
//   keeper/public/             the keeper's ledger and its head
//   keeper/private/            the keeper's books. Never served. Losing them loses what each holder is still owed.
//   service.lock               touched by the copy that is alive
//
// A host that wants to know whether a new copy has come up should ask "/", which answers as
// soon as the port is open. /health is for people and alarms: it answers 503 the moment a
// loop cannot do its work, and a host that took that for a failed start would take down a
// copy that still serves the records and is saying what is wrong.
import "../src/quiet.js";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statfsSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { askClaude, mendLog, NotTheAgent, readBook, readLog, watch, type Context, type Decide, type LogCheck, type Outcome } from "../src/agent.js";
import { AlreadyRunning, Retired, round, settingsFrom, type KeeperContext, type KeeperOutcome } from "../src/keeper/index.js";
import { solPriceUsd } from "../src/price.js";

/** Below this much free disk the agent issues nothing: an edict whose text could not be kept is worse than none. */
const MIN_FREE_BYTES = 16 * 1024 * 1024;
/** A loop that has said nothing for this long is taken for dead. A look at the market, or a round that pays thousands, can take minutes. */
const SILENT_MS = 15 * 60_000;
/** How often the copy that is alive touches its lock, and how long a lock nobody touched is still believed. */
const LOCK_BEAT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
/** The lengths ?tail= comes in. A few, so that what is kept ready for the next reader stays small. */
const TAILS = [100, 500, 2000];
/**
 * The two ways the keeper says its own wallet is out of SOL: before a step it cannot afford
 * (src/keeper/round.ts), and when a payout round runs short halfway (src/keeper/holders.ts).
 */
const KEEPER_SHORT = /needs topping up|is topped up/;

/** What a test may put in the place of the real thing. Nothing here is read from the environment. */
export type Options = {
  /** The settings. Left out: the process's own environment. */
  env?: NodeJS.ProcessEnv;
  /** The model. Left out: Claude, through `askClaude`. */
  decide?: Decide;
  /** The keeper's round. Left out: the keeper's own. */
  round?: (ctx: KeeperContext) => Promise<KeeperOutcome>;
  /** The chain. Left out: the node at RPC_URL. */
  connection?: Connection;
  dbc?: DynamicBondingCurveClient;
  /** Where its lines go. Left out: the console. */
  print?: (line: string) => void;
};

export type Service = {
  port: number;
  /** Lets each loop finish the step it is on, then lets go of the lock and the port. */
  stop(): Promise<void>;
  /** Whether a stop has been asked for. */
  stopping(): boolean;
};

type Beat = {
  /** Meant to run. */
  on: boolean;
  /** Why it is not running although it was meant to. */
  failed: string | null;
  /** What it last reported, and when it last gave a sign of life. */
  last: string | null;
  lastAt: number | null;
  /** Whether it has got through a step without an error since this process started. */
  worked: boolean;
  errorsInARow: number;
  lastError: string | null;
  lastErrorAt: number | null;
  /** The last error is one that trying again cannot clear: a person has to. */
  forGood: boolean;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    // A signal that has already been given gives no second notice.
    if (signal?.aborted) return done();
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); done(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });

const stamp = () => new Date().toISOString();

/** An error as one line that is safe to print: an RPC address carries its key, so only the host of any address is kept. */
export function plain(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0].replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/g, (address) => {
    try {
      return new URL(address).origin;
    } catch {
      return "(an address)";
    }
  });
}

/**
 * An error as /health shows it to anyone who asks: its words if they hold no web address and
 * nothing that looks like a key being given, otherwise only what kind of error it was. The
 * keeper's own reasons for stopping pass, and so does "X is not set"; an RPC node's complaint
 * about a request, which may quote the address it was sent to, does not.
 */
export function inPublic(error: unknown): string {
  const kind = error instanceof Error ? error.constructor.name : "unknown";
  const text = (error instanceof Error ? error.message : String(error)).split("\n")[0];
  return /:\/\/|(?:api[-_]?key|token|secret)\s*=|x-api-key\s*:|authorization\s*:|bearer\s+\S/i.test(text) || text.length > 400 ? kind : text;
}

/**
 * Starts the service and returns once the port is open and both loops have been started (or
 * have said why they cannot be). It ends only through `stop`.
 */
export async function serve(options: Options = {}): Promise<Service> {
  const env = options.env ?? process.env;
  const print = options.print ?? ((line: string) => console.log(line));
  const say = (line: string) => print(`${stamp()} ${line}`);
  const need = (name: string, fallback?: string) => {
    const value = env[name] || fallback;
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const on = (name: string) => env[name] === "1";
  const seconds = (name: string, fallback: string) => {
    const value = Number(need(name, fallback));
    if (!(value > 0)) throw new Error(`${name} has to be a number of seconds above zero`);
    return value;
  };

  const dataDir = resolve(need("DATA_DIR", "data"));
  const keeperDir = join(dataDir, "keeper");
  const logPath = join(dataDir, "agent-log.jsonl");
  const ledgerPath = join(keeperDir, "public", "ledger.jsonl");
  const headPath = join(keeperDir, "public", "ledger-head.json");
  const lockPath = join(dataDir, "service.lock");
  mkdirSync(dataDir, { recursive: true });
  const dryRun = on("DRY_RUN");

  /**
   * A keypair from the settings. NAME_JSON holds the content of a keypair file, the list of
   * 64 numbers `solana-keygen` writes, so that no key file has to exist on the host. At home
   * NAME may be the path of such a file instead. What it says when it fails never shows the key.
   */
  function keypairFrom(name: string): Keypair {
    const path = env[name];
    const text = env[`${name}_JSON`] || (path ? readFileSync(path, "utf8") : "");
    if (!text) throw new Error(`${name}_JSON is not set`);
    let bytes: unknown;
    try {
      bytes = JSON.parse(text);
    } catch {
      throw new Error(`${name}_JSON is not a keypair: paste the whole content of the keypair file, from [ to ]`);
    }
    if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      throw new Error(`${name}_JSON is not a keypair: it has to be a list of 64 numbers`);
    }
    // Nothing started from here, and nothing that prints the environment, gets to see it.
    delete env[`${name}_JSON`];
    return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
  }

  const freeBytes = () => {
    const { bavail, bsize } = statfsSync(dataDir);
    return bavail * bsize;
  };

  // -------------------------------------------------------------------------------------------
  // What /health reports.

  const quiet = (): Beat => ({ on: false, failed: null, last: null, lastAt: null, worked: false, errorsInARow: 0, lastError: null, lastErrorAt: null, forGood: false });
  const startedAt = Date.now();
  const health = {
    starting: true,
    /** `withoutText`: the edicts found on chain whose text is in neither the log nor the line written before sending. They stay listed until the service is started again. */
    agent: { ...quiet(), address: null as string | null, lastEdictAt: null as number | null, withoutText: [] as number[] },
    /**
     * `saying`: the last thing the keeper did, or what it waits for, in its own words.
     * `short`: it has said its wallet is out of SOL, and has not had a round with nothing in its way since.
     * `finished`: the guardian has named another keeper and this one has paid out what it held, in its own words. It takes no more rounds.
     */
    keeper: { ...quiet(), address: null as string | null, saying: null as string | null, short: false, finished: null as string | null },
  };

  function beat(of: Beat, event: { status: string; error?: unknown }) {
    of.last = event.status;
    of.lastAt = Date.now();
    if (event.status === "error") {
      of.errorsInARow++;
      of.lastError = inPublic(event.error);
      of.lastErrorAt = of.lastAt;
      of.forGood = event.error instanceof NotTheAgent;
    } else {
      of.errorsInARow = 0;
      of.worked = true;
    }
  }

  /** Why the service is not well, in words safe to show anyone. Empty: it is. */
  function problems(): string[] {
    const found: string[] = [];
    if (health.starting) found.push("still starting");
    for (const [name, loop] of [["agent", health.agent], ["keeper", health.keeper]] as const) {
      if (loop.failed) found.push(`the ${name} is not running: ${loop.failed}`);
      if (!loop.on || loop.failed) continue;
      if (Date.now() - (loop.lastAt ?? startedAt) > SILENT_MS) found.push(`the ${name} has gone silent`);
      // One error after a step that went well may be a node that hiccuped: it takes three in a
      // row to say so. An error that trying again cannot clear is said at once. So is one from a
      // loop that has not got through a single step since this process started: wrong settings
      // look exactly like that, and somebody who has just started the service is looking.
      if (loop.errorsInARow >= 3 || (loop.errorsInARow > 0 && loop.forGood)) found.push(`the ${name} keeps failing: ${loop.lastError}`);
      else if (loop.errorsInARow > 0 && !loop.worked) found.push(`the ${name} has not worked since it started: ${loop.lastError}`);
    }
    // A keeper that has finished has not failed, and is listed all the same: from then on
    // nobody takes the fees out of the pool through this service, and only a person can change
    // that. Its line begins with words of its own, so that it is not read as a failure.
    if (health.keeper.finished) found.push(`the keeper has finished and no keeper runs here now: ${health.keeper.finished}`);
    for (const epoch of health.agent.withoutText) found.push(`edict ${epoch} is on chain and its text is not in the log`);
    // The keeper says so itself, in a round that otherwise went well.
    if (health.keeper.short) found.push("the keeper's wallet needs topping up");
    try {
      if (freeBytes() < MIN_FREE_BYTES) found.push("the disk is nearly full");
    } catch {
      found.push("the disk cannot be read");
    }
    return found;
  }

  // -------------------------------------------------------------------------------------------
  // The records over HTTP.

  const allowed = new Set(need("ALLOW_ORIGINS", "https://veluno.li,https://www.veluno.li").split(",").map((origin) => origin.trim()).filter(Boolean));
  /** The two records that grow a line at a time. The head is a small file replaced whole, and is served as it is. */
  const RECORDS: Record<string, string> = { "/log.jsonl": logPath, "/ledger.jsonl": ledgerPath };

  type Served = { etag: string; body: Buffer; gzip?: Buffer };
  const ready = new Map<string, Served>();

  /** A record as it is served: whole lines only, all of them or the last `tail`. Read again only when the file has changed. */
  function served(path: string, tail: number): Served {
    let size = 0;
    let changed = 0;
    try {
      const stat = statSync(path);
      [size, changed] = [stat.size, Math.floor(stat.mtimeMs)];
    } catch {
      // Not written yet: an empty record, which is not the same as no record at this address.
    }
    // Weak, because the same tag goes out with and without compression.
    const etag = `W/"${size.toString(16)}-${changed.toString(16)}-${tail}"`;
    const key = `${path}#${tail}`;
    const kept = ready.get(key);
    if (kept?.etag === etag) return kept;
    let body = size ? readFileSync(path) : Buffer.alloc(0);
    // A line being written at this very moment is left for the next read.
    body = body.subarray(0, body.lastIndexOf(10) + 1);
    if (tail) {
      let from = body.length - 1;
      for (let lines = 0; from > 0 && lines < tail; lines++) from = body.lastIndexOf(10, from - 1);
      // Its own bytes, so that the whole file is not kept in memory for the sake of its end.
      body = Buffer.from(body.subarray(from + 1));
    }
    const fresh: Served = { etag, body };
    ready.set(key, fresh);
    return fresh;
  }

  /** The keeper's head file. It is small and replaced whole, so it is read each time and named by what is in it. */
  function head(): Served {
    let body = ready.get(headPath)?.body ?? Buffer.alloc(0);
    try {
      body = readFileSync(headPath);
    } catch {
      // Not written yet, or being replaced at this very moment: what was last read stands, and before that nothing.
    }
    const etag = `W/"${createHash("sha1").update(body).digest("hex").slice(0, 20)}"`;
    const kept = ready.get(headPath);
    if (kept?.etag === etag) return kept;
    const fresh: Served = { etag, body };
    ready.set(headPath, fresh);
    return fresh;
  }

  function answer(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://service");
    const origin = request.headers.origin;
    const headers: Record<string, string> = { "x-content-type-options": "nosniff", vary: "Origin, Accept-Encoding" };
    if (allowed.has("*")) headers["access-control-allow-origin"] = "*";
    else if (origin && allowed.has(origin)) headers["access-control-allow-origin"] = origin;

    if (request.method === "OPTIONS") {
      response.writeHead(204, { ...headers, "access-control-allow-methods": "GET, HEAD", "access-control-max-age": "86400" }).end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { ...headers, allow: "GET, HEAD, OPTIONS" }).end();
      return;
    }
    const send = (status: number, more: Record<string, string>, body?: Buffer | string) => {
      response.writeHead(status, { ...headers, ...more }).end(request.method === "HEAD" ? undefined : body);
    };

    if (url.pathname === "/health") {
      const found = problems();
      const iso = (time: number | null) => (time ? new Date(time).toISOString() : null);
      const loop = (of: Beat) => ({ on: of.on && !of.failed, last: of.last, lastAt: iso(of.lastAt), errorsInARow: of.errorsInARow, lastError: of.lastError, lastErrorAt: iso(of.lastErrorAt) });
      const file = (path: string) => {
        try {
          const stat = statSync(path);
          return { bytes: stat.size, changedAt: iso(stat.mtimeMs) };
        } catch {
          return { bytes: 0, changedAt: null };
        }
      };
      let diskFreeMb: number | null = null;
      try {
        diskFreeMb = Math.floor(freeBytes() / 1024 / 1024);
      } catch {
        // Said among the problems.
      }
      const body = {
        ok: found.length === 0,
        problems: found,
        since: iso(startedAt),
        dryRun,
        agent: { ...loop(health.agent), address: health.agent.address, lastEdictAt: iso(health.agent.lastEdictAt), withoutText: health.agent.withoutText },
        keeper: { ...loop(health.keeper), address: health.keeper.address, saying: health.keeper.saying },
        records: { log: file(logPath), ledger: file(ledgerPath), ledgerHead: file(headPath) },
        diskFreeMb,
      };
      send(found.length === 0 ? 200 : 503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, JSON.stringify(body, null, 2));
      return;
    }

    const isHead = url.pathname === "/ledger-head.json";
    const path = RECORDS[url.pathname];
    if (!isHead && !path) {
      const text = url.pathname === "/" ? "Veluno's agent and keeper. Their records: /log.jsonl, /ledger.jsonl and /ledger-head.json. How they are: /health.\n" : "not found\n";
      send(url.pathname === "/" ? 200 : 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, text);
      return;
    }
    const asked = Number(url.searchParams.get("tail"));
    const record = isHead ? head() : served(path, asked > 0 ? (TAILS.find((length) => length >= asked) ?? TAILS[TAILS.length - 1]) : 0);
    const about = {
      "content-type": isHead ? "application/json; charset=utf-8" : "application/x-ndjson; charset=utf-8",
      etag: record.etag,
      // A browser keeps its copy but asks every time whether it still stands, and is told so in
      // a few bytes when it does. Anything between the browser and here (Vercel, when the page
      // reads the record through a rewrite) may answer for five seconds on its own.
      "cache-control": "no-cache",
      "cdn-cache-control": "max-age=5",
    };
    if (request.headers["if-none-match"] === record.etag) {
      send(304, about);
      return;
    }
    if (record.body.length > 1024 && /\bgzip\b/.test(String(request.headers["accept-encoding"] ?? ""))) {
      record.gzip ??= gzipSync(record.body);
      send(200, { ...about, "content-encoding": "gzip" }, record.gzip);
      return;
    }
    send(200, about, record.body);
  }

  // -------------------------------------------------------------------------------------------
  // Starting, running, stopping.

  const stopping = new AbortController();
  let beatLock: NodeJS.Timeout | undefined;
  let lockTaken = false;

  /**
   * Two copies appending to the same files would interleave their lines. A copy that is alive
   * touches the lock every ten seconds; a new one waits until nobody has for a while. This only
   * sees a copy on the same disk. One running on another machine with the same keys is caught
   * afterwards: by the agent as an edict "without text", by the keeper as a transaction its
   * records do not have.
   */
  async function takeLock(): Promise<void> {
    for (let told = false; !stopping.signal.aborted; ) {
      let age = Infinity;
      try {
        age = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        // No lock: nobody is here.
      }
      if (age > LOCK_STALE_MS) break;
      if (!told) say("another copy has these files; waiting for it to go");
      told = true;
      await sleep(5_000, stopping.signal);
    }
    if (stopping.signal.aborted) return;
    writeFileSync(lockPath, String(process.pid));
    lockTaken = true;
    beatLock = setInterval(() => {
      try {
        const now = new Date();
        utimesSync(lockPath, now, now);
      } catch {
        // The disk is in trouble; /health says so.
      }
    }, LOCK_BEAT_MS);
    beatLock.unref();
  }

  /** A disk that comes up without a record gets it back from its copy, before anything is appended to an empty file. */
  async function restore(name: string, path: string): Promise<void> {
    const from = env.RESTORE_FROM;
    if (!from || existsSync(path)) return;
    const response = await fetch(`${from.replace(/\/$/, "")}/${name}`, { signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) return;
    if (!response.ok) throw new Error(`the copy of ${name} answered ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    say(`${name} was not on the disk: put back from its copy, ${body.length} bytes`);
  }

  /** What a check of the log against the rulebook found: said once, and an edict without a text kept on /health. */
  function noted(found: LogCheck, epoch: number) {
    if (found !== "missing" || health.agent.withoutText.includes(epoch)) return;
    health.agent.withoutText.push(epoch);
    say(`agent: edict ${epoch} is on chain and was not written from here: its text is not in my log`);
  }

  function agentContext(connection: Connection, dbc: DynamicBondingCurveClient): Context {
    let model = options.decide;
    if (!model) {
      // The SDK would only fail at the first look, with a stack trace.
      if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) throw new Error("ANTHROPIC_API_KEY is not set");
      const effort = need("AGENT_EFFORT", "medium");
      if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error(`AGENT_EFFORT cannot be ${effort}`);
      model = askClaude({
        persona: readFileSync(new URL("../agent/persona.md", import.meta.url), "utf8"),
        model: need("AGENT_MODEL", "claude-opus-5-5"),
        effort: effort as "low" | "medium" | "high" | "xhigh" | "max",
      });
    }
    const decide = model;
    return {
      connection,
      dbc,
      hookProgram: new PublicKey(need("HOOK_PROGRAM")),
      mint: new PublicKey(need("MINT")),
      pool: new PublicKey(need("POOL")),
      agent: keypairFrom("AGENT_KEYPAIR"),
      logPath,
      solPriceUsd,
      dryRun,
      // Before the model is asked: the log is checked against the rulebook this look has just
      // read, and no edict is asked for without room on the disk to keep its text.
      decide: async (snapshot, book) => {
        if (dryRun) return decide(snapshot, book);
        noted(mendLog({ logPath }, book), Number(book.epoch));
        if (freeBytes() < MIN_FREE_BYTES) {
          return { action: "hold", reasoning: "My disk is nearly full and I could not keep the text of a new edict, so nothing changes.", model: "none" };
        }
        return decide(snapshot, book);
      },
    };
  }

  async function runAgent(ctx: Context): Promise<void> {
    health.agent.on = true;
    health.agent.address = ctx.agent.publicKey.toBase58();
    const thinkEverySecs = seconds("AGENT_THINK_EVERY_SECS", "300");
    const pollSecs = seconds("AGENT_POLL_SECS", "20");
    say(`agent ${health.agent.address} on token ${ctx.mint.toBase58()}${dryRun ? " (dry run)" : ""}`);

    // At the start the log is checked against the chain once, whatever the loop does next: an
    // edict that landed while the last copy was dying gets its text here.
    if (!dryRun) {
      try {
        const book = await readBook(ctx);
        const found = mendLog(ctx, book);
        if (found === "restored") say(`agent: edict ${book.epoch} was on chain without its text in the log; the text was put back`);
        noted(found, Number(book.epoch));
      } catch (error) {
        say(`agent: could not check the log against the chain: ${plain(error)}`);
      }
    }

    // A disk that was first used for another token, a rehearsal on devnet say, still has that
    // one's edicts in the log. They are not this agent's memory; whoever reads the log is told.
    const mint = ctx.mint.toBase58();
    const others = readLog(logPath).length - readLog(logPath, mint).length;
    if (others > 0) say(`agent: the log holds ${others} line${others === 1 ? "" : "s"} of another token. They are left where they are and are not my memory`);

    // `watch` asks the model at once when it starts. After a restart that would be one more
    // call than was due: the wait after a look that issued nothing is taken up where the log
    // shows it was left. The rulebook is read meanwhile all the same.
    const last = readLog(logPath, mint).at(-1);
    const since = last ? (Date.now() - Date.parse(last.record.at)) / 1000 : Infinity;
    const firstLookInSecs = last?.record.action === "hold" && since >= 0 && since < thinkEverySecs ? thinkEverySecs - since : 0;

    let saidLast: string | null = null;
    await watch(ctx, {
      pollSecs,
      thinkEverySecs,
      firstLookInSecs,
      signal: stopping.signal,
      report: (event: Outcome | { status: "error"; error: unknown }) => {
        // Leaving the model alone for a while is a sign of life and no more. It is not a step
        // that went well, and it does not end a run of errors: the looks that fail after the
        // model was asked are minutes apart, with this in between.
        if (event.status === "resting") Object.assign(health.agent, { last: event.status, lastAt: Date.now() });
        else beat(health.agent, event);
        if (event.status === "rewritten" && event.signature) health.agent.lastEdictAt = Date.now();
        const line =
          event.status === "rewritten" ? `${event.signature ? `issued an edict (${event.signature})` : "would issue an edict (dry run, nothing sent)"}: ${event.announcement}`
          : event.status === "held" ? `issued nothing: ${event.reasoning}`
          : event.status === "in-force" ? `the edict in force has ${Math.ceil(event.seconds / 60)} min left`
          : event.status === "too-soon" ? `the last edict is too recent; ${event.seconds}s to go`
          : event.status === "paused" ? "paused by the guardian"
          : event.status === "resting" ? "the next look is not due yet"
          : `error: ${plain(event.error)}`;
        // Waiting repeats on every poll, a pause for as long as it lasts, and an error that does
        // not go away at every try: each is said once.
        const news = event.status === "in-force" || event.status === "too-soon" || event.status === "paused" || event.status === "resting" ? event.status : event.status === "error" ? line : null;
        if (news !== null && news === saidLast) return;
        saidLast = news;
        say(`agent: ${line}`);
      },
    });
  }

  async function runKeeper(connection: Connection, dbc: DynamicBondingCurveClient): Promise<void> {
    const settings = settingsFrom(JSON.parse(env.KEEPER_SETTINGS || "{}") as Record<string, unknown>);
    const ownWallets = (env.KEEPER_OWN_WALLETS || "").split(",").map((address) => address.trim()).filter(Boolean);
    // A wallet listed with a typo would be paid as a holder: every address is checked before anything starts.
    for (const address of ownWallets) {
      try {
        new PublicKey(address);
      } catch {
        throw new Error(`KEEPER_OWN_WALLETS has something that is not an address: ${address.slice(0, 60)}`);
      }
    }
    const everySecs = seconds("KEEPER_EVERY_SECS", "20");
    // A dry run changes nothing, so its next round works out the same things and would print
    // the same lines every few seconds: a line the round before also said is not printed again.
    let saidBefore = new Set<string>();
    let saidNow = new Set<string>();
    const ctx: KeeperContext = {
      connection,
      dbc,
      hookProgram: new PublicKey(need("HOOK_PROGRAM")),
      mint: new PublicKey(need("MINT")),
      pool: new PublicKey(need("POOL")),
      keeper: keypairFrom("KEEPER_KEYPAIR"),
      treasury: new PublicKey(need("TREASURY")),
      dir: keeperDir,
      dryRun,
      signal: stopping.signal,
      settings: { ...settings, ownWallets: [...(settings.ownWallets ?? []), ...ownWallets] },
      // Each thing a round does, as it does it. A long round is not a silent one.
      report: (line) => {
        health.keeper.lastAt = Date.now();
        health.keeper.saying = line;
        if (KEEPER_SHORT.test(line)) health.keeper.short = true;
        saidNow.add(line);
        if (!dryRun || !saidBefore.has(line)) say(`keeper: ${line}`);
      },
    };
    health.keeper.on = true;
    health.keeper.address = ctx.keeper.publicKey.toBase58();
    say(`keeper ${health.keeper.address} on token ${ctx.mint.toBase58()}, treasury ${ctx.treasury.toBase58()}${dryRun ? " (dry run)" : ""}`);

    const take = options.round ?? round;
    let said: string | null = null;
    while (!stopping.signal.aborted) {
      try {
        const outcome = await take(ctx);
        beat(health.keeper, outcome);
        if (outcome.status === "settled") {
          // What it did was said as it happened.
          said = null;
        } else {
          health.keeper.saying = outcome.reason;
          // A round that did nothing gives everything that stood in its way. If its own wallet
          // is not among that any more, it has been topped up. A round that did something
          // names what stood in the way only the first time, so it cannot say this.
          health.keeper.short = KEEPER_SHORT.test(outcome.reason);
          // The figures in "nothing is due" move with every trade: it is the same news.
          const news = outcome.reason.startsWith("nothing is due") ? "nothing is due" : outcome.reason;
          if (news !== said) say(`keeper: waiting: ${outcome.reason}`);
          said = news;
        }
      } catch (error) {
        // Another process holds the keeper's folder: this one has no business waiting for it.
        if (error instanceof AlreadyRunning) throw error;
        // The guardian has named another keeper, and this one has paid out what it held. That
        // is the end of its work and not a failure. Every later round would end here at once,
        // so none is taken: the loop ends, and what to do next is said once. A wallet that has
        // nothing more to send needs no topping up either.
        if (error instanceof Retired) {
          Object.assign(health.keeper, { on: false, last: "retired", lastAt: Date.now(), errorsInARow: 0, short: false, finished: inPublic(error) });
          say(`keeper: finished: ${plain(error)}`);
          say(`keeper: it takes no more rounds. The fees in the pool wait for the new keeper. What to do next: put the new keeper's key in KEEPER_KEYPAIR_JSON. The new keeper also needs a folder of its own: the books and the ledger in ${keeperDir} are this keeper's, and another keeper refuses them. If the guardian names this key again instead, start the service again: it is the keeper as before.`);
          return;
        }
        beat(health.keeper, { status: "error", error });
        const news = `error: ${plain(error)}`;
        if (news !== said) say(`keeper: ${news}`);
        said = news;
      }
      [saidBefore, saidNow] = [saidNow, new Set()];
      await sleep(everySecs * 1000, stopping.signal);
    }
  }

  const server = createServer((request, response) => {
    try {
      answer(request, response);
    } catch (error) {
      say(`a request failed: ${plain(error)}`);
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("error\n");
    }
  });
  const running: Promise<unknown>[] = [];
  let stopped: Promise<void> | undefined;

  const stop = () =>
    (stopped ??= (async () => {
      stopping.abort();
      await Promise.allSettled(running);
      clearInterval(beatLock);
      if (lockTaken) rmSync(lockPath, { force: true });
      await new Promise<void>((done) => {
        server.close(() => done());
        // A reader that keeps its connection open would hold the port for as long as it likes.
        server.closeAllConnections();
      });
    })());

  // The port opens first, so that the host's check is answered while the rest starts.
  const port = Number(need("PORT", "8080"));
  await new Promise<void>((listening, refused) => {
    server.once("error", refused);
    server.listen(port, () => listening());
  });
  say(`serving ${dataDir} on port ${port}`);
  await takeLock();

  /** A loop that cannot start, or ends on its own, says why and stays off. The other one, and the records, go on, and /health answers 503 until somebody has looked. */
  const start = (loop: Beat, name: string, run: () => Promise<void>) =>
    running.push(
      (async () => run())().catch((error) => {
        loop.failed = inPublic(error);
        say(`${name}: stopped: ${plain(error)}`);
      }),
    );

  if (!stopping.signal.aborted) {
    // A disk that came up without its records gets them back first. Both loops wait for that,
    // so neither appends to a file that is still to come; if it fails, each says so and stays off.
    const filesBack = restore("log.jsonl", logPath).then(() => restore("ledger.jsonl", ledgerPath));
    filesBack.catch((error) => say(`could not fetch the copies of the records: ${plain(error)}`));
    const chain = () => {
      const connection = options.connection ?? new Connection(need("RPC_URL"), "confirmed");
      return { connection, dbc: options.dbc ?? DynamicBondingCurveClient.create(connection, "confirmed") };
    };
    if (on("AGENT_OFF")) say("the agent is off");
    else start(health.agent, "agent", async () => { await filesBack; const { connection, dbc } = chain(); await runAgent(agentContext(connection, dbc)); });
    if (on("KEEPER_OFF")) say("the keeper is off");
    else start(health.keeper, "keeper", async () => { await filesBack; const { connection, dbc } = chain(); await runKeeper(connection, dbc); });
    // With both loops off there is nobody to wait for the files: the port has been open all along.
    if (on("AGENT_OFF") && on("KEEPER_OFF")) await filesBack.catch(() => undefined);
  }
  health.starting = false;

  return { port: (server.address() as { port: number }).port, stop, stopping: () => stopping.signal.aborted };
}

/**
 * The service as a process: started, and stopped by the host's signal. A host that replaces
 * the container sends SIGTERM and waits; each loop finishes the step it is on, and the process
 * leaves with nothing half done.
 */
export async function main(options: Options = {}): Promise<void> {
  if (!options.env && existsSync(".env")) process.loadEnvFile(".env");
  // Anything nobody caught: better to be started again clean than to go on in an unknown state.
  process.on("unhandledRejection", (error) => {
    console.error(`${stamp()} stopping on an error nobody caught: ${plain(error)}`);
    process.exit(1);
  });
  const service = await serve(options);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      // Asked twice, it leaves at once: whatever was in hand is in the files, and the next start picks it up.
      if (service.stopping()) process.exit(1);
      console.log(`${stamp()} ${signal}: finishing the step in hand`);
      void service.stop().then(() => {
        console.log(`${stamp()} stopped`);
        process.exit(0);
      });
    });
  }
}

// Started as a script, it is the service. Imported, it starts nothing by itself.
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    await main();
  } catch (error) {
    console.error(`${stamp()} could not start: ${plain(error)}`);
    process.exit(1);
  }
}
