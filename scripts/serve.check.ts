// Checks of the service (scripts/serve.ts), of what keeps an edict's words and of how often the
// model is asked (src/agent.ts), and of the guardian's command when its node does not answer.
//
//   npm run test:serve                  offline: no chain, no model, no key. About half a minute.
//   npm run test:serve -- --validator   the same service as a process of its own, with both loops, and the
//                                       guardian's command, against the local validator (npm run validator
//                                       first). About five minutes.
//
// Offline, the agent's real `runOnce` and the service's real loops run against a made-up chain
// held in memory, and the keeper's round is a stand-in; nothing leaves this machine. On the
// validator everything is the real thing except the model, whose part is played by the
// stand-in that takes the catalogue in order (scripts/stand-in.ts).
//
// The same file, started with --service, is the service itself with that stand-in for the
// model: it is how the checks run it as a process they can signal and kill.
import "../src/quiet.js";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SendTransactionError, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { base58, decodeRulebook as pageRulebook, hashOf, readLog as pageReadLog } from "../site/chain.js";
import { BUYING_HOOKS, ruleOf } from "../site/hooks.js";
import { readLedger } from "../site/ledger.js";
import { ANNOUNCEMENT_MAX, announced, edictTransaction, MEMO_PROGRAM, MEMO_UNITS, memoUnits, mendLog, noteOf, readLog, runOnce, TRANSACTION_MAX, waitingPath, watch, type Context, type Decide, type LogEntry } from "../src/agent.js";
import { decodeRulebook, MAX_CONDITIONS, RULEBOOK_LEN, rulebookAddress, type Condition, type Limits, type Split } from "../src/hook.js";
import { AlreadyRunning, type KeeperContext, type KeeperOutcome } from "../src/keeper/index.js";
import { launch } from "../src/launch.js";
import { inPublic, main, plain, serve, type Service } from "./serve.js";
import { byRote } from "./stand-in.js";

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// ---------------------------------------------------------------------------------------------
// The service as a process, for the checks to signal and kill.
// ---------------------------------------------------------------------------------------------

if (process.argv.includes("--service")) {
  const number = (name: string) => Number(process.env[name] || 0);
  const rote = byRote({ minutes: number("CHECK_EDICT_MINUTES") || 0.25, keepName: true });
  const decide: Decide = async (snapshot, book) => {
    console.log("check: a look is in hand");
    // A model takes its time. Here it gives the check the time to send its signal in the middle of a look.
    if (number("CHECK_SLOW_MS")) await sleep(number("CHECK_SLOW_MS"));
    return rote(snapshot, book);
  };
  // With no chain to work on, the keeper's round is a step that takes a while and leaves a mark when it is done.
  const round = async (ctx: KeeperContext): Promise<KeeperOutcome> => {
    console.log("check: a step is in hand");
    await sleep(number("CHECK_SLOW_MS"));
    writeFileSync(join(ctx.dir, "..", "step-finished"), new Date().toISOString());
    return { status: "settled", did: ["a step"] };
  };

  let connection: Connection | undefined;
  let dying = false;
  if (process.env.RPC_URL && !process.env.CHECK_NO_CHAIN) {
    connection = new Connection(process.env.RPC_URL, "confirmed");
    // Told to, the process dies the moment the agent has sent its next edict and starts to wait
    // for it: the transaction is on its way and the log has not been written. Only the agent asks
    // for a confirmation this way.
    const confirm = connection.confirmTransaction.bind(connection) as (...args: unknown[]) => Promise<unknown>;
    connection.confirmTransaction = ((...args: unknown[]) => {
      if (dying) process.kill(process.pid, "SIGKILL");
      return confirm(...args);
    }) as typeof connection.confirmTransaction;
  }
  process.on("message", (message) => {
    if (message === "die at the next edict") dying = true;
    // Windows has no signals to send a process: there the check asks for this one over the pipe,
    // and the handler the service installed for it runs all the same.
    if (message === "SIGTERM") process.emit("SIGTERM", "SIGTERM");
  });
  await main({ decide, connection, ...(process.env.CHECK_NO_CHAIN ? { round } : {}) });
  // The service ends the process itself, when it is stopped.
  await new Promise(() => {});
}

// ---------------------------------------------------------------------------------------------
// What every check shares
// ---------------------------------------------------------------------------------------------

let passed = 0;
let failures = 0;
function check(ok: unknown, what: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (ok) passed++;
  else failures++;
}

/** Waits until `done` says so, looking four times a second, and checks that it did. */
async function until(what: string, done: () => unknown, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds * 4 && !(await done()); i++) await sleep(250);
  const ok = Boolean(await done());
  check(ok, what);
  return ok;
}

/** A data folder for one service, gone again when the checks end. */
const folders: string[] = [];
const folder = () => {
  folders.push(mkdtempSync(join(tmpdir(), "veluno-serve-")));
  return folders.at(-1)!;
};
process.on("exit", () => {
  for (const made of folders) rmSync(made, { recursive: true, force: true });
});
const keyJson = (keypair: Keypair) => JSON.stringify(Array.from(keypair.secretKey));
const address = () => Keypair.generate().publicKey.toBase58();
const SITE = "https://www.veluno.li";

/** A port nobody is listening on. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((listening) => probe.listen(0, listening));
  const { port } = probe.address() as { port: number };
  await new Promise((closed) => probe.close(closed));
  return port;
}

/** A GET of a path exactly as written: `fetch` would tidy the dots away before sending it. */
const rawStatus = (port: number, path: string) =>
  new Promise<number>((done, failed) => {
    httpRequest({ host: "127.0.0.1", port, path }, (response) => {
      response.resume();
      done(response.statusCode ?? 0);
    }).on("error", failed).end();
  });

type Health = {
  ok: boolean;
  problems: string[];
  dryRun: boolean;
  agent: { on: boolean; address: string | null; last: string | null; errorsInARow: number; lastError: string | null; lastEdictAt: string | null; withoutText: number[] };
  keeper: { on: boolean; address: string | null; last: string | null; saying: string | null; errorsInARow: number };
  records: { log: { bytes: number }; ledger: { bytes: number }; ledgerHead: { bytes: number } };
};
const healthOf = async (port: number) => {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  return { status: response.status, body: (await response.json()) as Health };
};

/** Node, with tsx to read TypeScript, on this file as the service. One process: a signal to it is a signal to the service. */
function startService(env: Record<string, string>, cwd: string): { child: ChildProcess; lines: string[]; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  const lines: string[] = [];
  // It runs from its own data folder, where there is no .env for the service to pick up.
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(import.meta.url), "--service"], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  for (const stream of [child.stdout!, child.stderr!]) {
    let rest = "";
    stream.setEncoding("utf8").on("data", (text: string) => {
      const whole = (rest + text).split("\n");
      rest = whole.pop() ?? "";
      lines.push(...whole.filter(Boolean));
    });
  }
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => child.on("exit", (code, signal) => done({ code, signal })));
  return { child, lines, exited };
}

/** The host's signal to stop. Where there are no signals to send, the service is asked over the pipe to raise it in itself. */
function signalToStop(child: ChildProcess) {
  if (process.platform === "win32") child.send("SIGTERM");
  else child.kill("SIGTERM");
}

/** scripts/guardian.ts as the owner runs it, from `cwd`: its exit code and everything it printed. */
const guardianCommand = (cwd: string, ...args: string[]) =>
  new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("guardian.ts", import.meta.url)), ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    for (const stream of [child.stdout!, child.stderr!]) stream.setEncoding("utf8").on("data", (text: string) => void (out += text));
    child.on("exit", (code) => done({ code, out }));
  });

// ---------------------------------------------------------------------------------------------
// A chain in memory: one rulebook, laid out as src/hook.ts decodes it, a clock and a block height.
// ---------------------------------------------------------------------------------------------

function madeUpChain() {
  const agent = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const hookProgram = Keypair.generate().publicKey;
  const book = Buffer.alloc(RULEBOOK_LEN);
  book[0] = 4;
  mint.toBuffer().copy(book, 8);
  agent.publicKey.toBuffer().copy(book, 72);
  book.writeUInt32LE(0, 200); // no wait between edicts
  book.writeUInt32LE(7_200, 204);
  book.writeUInt16LE(5_000, 208);
  book.writeUInt32LE(86_400, 210);
  book.writeUInt16LE(4_000, 214);
  book.writeUInt16LE(3_000, 224);
  book.writeUInt16LE(3_000, 226);
  book.writeUInt16LE(4_000, 228);
  book[481] = 1;
  book.write("Veluno", 512);
  book.write("VELUNO", 512 + 32);

  const chain = {
    agent, mint, hookProgram, book,
    clock: 1_800_000_000,
    height: 1_000,
    /**
     * What becomes of the next transaction the agent sends. "unseen": it lands and its
     * confirmation times out. "unseen, node quiet": the same, and the node does not answer the
     * next read either. "lost": it is taken and never lands. "refused": the node turns it away.
     */
    next: "lands" as "lands" | "unseen" | "unseen, node quiet" | "lost" | "refused",
    /** How many of the next reads of the rulebook fail. */
    quietReads: 0,
    /** The signatures of the transactions the node was sent, as the page's own code writes them. */
    sent: [] as string[],
    /** What each of them carried as its memo, by signature: the text, and the keys the memo made sign. */
    memos: new Map<string, { text: string; signers: string[] }>(),
    /** Called as a transaction arrives, before anything is done with it. */
    onSend: undefined as (() => void) | undefined,
    note: () => book.subarray(248, 280).toString("hex"),
    epoch: () => Number(book.readBigUInt64LE(232)),
    /** What the program does with an edict: the term, the shares, the count, the hash and the time. */
    land(data: Buffer) {
      if (data[0] !== 1) throw new Error("the agent only ever sends edicts here");
      const count = data[11];
      book.writeBigInt64LE(BigInt(chain.clock + data.readUInt32LE(1)), 216);
      data.copy(book, 224, 5, 11);
      book.writeBigUInt64LE(book.readBigUInt64LE(232) + 1n, 232);
      book.writeBigInt64LE(BigInt(chain.clock), 240);
      data.copy(book, 248, 12 + count * 12, 12 + count * 12 + 32);
      book[280] = count;
      data.copy(book, 288, 12, 12 + count * 12);
    },
    /** An edict nobody here wrote: the same key, used somewhere else. */
    landForeign() {
      chain.land(Buffer.concat([Buffer.from([1]), Buffer.from([8, 7, 0, 0]), book.subarray(224, 230), Buffer.from([0]), Buffer.alloc(32, 9)]));
    },
  };

  const timedOut = () => new Error("Transaction was not confirmed in 30.00 seconds. It is unknown if it succeeded or failed. Asked https://rpc.example/?api-key=SECRET");
  const connection = {
    getAccountInfo: async () => {
      if (chain.quietReads > 0) {
        chain.quietReads--;
        throw new Error("fetch failed: https://rpc.example/?api-key=SECRET");
      }
      return { data: Buffer.from(book) };
    },
    getSlot: async () => 1,
    getBlockTime: async () => chain.clock,
    getBlockHeight: async () => chain.height,
    getSignaturesForAddress: async () => [],
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: chain.height + 150 }),
    sendRawTransaction: async (raw: Buffer) => {
      chain.onSend?.();
      const tx = Transaction.from(raw);
      if (chain.next === "refused") {
        chain.next = "lands";
        throw new SendTransactionError({ action: "simulate", signature: "", transactionMessage: "Transaction simulation failed: custom program error: 0xd", logs: [] });
      }
      chain.sent.push(base58(tx.signature!));
      const memo = tx.instructions.find((instruction) => instruction.programId.equals(MEMO_PROGRAM));
      if (memo) chain.memos.set(chain.sent.at(-1)!, { text: memo.data.toString("utf8"), signers: memo.keys.filter((key) => key.isSigner).map((key) => key.pubkey.toBase58()) });
      // The edict comes first in its transaction, whatever follows it.
      if (chain.next !== "lost") chain.land(tx.instructions[0].data);
      return chain.sent.at(-1)!;
    },
    confirmTransaction: async () => {
      const became = chain.next;
      chain.next = "lands";
      if (became === "unseen, node quiet") chain.quietReads = 1;
      if (became !== "lands") throw timedOut();
      return { value: { err: null } };
    },
  } as unknown as Connection;
  const dbc = {
    state: {
      getPool: async () => ({ poolState: { sqrtPrice: new BN("3193183669000000"), quoteReserve: new BN(0), baseReserve: new BN("1000000000000000") } }),
      getPoolFeeMetrics: async () => ({ total: { totalTradingQuoteFee: new BN(0) } }),
    },
  } as unknown as DynamicBondingCurveClient;
  return Object.assign(chain, { connection, dbc });
}

// ---------------------------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------------------------

async function offline() {
  const said: string[] = [];
  const print = (line: string) => void said.push(line);
  const off = { AGENT_OFF: "1", KEEPER_OFF: "1" };

  console.log("the records over HTTP");
  const dirA = folder();
  const a = await serve({ env: { DATA_DIR: dirA, PORT: "0", ...off }, print });
  const at = (path: string) => `http://127.0.0.1:${a.port}${path}`;
  const logPath = join(dirA, "agent-log.jsonl");
  const ledgerPath = join(dirA, "keeper", "public", "ledger.jsonl");
  const headPath = join(dirA, "keeper", "public", "ledger-head.json");

  let response = await fetch(at("/log.jsonl"), { headers: { origin: SITE } });
  check(response.status === 200 && (await response.text()) === "", "a log not written yet is an empty record, not a 404");
  check(response.headers.get("access-control-allow-origin") === SITE, "www.veluno.li may read it");
  check(response.headers.get("content-type") === "application/x-ndjson; charset=utf-8" && response.headers.get("cache-control") === "no-cache" && response.headers.get("cdn-cache-control") === "max-age=5" && response.headers.get("x-content-type-options") === "nosniff", "it says what it is and how long it may be kept");

  const lines = Array.from({ length: 150 }, (_, i) => JSON.stringify({ n: i, text: "x".repeat(40) }));
  writeFileSync(logPath, `${lines.join("\n")}\n{"half":`);
  response = await fetch(at("/log.jsonl"), { headers: { origin: "https://veluno.li" } });
  const whole = await response.text();
  check(whole === `${lines.join("\n")}\n`, "a line still being written is left out");
  check(response.headers.get("access-control-allow-origin") === "https://veluno.li", "veluno.li may read it");
  const etag = response.headers.get("etag")!;

  response = await fetch(at("/log.jsonl"), { headers: { origin: "https://elsewhere.example" } });
  check(response.status === 200 && response.headers.get("access-control-allow-origin") === null, "another site's page is not told it may read it");
  await response.arrayBuffer();

  response = await fetch(at("/log.jsonl"), { headers: { "if-none-match": etag } });
  check(response.status === 304 && (await response.text()) === "", "an unchanged log is answered with 304 and no body");

  // Node's fetch asks for gzip and unpacks it; the header says whether it was packed.
  response = await fetch(at("/log.jsonl"));
  check(response.headers.get("content-encoding") === "gzip" && (await response.text()) === whole, "it travels compressed");

  response = await fetch(at("/log.jsonl?tail=7"));
  const tail = (await response.text()).split("\n").filter(Boolean);
  check(tail.length === 100 && tail[0] === lines[50] && tail[99] === lines[149], "?tail=7 is rounded up to the last 100 lines");

  appendFileSync(logPath, `1}\n`);
  response = await fetch(at("/log.jsonl"), { headers: { "if-none-match": etag } });
  check(response.status === 200 && (await response.text()).endsWith(`{"half":1}\n`), "a log that grew is sent again");

  response = await fetch(at("/log.jsonl"), { method: "HEAD" });
  check(response.status === 200 && response.headers.get("etag") !== etag && (await response.text()) === "", "HEAD gets the headers and no body");

  response = await fetch(at("/ledger.jsonl"), { headers: { origin: SITE } });
  check(response.status === 200 && (await response.text()) === "" && response.headers.get("access-control-allow-origin") === SITE, "the ledger is served the same way, empty before the keeper has written");
  mkdirSync(join(dirA, "keeper", "public"), { recursive: true });
  mkdirSync(join(dirA, "keeper", "private"), { recursive: true });
  writeFileSync(ledgerPath, `{"seq":1}\n{"seq":2}\n`);
  response = await fetch(at("/ledger.jsonl?tail=1"));
  check((await response.text()) === `{"seq":1}\n{"seq":2}\n` && response.headers.get("content-type") === "application/x-ndjson; charset=utf-8", "and from the keeper's own folder once it has");

  check((await readLedger(at("/ledger-head.json"))) === false, "a head not written yet is an empty answer, which the page reads as a keeper that has not run");
  response = await fetch(at("/ledger-head.json"), { headers: { origin: "https://elsewhere.example" } });
  check(response.status === 200 && (await response.text()) === "" && response.headers.get("access-control-allow-origin") === null, "and it is 200, so that a browser logs nothing");
  const totals = { claimed: "2000000000", fees: "70000", treasury: { paid: "800000000", owed: "0" }, burn: { spent: "504000000", tokens: "1931442000000", owed: "96000000" }, holders: { paid: "570866148", owed: "29133852" } };
  const headOf = (seq: number) => JSON.stringify({ v: 1, mint: address(), keeper: address(), seq, at: "2026-10-07T12:00:00.000Z", last: "00", totals, recent: [{ v: 1, seq, at: "2026-10-07T12:00:00.000Z", prev: "00", totals, kind: "note", text: "a line" }] });
  writeFileSync(headPath, headOf(41));
  response = await fetch(at("/ledger-head.json"), { headers: { origin: SITE } });
  const headTag = response.headers.get("etag")!;
  check(response.headers.get("content-type") === "application/json; charset=utf-8" && response.headers.get("cache-control") === "no-cache" && response.headers.get("cdn-cache-control") === "max-age=5" && response.headers.get("access-control-allow-origin") === SITE, "the head is served as JSON, with the same care");
  await response.arrayBuffer();
  const page = await readLedger(at("/ledger-head.json"));
  check(page && page.seq === 41 && page.recent.length === 1 && page.totals.claimed === "2000000000", "the page's own reader takes it");
  response = await fetch(at("/ledger-head.json"), { headers: { "if-none-match": headTag } });
  check(response.status === 304, "an unchanged head is a 304");
  // The same length, written within the same moment: only what is in it tells the two apart.
  writeFileSync(headPath, headOf(42));
  response = await fetch(at("/ledger-head.json"), { headers: { "if-none-match": headTag } });
  check(response.status === 200 && ((await response.json()) as { seq: number }).seq === 42, "a head that was replaced is sent again, whatever its size and time");

  let health = await healthOf(a.port);
  check(health.status === 200 && health.body.ok && !health.body.agent.on && !health.body.keeper.on && health.body.records.log.bytes > 0 && health.body.records.ledgerHead.bytes > 0, "/health answers 200 with both loops off, and says how large the records are");

  writeFileSync(join(dirA, "keeper", "private", "books.json"), `{"secret":"what each holder is owed"}`);
  writeFileSync(waitingPath(logPath), "{}");
  for (const path of ["/agent-log.jsonl", "/agent-log.jsonl.pending", "/log.jsonl.pending", "/service.lock", "/keeper/private/books.json", "/private/books.json", "/books.json", "/.env", "/..%2f..%2fpackage.json", "/log.jsonl/../../package.json", "/ledger-head.json/../private/books.json", "/ledger-head.json/../../private/books.json"]) {
    check((await rawStatus(a.port, path)) === 404, `${path} is not served`);
  }
  rmSync(waitingPath(logPath));
  response = await fetch(at("/log.jsonl"), { method: "POST", body: "{}" });
  await response.arrayBuffer();
  check(response.status === 405, "nothing can be written over HTTP");
  response = await fetch(at("/ledger-head.json"), { method: "OPTIONS", headers: { origin: SITE } });
  check(response.status === 204 && response.headers.get("access-control-allow-methods") === "GET, HEAD" && response.headers.get("access-control-allow-origin") === SITE, "a browser that asks first is told what it may do");

  // -------------------------------------------------------------------------------------------
  console.log("an edict's words, never lost (the agent's own code, on a chain in memory)");

  const chain = madeUpChain();
  writeFileSync(logPath, "");
  let asked = 0;
  const rote = byRote({ minutes: 30, keepName: true });
  const ctx: Context = { connection: chain.connection, dbc: chain.dbc, hookProgram: chain.hookProgram, mint: chain.mint, pool: Keypair.generate().publicKey, agent: chain.agent, logPath, decide: (snapshot, book) => (asked++, rote(snapshot, book)) };
  const waits = () => existsSync(waitingPath(logPath));
  const failure = (running: Promise<unknown>) => running.then(() => null, (error: Error) => error);

  let kept = "";
  chain.onSend = () => void (kept = readFileSync(waitingPath(logPath), "utf8"));
  let outcome = await runOnce(ctx);
  let log = readLog(logPath);
  check(outcome.status === "rewritten" && log.length === 1 && log[0].note === chain.note(), "an edict goes out, and the log has it under the hash the chain holds");
  check(outcome.status === "rewritten" && outcome.signature === chain.sent[0] && log[0].signature === chain.sent[0], "with the signature of the transaction that carried it, known before it was sent");
  check(kept !== "" && JSON.stringify(JSON.parse(kept).line) === JSON.stringify(log[0]) && !waits(), "the very line was on disk before the transaction left, and nothing waits once the log has it");
  const carried = chain.memos.get(chain.sent[0]);
  check(carried?.text === log[0].record.announcement && carried?.signers.join() === chain.agent.publicKey.toBase58() && !("memo" in log[0].record), "its transaction carries the announcement as a memo the agent signed, word for word, so the record has nothing to add about it");

  chain.clock += 1_900;
  chain.next = "unseen";
  outcome = await runOnce(ctx);
  log = readLog(logPath);
  check(outcome.status === "rewritten" && log.length === 2 && log[1].note === chain.note() && !waits(), "an edict lands and its confirmation times out: the rulebook is asked, and the text is written all the same");

  // Exactly the case: the transaction lands, its confirmation throws, and nothing more is heard of the chain.
  chain.clock += 1_900;
  chain.next = "unseen, node quiet";
  const lostSight = await failure(runOnce(ctx));
  check(lostSight && chain.epoch() === 3 && readLog(logPath).length === 2, "an edict lands, its confirmation throws and the node goes quiet: the edict is on chain and the log misses it");
  check(waits() && JSON.parse(readFileSync(waitingPath(logPath), "utf8")).line.note === chain.note(), "its line is on disk, under the hash the chain holds");
  // Two calls at the same moment, as a poll and a restart could be. The edict has time left, so neither decides anything.
  const [one, two] = await Promise.all([runOnce(ctx, { letRuleRun: true }), runOnce(ctx, { letRuleRun: true })]);
  log = readLog(logPath);
  check(one.status === "in-force" && two.status === "in-force" && log.length === 3, "the next call puts the text back, and two calls at once put it back once");
  check(log[2].note === chain.note() && noteOf(log[2].record).toString("hex") === chain.note() && log[2].signature === chain.sent[2] && log[2].record.epoch === 3, "under the hash the chain holds, with its transaction");
  await runOnce(ctx, { letRuleRun: true });
  check(readLog(logPath).length === 3 && !waits() && mendLog(ctx, decodeRulebook(chain.book)) === "whole", "and it is done once");

  // A process that dies after writing the log and before clearing the line that waited.
  chain.clock += 1_900;
  outcome = await runOnce(ctx);
  writeFileSync(waitingPath(logPath), kept);
  check(outcome.status === "rewritten" && mendLog(ctx, decodeRulebook(chain.book)) === "whole" && readLog(logPath).length === 4 && !waits(), "a line that waits for an edict the log already has is not written twice");

  // A transaction that is taken and never lands.
  chain.clock += 1_900;
  chain.next = "lost";
  asked = 0;
  const lost = await failure(runOnce(ctx));
  check(lost && chain.epoch() === 4 && readLog(logPath).length === 4 && waits(), "an edict that is sent and never lands leaves its line waiting, and the log as it was");
  const early = await runOnce(ctx);
  check(early.status === "too-soon" && early.seconds > 0 && asked === 1, "while it still could land nothing new is decided, and the model is not asked again");
  chain.height += 200;
  outcome = await runOnce(ctx);
  log = readLog(logPath);
  check(outcome.status === "rewritten" && chain.epoch() === 5 && log.length === 5 && log[4].note === chain.note() && !waits(), "once it no longer can, its line is dropped and the agent goes on");

  chain.clock += 1_900;
  chain.next = "refused";
  const refused = await failure(runOnce(ctx));
  check(refused instanceof SendTransactionError && !waits() && readLog(logPath).length === 5 && chain.epoch() === 5, "an edict the node turns away leaves nothing waiting");

  // A crash in the middle of writing a line of the log.
  appendFileSync(logPath, `{"record":{"mint":"cut sho`);
  outcome = await runOnce(ctx);
  log = readLog(logPath);
  const written = readFileSync(logPath, "utf8");
  check(outcome.status === "rewritten" && log.length === 6 && log[5].note === chain.note() && written.includes(`{"record":{"mint":"cut sho\n{`) && written.endsWith("}\n"), "a line a crash cut short is closed off and passed over; the next one starts on a line of its own");

  const fromPage = await pageReadLog(at("/log.jsonl"));
  check(fromPage?.length === 6 && (await hashOf(fromPage[5].record)) === chain.note() && (await hashOf(fromPage[2].record)) === log[2].note, "the page reads the log from the service and finds its texts sound, the one put back among them");

  chain.clock += 1_900;
  chain.landForeign();
  check(mendLog(ctx, decodeRulebook(chain.book)) === "missing" && readLog(logPath).length === 6, "an edict written elsewhere with the same key is noticed, and nothing is made up for it");
  outcome = await runOnce(ctx);
  log = readLog(logPath);
  check(outcome.status === "rewritten" && log.length === 7 && log[6].record.epoch === 8 && chain.epoch() === 8, "the agent goes on from there");

  // The loop itself, asked to stop in the middle of a look, with its next poll half a minute away.
  chain.clock += 1_900;
  const halt = new AbortController();
  const began = Date.now();
  await watch({ ...ctx, decide: async (snapshot, book) => { setTimeout(() => halt.abort(), 50); await sleep(400); return rote(snapshot, book); } }, { pollSecs: 30, thinkEverySecs: 30, signal: halt.signal });
  check(Date.now() - began < 5_000 && chain.epoch() === 9 && readLog(logPath).length === 8 && readLog(logPath)[7].note === chain.note(), "the agent's loop, asked to stop in the middle of a look, finishes the look and leaves without waiting for its next poll");
  check(readLog(logPath).every((entry) => chain.memos.get(entry.signature ?? "")?.text === entry.record.announcement), "every edict in the log went out with its announcement as its memo, the ones whose text had to be put back among them");

  check(plain(new Error("failed: https://rpc.example/v2/SECRET?api-key=SECRET\nmore")) === "failed: https://rpc.example" && inPublic(new TypeError("fetch failed at https://rpc.example/SECRET")) === "TypeError" && inPublic(new Error("refused: x-api-key: SECRET")) === "Error" && inPublic(new Error("my books say I hold 5 lamports")) === "my books say I hold 5 lamports", "an error is printed with any address cut to its host, and shown to the public only if it has neither an address nor a key in it");

  // -------------------------------------------------------------------------------------------
  console.log("an edict's words, in its transaction (the agent's own code; each transaction is signed and serialised as it would be sent)");

  const scribe = Keypair.generate();
  const [aProgram, aMint] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  // The largest transaction the agent writes: the catalogue's longest rule, and a change of
  // name that has to top the mint up first.
  const longest = BUYING_HOOKS.flatMap((hook) => hook.settings.map((_, i) => ruleOf(hook.id, i + 1))).reduce((a, b) => (b.length > a.length ? b : a));
  /** An edict's transaction for these words, as the node would be sent it, and what is found in those bytes. */
  function carrying(announcement: string, rule: Condition[] = longest) {
    const change = { ruleSecs: 3_600, rule, holdersBps: 3_000, burnBps: 3_000, treasuryBps: 4_000 };
    const record: LogEntry["record"] = {
      mint: aMint.toBase58(), epoch: 1, at: "2026-10-08T12:00:00.000Z", action: "rewrite", hooks: { buying: null, fees: "even-split", name: 1 },
      change: { ...change, rule: rule.map((condition) => ({ ...condition, value: condition.value.toString() })) }, announcement, reasoning: "Scripted.", model: "stand-in",
    };
    const made = edictTransaction({ program: aProgram, agent: scribe.publicKey, mint: aMint, change, rename: { index: 1, lamports: 1_000_000 }, record });
    made.tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    made.tx.sign(scribe);
    const wire = made.tx.serialize();
    const sent = Transaction.from(wire);
    const memo = sent.instructions.find((instruction) => instruction.programId.equals(MEMO_PROGRAM));
    return {
      record: made.record,
      bytes: wire.length,
      to: sent.instructions.map((instruction) => instruction.programId.toBase58()),
      noted: sent.instructions[0].data.subarray(-32).equals(made.note) && made.note.equals(noteOf(made.record)),
      memo: memo ? memo.data.toString("utf8") : null,
      signedByAgent: memo?.keys.length === 1 && memo.keys[0].isSigner && memo.keys[0].pubkey.equals(scribe.publicKey),
    };
  }
  /** Whether `memo` is `text` cut after a whole word and closed with an ellipsis, with no room for the word after. */
  const cutAtAWord = (memo: string | null, text: string, fits: (longer: string) => boolean) => {
    if (!memo?.endsWith("…")) return false;
    const kept = memo.slice(0, -1);
    const next = text.slice(kept.length).match(/^[\s.,;:…–—-]*\S+/u);
    return text.startsWith(kept) && /^[\s.,;:…–—-]*\s/u.test(text.slice(kept.length)) && !!next && !fits(`${kept}${next[0]}…`);
  };
  const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");

  const plainWords = "Plain words, and nothing else. ".repeat(8).slice(0, ANNOUNCEMENT_MAX);
  const inPlain = carrying(plainWords);
  check(inPlain.memo === plainWords && inPlain.signedByAgent && !("memo" in inPlain.record) && inPlain.noted, `an announcement in plain letters, all ${ANNOUNCEMENT_MAX} characters of it, is the memo byte for byte, the agent signs it, and the note is the hash of a record that has nothing to add`);
  check(inPlain.to.join() === [aProgram, PublicKey.default, aProgram, MEMO_PROGRAM].map((program) => program.toBase58()).join(), "the edict comes first, then the top-up and the change of name, and the words last");
  const withoutWords = inPlain.bytes - bytesOf(plainWords);
  const room = TRANSACTION_MAX - withoutWords;
  check(room >= 3 * ANNOUNCEMENT_MAX, `the largest transaction the agent writes (a rule of ${longest.length} conditions, the catalogue's longest, and a change of name that tops the mint up) is ${withoutWords} bytes before the memo's text, which leaves the text ${room}: more than the ${3 * ANNOUNCEMENT_MAX} that ${ANNOUNCEMENT_MAX} characters can come to`);

  // Signs that are not plain letters, of the kinds a sentence in English might have.
  const typeset = "Slow Opening is on — for the first 10 minutes no wallet can buy above 2% of supply — then “the cap” lifts. Fees: Holders’ Payday · holders 42% · burn 18% · treasury 40%. It’s on for 30 min → selling isn’t restricted … ‘ever’ – é ü ✓ So far.";
  const inType = carrying(typeset);
  check(typeset.length === ANNOUNCEMENT_MAX && inType.memo === typeset && !("memo" in inType.record) && inType.bytes <= TRANSACTION_MAX, `${ANNOUNCEMENT_MAX} characters with curly quotes, long dashes and accents among them go whole too (${bytesOf(typeset)} bytes of text, reckoned at ${memoUnits(typeset)} units of the ${MEMO_UNITS} a memo may cost, a transaction of ${inType.bytes} bytes)`);
  // The rarer Chinese characters take four bytes each and are cheap to the Memo program: nothing that goes whole weighs more.
  const heavy = "\u{20000}".repeat(ANNOUNCEMENT_MAX / 2);
  const inHeavy = carrying(heavy);
  check(heavy.length === ANNOUNCEMENT_MAX && inHeavy.memo === heavy && !("memo" in inHeavy.record) && inHeavy.bytes <= TRANSACTION_MAX && inHeavy.bytes > inType.bytes, `and so do the heaviest ${ANNOUNCEMENT_MAX} characters that the Memo program can afford (${bytesOf(heavy)} bytes of text, a transaction of ${inHeavy.bytes} bytes, under the ${TRANSACTION_MAX} a transaction may be)`);

  const affordable = (text: string) => memoUnits(text) <= MEMO_UNITS;
  const tooDear = "“Slow” — “steady” — “small” … ".repeat(8).slice(0, ANNOUNCEMENT_MAX);
  const inDear = carrying(tooDear);
  check(memoUnits(tooDear) > MEMO_UNITS && inDear.memo !== null && affordable(inDear.memo) && cutAtAWord(inDear.memo, tooDear, affordable), `words the Memo program could not afford (reckoned at ${memoUnits(tooDear)} units) are cut after a whole word and closed with an ellipsis: ${inDear.memo?.length} of ${tooDear.length} characters, reckoned at ${memoUnits(inDear.memo ?? "")}`);
  check(inDear.record.memo === inDear.memo && inDear.record.announcement === tooDear && inDear.noted && inDear.signedByAgent, "the record then says what the memo was, next to the announcement whole, and the note is the hash of both");
  const allSigns = carrying("€".repeat(ANNOUNCEMENT_MAX));
  const allFaces = carrying("\u{1f642}".repeat(ANNOUNCEMENT_MAX / 2));
  check(/^€+…$/u.test(allSigns.memo ?? "") && affordable(allSigns.memo!) && !affordable(`€${allSigns.memo}`), `words with no space to cut at are cut where they have to be (${allSigns.memo?.length} characters of ${ANNOUNCEMENT_MAX})`);
  check(/^\u{1f642}+…$/u.test(allFaces.memo ?? "") && affordable(allFaces.memo!) && !affordable(`\u{1f642}${allFaces.memo}`), `and never through the middle of a character that takes two units (${[...(allFaces.memo ?? "")].length - 1} emoji of ${ANNOUNCEMENT_MAX / 2})`);

  // What the model is told about it: twenty curly quotes and dashes, or a dozen emoji, in an announcement of full length.
  const among = (sign: string, count: number) => `${`${sign} `.repeat(count)}${"Plain words, and nothing else. ".repeat(8)}`.slice(0, ANNOUNCEMENT_MAX);
  check(affordable(among("—", 20)) && !affordable(among("—", 30)) && affordable(among("\u{1f642}", 12)) && !affordable(among("\u{1f642}", 13)) && carrying(among("\u{1f642}", 12)).memo === among("\u{1f642}", 12), `which is what the model is told: among plain words to the full ${ANNOUNCEMENT_MAX} characters, twenty long dashes go whole (${memoUnits(among("—", 20))} units) and so do a dozen emoji (${memoUnits(among("\u{1f642}", 12))}), and a thirteenth is one too many`);

  // A decision that did not pass through the limit on an announcement could be longer than a transaction has room for.
  const tooLong = "Plain words, and nothing else. ".repeat(29).trim();
  const inLong = carrying(tooLong);
  const hasRoom = (text: string) => bytesOf(text) <= room;
  check(affordable(tooLong) && bytesOf(tooLong) > room && inLong.bytes <= TRANSACTION_MAX && inLong.bytes > TRANSACTION_MAX - 12 && cutAtAWord(inLong.memo, tooLong, hasRoom) && inLong.record.memo === inLong.memo, `words too long for the transaction (${bytesOf(tooLong)} bytes) are cut the same way, to a transaction of ${inLong.bytes} bytes`);
  const fullRule = carrying(plainWords, Array.from({ length: MAX_CONDITIONS }, () => ({ group: 0, fact: 0, op: 0, value: 1n })));
  check(fullRule.memo === plainWords && fullRule.bytes - bytesOf(plainWords) > withoutWords, `a rule of ${MAX_CONDITIONS} conditions, the most the program takes, still leaves the text ${TRANSACTION_MAX - (fullRule.bytes - bytesOf(plainWords))} bytes`);

  const withinLimit = (text: string) => text.length <= ANNOUNCEMENT_MAX;
  const wordy = "Slow Opening is on. For the first 10 minutes no wallet can buy above 2% of supply, then the cap lifts. ".repeat(4);
  const ranOver = announced(wordy);
  check(announced(plainWords) === plainWords && announced(typeset) === typeset && cutAtAWord(ranOver, wordy, withinLimit), `an announcement within ${ANNOUNCEMENT_MAX} characters is left as it is, and one that ran over is cut after a whole word (${ranOver.length} characters of ${wordy.length})`);
  // Half of a surrogate pair by itself, and a whole pair that the limit falls in the middle of.
  const halved = announced("half \ud83d of a pair");
  const astride = announced(`${"x".repeat(ANNOUNCEMENT_MAX - 1)}\u{1f642}`);
  check(halved === `half ${String.fromCodePoint(0xfffd)} of a pair` && astride === `${"x".repeat(ANNOUNCEMENT_MAX - 1)}…` && [halved, astride].every((text) => Buffer.from(text, "utf8").toString("utf8") === text), "half a surrogate pair, which UTF-8 cannot carry, never gets into the record: the memo could not be the record's words otherwise");

  // The same through a whole look, on a chain in memory.
  const inked = madeUpChain();
  const inkedLog = join(folder(), "agent-log.jsonl");
  const scripted = byRote({ minutes: 30, keepName: true });
  const saying = (announcement: string): Context => ({ connection: inked.connection, dbc: inked.dbc, hookProgram: inked.hookProgram, mint: inked.mint, pool: Keypair.generate().publicKey, agent: inked.agent, logPath: inkedLog, decide: async (snapshot, book) => ({ ...(await scripted(snapshot, book)), announcement }) });
  outcome = await runOnce(saying(tooDear));
  let penned = readLog(inkedLog)[0];
  check(outcome.status === "rewritten" && outcome.memo === inDear.memo && penned.record.memo === inDear.memo && penned.record.announcement === tooDear && inked.memos.get(penned.signature!)?.text === inDear.memo, "a look whose words are too dear sends the cut memo, and its line in the log says what the memo was");
  check(penned.note === inked.note() && (await hashOf(penned.record)) === inked.note(), "the note on chain is the hash of that record, and the page's own code finds it sound");
  inked.clock += 1_900;
  const overLimit = `${plainWords} And more words than an announcement may have.`;
  outcome = await runOnce(saying(overLimit));
  penned = readLog(inkedLog)[1];
  check(outcome.status === "rewritten" && outcome.memo === undefined && outcome.announcement === penned.record.announcement && cutAtAWord(penned.record.announcement ?? null, overLimit, withinLimit) && inked.memos.get(penned.signature!)?.text === penned.record.announcement && !("memo" in penned.record), "a look whose words ran over the limit has them cut in the record itself, and the memo is the record's words again");

  // -------------------------------------------------------------------------------------------
  console.log("a disk that comes up empty");

  const dirG = folder();
  const g = await serve({ env: { DATA_DIR: dirG, PORT: "0", RESTORE_FROM: `http://127.0.0.1:${a.port}/`, ...off }, print });
  check(readFileSync(join(dirG, "agent-log.jsonl"), "utf8") === readFileSync(logPath, "utf8") && readFileSync(join(dirG, "keeper", "public", "ledger.jsonl"), "utf8") === readFileSync(ledgerPath, "utf8"), "the log and the ledger are fetched back from their copies before anything else");
  await g.stop();
  const dirH = folder();
  const h = await serve({ env: { DATA_DIR: dirH, PORT: "0", RESTORE_FROM: `http://127.0.0.1:${await freePort()}`, KEEPER_OFF: "1", RPC_URL: "http://127.0.0.1:9", HOOK_PROGRAM: address(), MINT: address(), POOL: address(), AGENT_KEYPAIR_JSON: keyJson(Keypair.generate()) }, decide: rote, print });
  await until("with a copy that cannot be reached the agent stays off, so that it does not start a second log", async () => (await healthOf(h.port)).body.problems.some((problem) => problem.startsWith("the agent is not running")), 10);
  check(!existsSync(join(dirH, "agent-log.jsonl")), "and nothing was written");
  await h.stop();

  // -------------------------------------------------------------------------------------------
  console.log("a loop that cannot start");

  const dirB = folder();
  const b = await serve({ env: { DATA_DIR: dirB, PORT: "0" }, print });
  await until("with nothing set, both loops stay off and /health answers 503", async () => (await healthOf(b.port)).status === 503, 5);
  health = await healthOf(b.port);
  check(health.body.problems.includes("the agent is not running: RPC_URL is not set") && health.body.problems.includes("the keeper is not running: RPC_URL is not set") && !health.body.agent.on && !health.body.keeper.on, `and says why: ${health.body.problems.join("; ")}`);
  response = await fetch(`http://127.0.0.1:${b.port}/log.jsonl`);
  check(response.status === 200, "while the records are still served");
  await response.arrayBuffer();
  await b.stop();

  const where = { RPC_URL: "http://127.0.0.1:9/?api-key=SECRET", HOOK_PROGRAM: address(), MINT: address(), POOL: address(), TREASURY: address() };
  const badKey = { DATA_DIR: folder(), PORT: "0", ...where, AGENT_KEYPAIR_JSON: "[11,22,33", KEEPER_KEYPAIR_JSON: "[11,22,33]", ANTHROPIC_API_KEY: "k" } as Record<string, string>;
  const c = await serve({ env: badKey, decide: rote, print });
  await until("a key that is not a key keeps its loop off", async () => (await healthOf(c.port)).body.problems.length >= 2, 5);
  health = await healthOf(c.port);
  check(health.body.problems.some((problem) => problem.includes("AGENT_KEYPAIR_JSON is not a keypair: paste the whole content")) && health.body.problems.some((problem) => problem.includes("KEEPER_KEYPAIR_JSON is not a keypair: it has to be a list of 64 numbers")), "and what is said names the variable");
  check(!JSON.stringify(health.body).includes("11,22") && !said.some((line) => line.includes("11,22")), "never what was in it");
  await c.stop();

  const noModel = await serve({ env: { DATA_DIR: folder(), PORT: "0", ...where, KEEPER_OFF: "1", AGENT_KEYPAIR_JSON: keyJson(Keypair.generate()) }, print });
  await until("without a key for the model the agent stays off and says so", async () => (await healthOf(noModel.port)).body.problems.includes("the agent is not running: ANTHROPIC_API_KEY is not set"), 5);
  await noModel.stop();

  const taken = await serve({ env: { DATA_DIR: folder(), PORT: "0", ...where, AGENT_OFF: "1", KEEPER_KEYPAIR_JSON: keyJson(Keypair.generate()) }, round: async (keeper) => { throw new AlreadyRunning(`a keeper is already running on ${keeper.dir} (process 1)`); }, print });
  await until("a keeper that finds another one on its folder stays off and says so", async () => (await healthOf(taken.port)).body.problems.some((problem) => problem.startsWith("the keeper is not running: a keeper is already running")), 5);
  await taken.stop();

  // -------------------------------------------------------------------------------------------
  console.log("both loops, on a chain in memory");

  const dirD = folder();
  const world = madeUpChain();
  const keeperKey = Keypair.generate();
  const treasury = address();
  const envD: Record<string, string> = {
    DATA_DIR: dirD, PORT: "0", RPC_URL: "http://127.0.0.1:9/?api-key=SECRET",
    HOOK_PROGRAM: world.hookProgram.toBase58(), MINT: world.mint.toBase58(), POOL: address(), TREASURY: treasury,
    AGENT_KEYPAIR_JSON: keyJson(world.agent), KEEPER_KEYPAIR_JSON: keyJson(keeperKey),
    AGENT_POLL_SECS: "0.1", AGENT_THINK_EVERY_SECS: "0.3", KEEPER_EVERY_SECS: "0.1", KEEPER_OWN_WALLETS: `${address()}, ${address()}`, KEEPER_SETTINGS: `{"payWhenLamports":"5"}`,
  };
  const idle: KeeperOutcome = { status: "waiting", reason: "nothing is due: 0 SOL of fees wait in the pool" };
  let keeperDoes: (ctx: KeeperContext) => Promise<KeeperOutcome> = async () => idle;
  let keeperGot: KeeperContext | undefined;
  let modelTakes = 0;
  let looking = false;
  const logD = join(dirD, "agent-log.jsonl");
  const d = await serve({
    env: envD,
    connection: world.connection,
    dbc: world.dbc,
    decide: async (snapshot, book) => {
      looking = true;
      if (modelTakes) await sleep(modelTakes);
      looking = false;
      return rote(snapshot, book);
    },
    round: (keeper) => (keeperGot = keeper, keeperDoes(keeper)),
    print,
  });
  const dAt = (path: string) => `http://127.0.0.1:${d.port}${path}`;
  await until("the agent issues an edict by itself", () => readLog(logD).length === 1 && readLog(logD)[0].note === world.note(), 10);
  check(!("AGENT_KEYPAIR_JSON" in envD) && !("KEEPER_KEYPAIR_JSON" in envD) && keeperGot !== undefined, "the two keys are taken out of the environment once they have been read");
  check((await pageReadLog(dAt("/log.jsonl")))?.length === 1, "and the page can read it from the service");
  health = await healthOf(d.port);
  check(health.status === 200 && health.body.ok && health.body.agent.on && health.body.keeper.on && !health.body.dryRun, "/health is green with both loops on");
  check(health.body.agent.address === world.agent.publicKey.toBase58() && health.body.keeper.address === keeperKey.publicKey.toBase58() && health.body.agent.lastEdictAt !== null && health.body.keeper.saying === idle.reason, "and shows which keys they run with, the last edict's time and what the keeper waits for");
  check(keeperGot?.dir === join(dirD, "keeper") && keeperGot.treasury.toBase58() === treasury && keeperGot.keeper.publicKey.equals(keeperKey.publicKey) && keeperGot.signal !== undefined && keeperGot.settings?.ownWallets?.length === 2 && keeperGot.settings.payWhenLamports === 5n && keeperGot.dryRun === false, "the keeper is given its folder under the data folder, the treasury, its key, its settings and the signal to stop");

  world.clock += 1_900;
  world.next = "unseen, node quiet";
  await until("through the service too, an edict that lands unseen gets its text at the next poll, not at the next look", () => world.epoch() === 2 && readLog(logD).length === 2 && readLog(logD)[1].note === world.note(), 10);
  check(said.some((line) => line.includes("agent: error: Transaction was not confirmed") && line.includes("https://rpc.example") && !line.includes("SECRET")), "the error is printed with the node's address cut to its host");

  world.landForeign();
  world.clock += 1_900;
  await until("an edict written elsewhere turns /health to 503, by name", async () => {
    const now = await healthOf(d.port);
    return now.status === 503 && now.body.agent.withoutText.includes(3) && now.body.problems.includes("edict 3 is on chain and its text is not in the log");
  }, 10);
  await until("and the agent goes on", () => world.epoch() === 4 && readLog(logD).length === 3, 10);

  keeperDoes = async () => { throw new Error("failed to get info about account: 429 Too Many Requests https://rpc.example/?api-key=SECRET"); };
  await until("a keeper that keeps failing turns up on /health", async () => (await healthOf(d.port)).body.problems.includes("the keeper keeps failing: Error"), 10);
  keeperDoes = async () => { throw new Error("my key paid for 1 transaction(s) my records do not have, 5Yx for one: I pay nothing until a person has looked."); };
  await until("with its own reason for stopping, in its own words", async () => (await healthOf(d.port)).body.problems.some((problem) => problem.includes("I pay nothing until a person has looked")), 10);
  const shown = await fetch(dAt("/health")).then((answer) => answer.text());
  check(!shown.includes("SECRET") && !shown.includes("rpc.example") && !shown.includes(keyJson(keeperKey).slice(1, 40)), "and /health shows nothing of the node's address or of a key");
  keeperDoes = async (keeper) => ({ status: "waiting", reason: `I cannot afford to claim the fees: it takes 0.0000065 SOL of my own. My wallet ${keeper.keeper.publicKey.toBase58()} needs topping up.` });
  await until("a keeper out of SOL of its own is a problem, although its round did not fail", async () => {
    const now = await healthOf(d.port);
    return now.status === 503 && now.body.problems.includes("the keeper's wallet needs topping up") && !now.body.problems.some((problem) => problem.includes("keeps failing"));
  }, 10);
  check(readFileSync(new URL("../src/keeper/round.ts", import.meta.url), "utf8").includes("needs topping up"), "which is still how the keeper says it");
  const walletListed = async () => (await healthOf(d.port)).body.problems.includes("the keeper's wallet needs topping up");
  keeperDoes = async () => idle;
  await until("a round with nothing in its way takes the wallet off the list", async () => !(await walletListed()), 10);
  // The other wording: a payout round that runs short halfway. The round did something, so it is said once, as it happens.
  let halfway = 0;
  keeperDoes = async (keeper) => {
    if (halfway++ === 0) keeper.report?.(`I cannot afford the next payments of round 4: their network fees are 15000 lamports, and my wallet holds 9000 lamports, of which 0 are fees I keep for others and 890880 must stay in it. The round waits until my wallet ${keeper.keeper.publicKey.toBase58()} is topped up.`);
    else keeper.report?.("sent the treasury 0.06 SOL");
    return { status: "settled", did: ["a step"] };
  };
  await until("a payout round that runs short halfway says it in other words, and that is a problem too", walletListed, 10);
  await until("(more rounds go by, each doing something else)", () => halfway >= 4, 10);
  health = await healthOf(d.port);
  check(health.status === 503 && health.body.problems.includes("the keeper's wallet needs topping up") && health.body.keeper.saying === "sent the treasury 0.06 SOL", "it stays listed while the keeper's later rounds talk of other things");
  check(readFileSync(new URL("../src/keeper/holders.ts", import.meta.url), "utf8").includes("is topped up"), "and that is still how the keeper says it");
  keeperDoes = async () => idle;
  await until("until a round finds nothing in its way", async () => !(await walletListed()), 10);

  // Stopping: a look and a round are both in hand when the stop is asked for.
  const steps = { started: 0, finished: 0 };
  keeperDoes = async () => {
    steps.started++;
    await sleep(1_500);
    steps.finished++;
    return { status: "settled", did: ["a step"] };
  };
  modelTakes = 2_000;
  world.clock += 1_900;
  await until("(a look and a round are in hand)", () => looking && steps.started > steps.finished, 10);
  const before = { log: readLog(logD).length, epoch: world.epoch(), started: steps.started };
  const askedAt = Date.now();
  let done = false;
  const stopping = d.stop().then(() => void (done = true));
  await sleep(300);
  check(!done && world.epoch() === before.epoch && readLog(logD).length === before.log, "asked to stop in the middle of a look and of a round, the service does not leave at once");
  health = await healthOf(d.port);
  check(health.body.agent.on, "it still answers /health meanwhile");
  await stopping;
  check(Date.now() - askedAt >= 1_000 && steps.finished === before.started && steps.started === before.started, "the keeper's round is let finish the step it was on, and no other is started");
  check(world.epoch() === before.epoch + 1 && readLog(logD).length === before.log + 1 && readLog(logD).at(-1)?.note === world.note() && !existsSync(waitingPath(logD)), "and the agent's look ends as an edict on chain with its text in the log");
  check(!existsSync(join(dirD, "service.lock")) && (await fetch(dAt("/health")).then(() => false, () => true)), "then it lets go of its lock and of the port");

  // -------------------------------------------------------------------------------------------
  console.log("how often the model is asked (the agent's own loop, on a chain in memory)");

  const pace = madeUpChain();
  const paceLog = join(folder(), "agent-log.jsonl");
  /** The agent's loop with a poll every twentieth of a second: what it reported, and how often it asked the model. */
  function pacing(over: Partial<Context>, thinkEverySecs: number) {
    const events: string[] = [];
    let asks = 0;
    const halt = new AbortController();
    const base: Context = { connection: pace.connection, dbc: pace.dbc, hookProgram: pace.hookProgram, mint: pace.mint, pool: Keypair.generate().publicKey, agent: pace.agent, logPath: paceLog, decide: rote, ...over };
    const running = watch({ ...base, decide: (snapshot, book) => (asks++, base.decide(snapshot, book)) }, { pollSecs: 0.05, thinkEverySecs, signal: halt.signal, report: (event) => void events.push(event.status) });
    return { events, asks: () => asks, last: () => events.at(-1), stop: () => (halt.abort(), running) };
  }
  const count = (events: string[], status: string) => events.filter((event) => event === status).length;

  let loop = pacing({ dryRun: true }, 0.1);
  await sleep(1_000);
  await loop.stop();
  check(loop.asks() === 1 && loop.events[0] === "rewritten" && loop.events.length > 5 && count(loop.events, "resting") === loop.events.length - 1, `in a dry run the model is asked once, and then left alone for as long as the edict it would have issued would stand (${loop.asks()} look in ${loop.events.length} polls)`);
  check(pace.epoch() === 0 && pace.sent.length === 0 && !existsSync(paceLog), "and a dry run still sends nothing and writes nothing");

  pace.quietReads = 1_000_000;
  loop = pacing({}, 3_600);
  await sleep(600);
  await loop.stop();
  pace.quietReads = 0;
  check(loop.asks() === 0 && loop.events.length >= 5 && count(loop.events, "error") === loop.events.length, `a look that fails before the model is asked costs nothing, and is tried again at every poll (${loop.events.length} tries)`);

  loop = pacing({ decide: async () => { throw new Error("the answer could not be used"); } }, 0.3);
  await sleep(1_000);
  await loop.stop();
  check(count(loop.events, "error") === loop.asks() && loop.asks() >= 2 && loop.asks() <= 4 && count(loop.events, "resting") > loop.asks(), `one that fails after the model was asked is not paid for again at the next poll (${loop.asks()} looks in ${loop.events.length} polls)`);

  loop = pacing({ decide: async () => ({ action: "hold", reasoning: "The model could not be reached.", model: "stand-in" }) }, 3_600);
  await until("(a look issues nothing, and the model is left alone for an hour)", () => loop.last() === "resting", 5);
  pace.book[2] = 1;
  await until("during that hour the rulebook is still read: the guardian's pause is seen at the next poll", () => loop.last() === "paused", 5);
  pace.book[2] = 0;
  await until("and so is its end", () => loop.last() === "resting", 5);
  Keypair.generate().publicKey.toBuffer().copy(pace.book, 72);
  await until("and so is a key that is no longer the agent's", () => loop.last() === "error", 5);
  pace.agent.publicKey.toBuffer().copy(pace.book, 72);
  await loop.stop();
  check(loop.asks() === 1 && count(loop.events, "held") === 1, "all of it without the model being asked again");

  // -------------------------------------------------------------------------------------------
  console.log("a log that another token used first");

  const kin = madeUpChain();
  const kinLog = join(folder(), "agent-log.jsonl");
  const theirs = `${log.slice(0, 2).map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  // Two whole lines of the token further up, and a line of its still waiting on a block height of its own network.
  writeFileSync(kinLog, theirs);
  writeFileSync(waitingPath(kinLog), JSON.stringify({ line: log[2], lastValidBlockHeight: kin.height + 50_000_000 }));
  const remembered: number[] = [];
  const kinCtx: Context = { connection: kin.connection, dbc: kin.dbc, hookProgram: kin.hookProgram, mint: kin.mint, pool: Keypair.generate().publicKey, agent: kin.agent, logPath: kinLog, decide: (snapshot, book) => (remembered.push(snapshot.history.length), rote(snapshot, book)) };
  outcome = await runOnce(kinCtx);
  check(outcome.status === "rewritten" && !existsSync(waitingPath(kinLog)), "a line the other token left waiting is dropped, and holds nothing up");
  kin.clock += 1_900;
  await runOnce(kinCtx);
  check(remembered[0] === 0 && remembered[1] === 1, "the model is shown its own token's edicts as its past, and none of the other's");
  check(readLog(kinLog).length === 4 && readLog(kinLog, kin.mint.toBase58()).length === 2 && readLog(kinLog, chain.mint.toBase58()).length === 2 && readFileSync(kinLog, "utf8").startsWith(theirs), "the other token's lines stay in the file as they were");

  // -------------------------------------------------------------------------------------------
  console.log("what /health says of a loop that cannot work, and how soon");

  const dirE = folder();
  const sky = madeUpChain();
  const skyMint = sky.mint.toBase58();
  writeFileSync(join(dirE, "agent-log.jsonl"), theirs);
  const model = { asked: 0, holds: false, remembered: -1 };
  let rulebookThere = false;
  let keeperRefused = true;
  const refusal = "the rulebook names 8hAD as the keeper, not my key 9Zwp";
  const skyService = () =>
    serve({
      env: {
        DATA_DIR: dirE, PORT: "0", RPC_URL: "http://127.0.0.1:9", HOOK_PROGRAM: sky.hookProgram.toBase58(), MINT: skyMint, POOL: address(), TREASURY: address(),
        AGENT_KEYPAIR_JSON: keyJson(sky.agent), KEEPER_KEYPAIR_JSON: keyJson(Keypair.generate()), AGENT_POLL_SECS: "0.5", AGENT_THINK_EVERY_SECS: "3600", KEEPER_EVERY_SECS: "0.5",
      },
      // The settings point at a token that has no rulebook, until it is put there.
      connection: { ...sky.connection, getAccountInfo: async () => (rulebookThere ? { data: Buffer.from(sky.book) } : null) } as unknown as Connection,
      dbc: sky.dbc,
      decide: async (snapshot, book) => {
        model.asked++;
        model.remembered = snapshot.history.length;
        return model.holds ? { action: "hold", reasoning: "The model could not be reached.", model: "stand-in" } : rote(snapshot, book);
      },
      round: async () => {
        if (keeperRefused) throw new Error(refusal);
        return idle;
      },
      print,
    });
  const e = await skyService();
  const eNow = () => healthOf(e.port);
  const noRulebook = `no rulebook for ${skyMint} under ${sky.hookProgram.toBase58()}`;
  await until("a service whose settings name the wrong token says so on /health at once, for both loops", async () => {
    const now = await eNow();
    return now.status === 503 && now.body.problems.includes(`the agent has not worked since it started: ${noRulebook}`) && now.body.problems.includes(`the keeper has not worked since it started: ${refusal}`) && now.body.agent.errorsInARow < 3;
  }, 3);
  response = await fetch(`http://127.0.0.1:${e.port}/`);
  check(response.status === 200 && (await response.text()).includes("/health") && JSON.parse(readFileSync(new URL("../railway.json", import.meta.url), "utf8")).deploy.healthcheckPath === "/", "while / answers 200, which is what the host asks: the copy is up, and can say what is wrong");
  await until("after three tries each is said to keep failing", async () => {
    const { problems } = (await eNow()).body;
    return problems.includes(`the agent keeps failing: ${noRulebook}`) && problems.includes(`the keeper keeps failing: ${refusal}`);
  }, 5);
  rulebookThere = true;
  keeperRefused = false;
  await until("and both are well as soon as each gets through a step", async () => {
    const now = await eNow();
    return now.status === 200 && now.body.agent.last === "in-force" && now.body.keeper.last === "waiting";
  }, 5);
  check(model.asked === 1 && model.remembered === 0 && said.some((line) => line.includes("agent: the log holds 2 lines of another token")), "the service, too, shows the model nothing of another token's log, and says that the lines are there");

  const usurper = Keypair.generate().publicKey;
  usurper.toBuffer().copy(sky.book, 72);
  await until("a key the guardian has replaced is said to keep failing at its first refusal, not its third", async () => {
    const now = await eNow();
    return now.status === 503 && now.body.problems.includes(`the agent keeps failing: ${sky.agent.publicKey.toBase58()} is not this token's agent (${usurper.toBase58()} is)`) && now.body.agent.errorsInARow < 3;
  }, 3);
  sky.agent.publicKey.toBuffer().copy(sky.book, 72);
  await until("with the right key it is well again at the next poll", async () => (await eNow()).status === 200, 5);

  sky.book[2] = 1;
  await until("the guardian's pause shows within a poll", async () => (await eNow()).body.agent.last === "paused", 3);
  sky.book[2] = 0;
  await until("and so does its end", async () => (await eNow()).body.agent.last === "in-force", 3);
  model.holds = true;
  sky.clock += 1_900;
  await until("(a look issues nothing, and the model is left alone for an hour)", async () => (await eNow()).body.agent.last === "resting", 5);
  const askedSoFar = model.asked;
  sky.book[2] = 1;
  await until("during that hour a pause still shows within a poll", async () => (await eNow()).body.agent.last === "paused", 3);
  sky.book[2] = 0;
  await until("and its end as well", async () => (await eNow()).body.agent.last === "resting", 3);
  health = await eNow();
  check(health.status === 200 && health.body.ok && model.asked === askedSoFar && askedSoFar === 2, "with the model asked nothing meanwhile, and none of it a problem");
  await e.stop();

  // Started again a moment after a look that issued nothing, with an edict due.
  appendFileSync(join(dirE, "agent-log.jsonl"), `${JSON.stringify({ record: { mint: skyMint, epoch: sky.epoch(), at: new Date().toISOString(), action: "hold", reasoning: "The model could not be reached.", model: "stand-in" }, marketCapSol: 30 })}\n`);
  const again = await skyService();
  await until("started again within that hour, it takes the wait up where the log shows it was left, and reads the rulebook meanwhile", async () => (await healthOf(again.port)).body.agent.last === "resting", 5);
  check(model.asked === askedSoFar && said.some((line) => line.endsWith("agent: the next look is not due yet")), "so a restart does not buy one more call to the model");
  await again.stop();

  const fog = madeUpChain();
  let fogAsked = 0;
  const unusable = "the model's answer could not be used";
  const f = await serve({
    env: { DATA_DIR: folder(), PORT: "0", RPC_URL: "http://127.0.0.1:9", HOOK_PROGRAM: fog.hookProgram.toBase58(), MINT: fog.mint.toBase58(), POOL: address(), AGENT_KEYPAIR_JSON: keyJson(fog.agent), AGENT_POLL_SECS: "0.1", AGENT_THINK_EVERY_SECS: "0.4", KEEPER_OFF: "1" },
    connection: fog.connection,
    dbc: fog.dbc,
    decide: async () => {
      fogAsked++;
      throw new Error(unusable);
    },
    print,
  });
  await until("an agent whose first look fails after the model was asked is a problem at once as well", async () => (await healthOf(f.port)).body.problems.includes(`the agent has not worked since it started: ${unusable}`), 3);
  await until("and is said to keep failing at its third look", async () => (await healthOf(f.port)).body.problems.includes(`the agent keeps failing: ${unusable}`), 5);
  check(fogAsked >= 3 && fogAsked <= 4, `the polls in between, when it only reads the rulebook, neither count as looks nor clear the failures (${fogAsked} looks)`);
  await f.stop();

  // -------------------------------------------------------------------------------------------
  console.log("the guardian's command, when the node in token.json does not answer");

  // A node that answers what "status" asks, out of the rulebook above. It says it is devnet.
  const node = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (text: string) => void (body += text)).on("end", () => {
      const { id, method } = JSON.parse(body) as { id: unknown; method: string };
      const result =
        method === "getGenesisHash" ? "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
        : method === "getAccountInfo" ? { context: { slot: 1 }, value: { data: [sky.book.toString("base64"), "base64"], executable: false, lamports: 1, owner: sky.hookProgram.toBase58(), rentEpoch: 0, space: sky.book.length } }
        : method === "getSlot" ? 1
        : sky.clock;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((listening) => node.listen(0, "127.0.0.1", listening));
  const nodeAt = `http://127.0.0.1:${(node.address() as { port: number }).port}`;
  const token = { rpc: `http://127.0.0.1:${await freePort()}/?api-key=SECRET`, hookProgram: sky.hookProgram.toBase58(), mint: skyMint };
  const [onDevnet, onMainnet] = [join(dirE, "token.json"), join(dirE, "token-mainnet.json")];
  writeFileSync(onDevnet, JSON.stringify({ network: "devnet", ...token }));
  writeFileSync(onMainnet, JSON.stringify({ network: "mainnet", ...token }));
  const [gone, through, elsewhere] = await Promise.all([guardianCommand(dirE, onDevnet, "status"), guardianCommand(dirE, onDevnet, "status", "--rpc", nodeAt), guardianCommand(dirE, onMainnet, "status", "--rpc", nodeAt)]);
  check(gone.code === 1 && gone.out.includes("I could not get an answer from the node at http://127.0.0.1:") && gone.out.includes("Nothing was sent.") && gone.out.includes("--rpc https://api.devnet.solana.com"), "it says in plain words that the node did not answer, that nothing was sent, and how to go through another node");
  check(!gone.out.includes("SECRET") && !/\n\s+at \S/.test(gone.out), "without the node's key, and without a stack trace");
  check(through.code === 0 && through.out.includes("network     devnet") && through.out.includes(`agent       ${sky.agent.publicKey.toBase58()}`) && through.out.includes("app key     none") && through.out.includes("state       running") && through.out.includes("Nothing was sent: status only looks."), "--rpc takes the same command through another node, and token.json is left alone");
  check(elsewhere.code === 1 && elsewhere.out.includes("is on devnet") && elsewhere.out.includes("says this token is on mainnet") && !elsewhere.out.includes("guardian    "), "a node of another network is turned down before anything is read from it");
  if (failures) console.log([gone, through, elsewhere].map((told) => `(exit code ${told.code})${told.out}`).join("\n"));
  node.closeAllConnections();
  await new Promise((closed) => node.close(closed));

  // -------------------------------------------------------------------------------------------
  console.log("two copies on one disk");

  const second = { port: await freePort(), started: false };
  const waiting = serve({ env: { DATA_DIR: dirA, PORT: String(second.port), ...off }, print }).then((service) => (second.started = true, service));
  await sleep(1_000);
  health = await healthOf(second.port);
  check(!second.started && health.status === 503 && health.body.problems.includes("still starting") && said.some((line) => line.includes("another copy has these files")), "a second copy on the same folder waits, and says on /health that it is still starting");
  await a.stop();
  const b2: Service = await waiting;
  check(second.started && (await healthOf(second.port)).status === 200, "and takes over when the first has gone");
  await b2.stop();

  // -------------------------------------------------------------------------------------------
  console.log("as a process, stopped by a signal");

  const dirS = folder();
  const portS = await freePort();
  const service = startService({
    DATA_DIR: dirS, PORT: String(portS), RPC_URL: "http://127.0.0.1:9", HOOK_PROGRAM: address(), MINT: address(), POOL: address(), TREASURY: address(),
    KEEPER_KEYPAIR_JSON: keyJson(Keypair.generate()), AGENT_OFF: "1", KEEPER_EVERY_SECS: "60", CHECK_NO_CHAIN: "1", CHECK_SLOW_MS: "2500", DRY_RUN: "",
  }, dirS);
  const sawStep = await until("the service starts as a process of its own, and its keeper takes a step", () => service.lines.some((line) => line.includes("check: a step is in hand")), 60);
  if (sawStep) {
    health = await healthOf(portS);
    check(health.body.keeper.on && !health.body.agent.on && existsSync(join(dirS, "service.lock")), "it answers /health while the step is in hand");
    const signalled = Date.now();
    signalToStop(service.child);
    const { code } = await service.exited;
    check(code === 0 && service.lines.some((line) => line.includes("SIGTERM: finishing the step in hand")) && service.lines.at(-1)?.endsWith("stopped"), `SIGTERM is taken as a request to finish, and the process leaves with code 0 (${process.platform === "win32" ? "raised inside the process: Windows has no signals to send" : "sent as a signal"})`);
    check(existsSync(join(dirS, "step-finished")) && !existsSync(join(dirS, "service.lock")), "after the step in hand was finished, and with its lock let go");
    // The keeper's next round was a minute away: a stop must not sit that minute out.
    check(Date.now() - signalled < 15_000, `without waiting for the next round to come due (${((Date.now() - signalled) / 1000).toFixed(1)} s)`);
  } else {
    console.log(service.lines.join("\n"));
    service.child.kill("SIGKILL");
  }

  console.log(failures ? `\n${failures} check(s) FAILED, ${passed} passed` : `\nall ${passed} checks passed`);
  process.exit(failures ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------
// On the local validator
// ---------------------------------------------------------------------------------------------

async function onValidator() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const local = JSON.parse(readFileSync(join(root, ".local", "validator.json"), "utf8")) as { rpc: string; hookProgram: string };
  const connection = new Connection(local.rpc, "confirmed");
  const HOOK = new PublicKey(local.hookProgram);
  const dbc = DynamicBondingCurveClient.create(connection, "confirmed");

  // The limits and the split the token launches with, except the wait between two edicts.
  const LIMITS: Limits = { minIntervalSecs: 2, maxRuleSecs: 2 * 3600, minTreasuryBps: 4_000, maxTreasuryBps: 5_000, minRenameSecs: 86_400 };
  const SPLIT: Split = { holdersBps: 3_000, burnBps: 3_000, treasuryBps: 4_000 };
  const [payer, guardian, agent, keeper, treasury, alice, bob, carol, mint, config] = Array.from({ length: 10 }, () => Keypair.generate());
  const book = rulebookAddress(HOOK, mint.publicKey);

  const send = async (tx: Transaction, signers: Keypair[]) => {
    const latest = await connection.getLatestBlockhash();
    tx.feePayer = signers[0].publicKey;
    tx.recentBlockhash = latest.blockhash;
    tx.sign(...signers);
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const { value } = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    if (value.err) throw new Error(`a transaction failed: ${JSON.stringify(value.err)}`);
    return signature;
  };
  const airdrop = async (to: PublicKey, sol: number) => {
    const signature = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
  };
  const readBook = async () => decodeRulebook((await connection.getAccountInfo(book, "confirmed"))!.data);

  /**
   * Waits, if it has to, until the next `slots` slots are clear of the moment this validator
   * drops its old blocks, about every 540 slots. The keeper will not call a transaction dead,
   * or done, that the node can no longer show, so a round that straddles that moment would wait
   * for good here. (On a real network the node is one that keeps its history.)
   */
  async function clearOfTheNextDrop(slots: number): Promise<void> {
    for (let told = false; ; told = true) {
      const [slot, oldest] = [await connection.getSlot("processed"), await connection.getFirstAvailableBlock()];
      const since = oldest === 0 ? slot : slot - oldest - 40;
      const untilNext = 540 - (((since % 540) + 540) % 540);
      if (untilNext > slots + 80) return;
      if (!told) console.log(`      (waiting about ${Math.round((untilNext + 80) * 0.4)} seconds, until the validator is past the moment it drops its old blocks)`);
      await sleep(5_000);
    }
  }

  console.log("a token on the validator");
  // The treasury is a wallet somebody has used: the keeper does nothing for one that has never held anything.
  for (const [wallet, sol] of [[payer, 10], [guardian, 1], [agent, 1], [keeper, 1], [treasury, 1], [alice, 50], [bob, 50], [carol, 50]] as const) await airdrop(wallet.publicKey, sol);
  // What the treasury holds before the keeper has sent it anything.
  const treasuryHad = BigInt(await connection.getBalance(treasury.publicKey, "confirmed"));
  const { pool } = await launch({
    dbc, hookProgram: HOOK, payer, mint, config,
    guardian: guardian.publicKey, agent: agent.publicKey, keeper: keeper.publicKey,
    limits: LIMITS, split: SPLIT,
    curve: { startCapSol: 30, graduationCapSol: 8_000_000, feeBps: 300 },
    names: [{ name: "Veluno", symbol: "VELUNO" }], uri: "https://example.com/veluno.json",
  }, (_what, tx, signers) => send(tx, signers));
  const swap = async (who: Keypair, buy: boolean, amount: bigint) =>
    send(await dbc.pool.swap2WithTransferHook({ owner: who.publicKey, pool, swapBaseForQuote: !buy, referralTokenAccount: null, swapMode: SwapMode.ExactIn, amountIn: new BN(amount.toString()), minimumAmountOut: new BN(0) }), [who]);
  const buy = (who: Keypair, sol: number) => swap(who, true, BigInt(Math.round(sol * LAMPORTS_PER_SOL)));
  const held = async (who: Keypair) => (await connection.getAccountInfo(getAssociatedTokenAddressSync(mint.publicKey, who.publicKey, false, TOKEN_2022_PROGRAM_ID), "confirmed"))!.data.readBigUInt64LE(64);
  // Before the first edict nothing is restricted. These leave 0.288 SOL of fees for the token in the pool.
  await buy(alice, 6);
  await buy(bob, 4);
  await buy(carol, 2);
  await swap(alice, false, (await held(alice)) / 10n);
  check((await readBook()).keeper.equals(keeper.publicKey) && (await readBook()).epoch === 0n, "a token is launched as the launch file would, with the keeper in its rulebook, and three wallets trade it");

  const dir = join(root, ".local", "e2e-serve");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const env = {
    RPC_URL: local.rpc, HOOK_PROGRAM: HOOK.toBase58(), MINT: mint.publicKey.toBase58(), POOL: pool.toBase58(), TREASURY: treasury.publicKey.toBase58(),
    AGENT_KEYPAIR_JSON: keyJson(agent), KEEPER_KEYPAIR_JSON: keyJson(keeper), DATA_DIR: dir, PORT: String(port),
    AGENT_POLL_SECS: "1", AGENT_THINK_EVERY_SECS: "2", KEEPER_EVERY_SECS: "2", KEEPER_OWN_WALLETS: payer.publicKey.toBase58(),
    // The keeper's thresholds in SOL are the shipped ones, except that a credit and a payout round do not wait for a whole SOL or a day.
    KEEPER_SETTINGS: JSON.stringify({ pollMs: 500, creditWhenLamports: "10000000", payWhenLamports: "10000000" }),
    CHECK_EDICT_MINUTES: "0.25", DRY_RUN: "", AGENT_OFF: "", KEEPER_OFF: "", RESTORE_FROM: "", ALLOW_ORIGINS: "",
  };
  const at = (path: string) => `http://127.0.0.1:${port}${path}`;
  const logPath = join(dir, "agent-log.jsonl");
  const booksPath = join(dir, "keeper", "private", "books.json");
  type Head = { seq: number; mint: string; keeper: string; totals: { claimed: string; treasury: { paid: string; owed: string } }; recent: { kind: string; signature?: string }[] };
  const headNow = async () => fetch(at("/ledger-head.json")).then((answer) => answer.text()).then((text) => (text ? (JSON.parse(text) as Head) : null), () => null);
  const ledgerNow = async () => (await fetch(at("/ledger.jsonl")).then((answer) => answer.text())).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { seq: number; kind: string; signature?: string });
  const lastOf = (lines: string[]) => lines.slice(-25).join("\n");

  console.log("the service, with both loops");
  // The keeper looks at the treasury's address in finalized blocks: what it was sent above is final before the service starts.
  while ((await connection.getBalance(treasury.publicKey, "finalized")) === 0) await sleep(500);
  await clearOfTheNextDrop(330);
  let service = startService(env, dir);
  await until("it starts, and the agent issues its first edict by itself", async () => (await readBook()).epoch >= 1n && readLog(logPath).length >= 1, 60);
  await until("the keeper claims the fees through the hook program and sends the treasury its share", async () => (await headNow())?.recent.some((line) => line.kind === "treasury"), 120);
  await until("and comes to rest with nothing of its own still out", async () => {
    const health = (await healthOf(port)).body;
    return health.keeper.saying?.startsWith("nothing is due") && existsSync(booksPath) && (JSON.parse(readFileSync(booksPath, "utf8")) as { pending: unknown }).pending === null;
  }, 150);
  // Small trades from here on: they keep the pool moving and stay under what the keeper acts on.
  await buy(carol, 0.05).catch(() => undefined);
  await buy(bob, 0.05).catch(() => undefined);

  let health = await healthOf(port);
  check(health.status === 200 && health.body.ok && health.body.agent.on && health.body.keeper.on, `/health is green: ${JSON.stringify(health.body.problems)}`);
  check(health.body.agent.address === agent.publicKey.toBase58() && health.body.keeper.address === keeper.publicKey.toBase58() && health.body.agent.lastEdictAt !== null, "with the two addresses the rulebook names");

  const chainNote = async () => pageRulebook(new Uint8Array((await connection.getAccountInfo(book, "confirmed"))!.data)).note;
  const pageLog = await pageReadLog(at("/log.jsonl"));
  const edicts = pageLog?.filter((entry) => entry.record.action === "rewrite") ?? [];
  const notes = await Promise.all(edicts.map((entry) => hashOf(entry.record)));
  check(edicts.length >= 1 && notes.every((note, i) => note === edicts[i].note) && notes.includes(await chainNote()), "the page reads the log from the service: every text hashes to its note, and the edict in force is among them");
  // The words are in the transaction too. This is the read an explorer makes, and all a page needs to say so: the signature and the announcement from the log's line.
  const newest = edicts.at(-1);
  await until("the newest edict's transaction, read as an explorer reads it, shows its announcement as a memo the agent signed", async () => {
    const shown = newest ? await connection.getParsedTransaction(String(newest.signature), { commitment: "confirmed", maxSupportedTransactionVersion: 0 }) : null;
    const memos = shown?.transaction.message.instructions.filter((instruction) => instruction.programId.equals(MEMO_PROGRAM)) ?? [];
    return memos.length === 1 && "parsed" in memos[0] && memos[0].parsed === (newest.record.memo ?? newest.record.announcement) && shown?.meta?.logMessages?.includes(`Program log: Signed by ${agent.publicKey.toBase58()}`);
  }, 20);
  const pageHead = await readLedger(at("/ledger-head.json"));
  check(pageHead && pageHead.mint === mint.publicKey.toBase58() && pageHead.seq >= 2 && BigInt(pageHead.totals.claimed) >= 288_000_000n && pageHead.recent.some((line: { kind: string }) => line.kind === "claim"), `the page reads the keeper's head from the service: ${pageHead ? `${pageHead.seq} lines, ${Number(pageHead.totals.claimed) / 1e9} SOL claimed` : "nothing"}`);
  const ledger = await ledgerNow();
  check(ledger.length === (await headNow())?.seq && ledger.every((line, i) => line.seq === i + 1), `the whole ledger is served too, line for line with the head (${ledger.map((line) => line.kind).join(", ")})`);
  check(BigInt(await connection.getBalance(treasury.publicKey, "confirmed")) - treasuryHad === BigInt((await headNow())?.totals.treasury.paid ?? -1) && BigInt((await headNow())?.totals.treasury.paid ?? 0) > 0n, "and the treasury's wallet holds exactly what the ledger says it was sent, on top of what it held before");

  for (const path of ["/log.jsonl", "/ledger.jsonl", "/ledger-head.json"]) {
    const allowed = await fetch(at(path), { headers: { origin: SITE } });
    const body = await allowed.text();
    const tag = allowed.headers.get("etag") ?? "";
    const again = await fetch(at(path), { headers: { origin: SITE, "if-none-match": tag } });
    const other = await fetch(at(path), { headers: { origin: "https://elsewhere.example" } });
    await other.arrayBuffer();
    const type = path.endsWith(".json") ? "application/json; charset=utf-8" : "application/x-ndjson; charset=utf-8";
    check(allowed.status === 200 && body.length > 0 && allowed.headers.get("content-type") === type && allowed.headers.get("cache-control") === "no-cache" && allowed.headers.get("cdn-cache-control") === "max-age=5" && allowed.headers.get("access-control-allow-origin") === SITE && tag !== "", `${path} goes to ${SITE} with its type, its tag and its cache headers`);
    check((again.status === 304 || again.headers.get("etag") !== tag) && other.status === 200 && other.headers.get("access-control-allow-origin") === null, `${path} unchanged is a 304, and another origin is not told it may read it`);
  }
  for (const path of ["/keeper/private/books.json", "/private/books.json", "/agent-log.jsonl.pending", "/service.lock"]) check((await rawStatus(port, path)) === 404, `${path} is not served`);

  console.log("killed between sending an edict and writing it down");
  const epochBefore = Number((await readBook()).epoch);
  service.child.send("die at the next edict");
  const died = await service.exited;
  check(died.code !== 0, `the process is killed outright as the agent starts to wait for its edict to be confirmed (${died.signal ?? `code ${died.code}`})`);
  const wasWaiting = JSON.parse(readFileSync(waitingPath(logPath), "utf8")) as { line: { note: string; signature: string } };
  await until("the edict lands all the same", async () => Number((await readBook()).epoch) === epochBefore + 1, 30);
  const orphan = (await readBook()).note.toString("hex");
  const status = (await connection.getSignatureStatuses([wasWaiting.line.signature], { searchTransactionHistory: true })).value[0];
  check(!readLog(logPath).some((entry) => entry.note === orphan), "it is on chain, and its text is not in the log");
  check(wasWaiting.line.note === orphan && status !== null && status.err === null, "its line was written to disk before it was sent, under the hash the chain now holds, with the signature of a transaction the chain has");

  console.log("started again");
  // The model is slow from here on, so that the signal further down arrives in the middle of a look.
  service = startService({ ...env, CHECK_SLOW_MS: "5000" }, dir);
  await until("the new copy starts, once the dead one's lock has gone stale", () => service.lines.some((line) => line.includes(`agent ${agent.publicKey.toBase58()} on token`)), 90);
  await until("and puts the text back before anything else", () => readLog(logPath).some((entry) => entry.note === orphan), 30);
  const back = readLog(logPath).find((entry) => entry.note === orphan);
  check(back && noteOf(back.record).toString("hex") === orphan && back.signature === wasWaiting.line.signature && back.record.epoch === epochBefore + 1 && !existsSync(waitingPath(logPath)), "under the hash the chain holds, with its transaction, and nothing left waiting");
  check(readLog(logPath).filter((entry) => entry.note === orphan).length === 1 && service.lines.some((line) => line.includes("was on chain without its text in the log; the text was put back")), "once, and it says so");
  const fromPage = (await pageReadLog(at("/log.jsonl")))?.find((entry) => entry.note === orphan);
  check(fromPage && (await hashOf(fromPage.record)) === orphan, "the page finds that text sound");

  console.log("stopped by a signal, in the middle of a look");
  // A look that starts from now on has five seconds of the model's time ahead of it.
  const looks = () => service.lines.filter((line) => line.includes("check: a look is in hand")).length;
  const seen = looks();
  await until("(the agent starts a look)", () => looks() > seen, 90);
  const atSignal = { epoch: Number((await readBook()).epoch), log: readLog(logPath).length };
  signalToStop(service.child);
  const left = await service.exited;
  const after = await readBook();
  check(left.code === 0 && service.lines.some((line) => line.includes("SIGTERM: finishing the step in hand")) && service.lines.at(-1)?.endsWith("stopped"), `the process takes SIGTERM as a request to finish and leaves with code 0 (${process.platform === "win32" ? "raised inside the process: Windows has no signals to send" : "sent as a signal"})`);
  check(Number(after.epoch) === atSignal.epoch + 1 && readLog(logPath).length === atSignal.log + 1 && readLog(logPath).at(-1)?.note === after.note.toString("hex") && !existsSync(waitingPath(logPath)), "the look that was in hand ended as an edict on chain, with its text in the log");
  check(!existsSync(join(dir, "service.lock")) && !existsSync(join(dir, "keeper", "private", "keeper.lock")), "and both locks were let go");
  if (left.code !== 0) console.log(lastOf(service.lines));

  console.log("and started once more");
  service = startService(env, dir);
  await until("after a clean stop the next start is green at once: nothing waits for a lock, and both loops take up where they were", async () => {
    const now = await healthOf(port).catch(() => null);
    return now?.status === 200 && now.body.agent.last !== null && now.body.keeper.last === "waiting";
  }, 30);
  const finalLedger = await ledgerNow();
  const signatures = finalLedger.flatMap((line) => (line.signature ? [line.signature] : []));
  check(finalLedger.every((line, i) => line.seq === i + 1) && new Set(signatures).size === signatures.length && finalLedger.filter((line) => line.kind === "claim").length >= 1, `the ledger still has every line once (${finalLedger.map((line) => line.kind).join(", ")})`);
  check(BigInt(await connection.getBalance(treasury.publicKey, "confirmed")) - treasuryHad === BigInt((await headNow())!.totals.treasury.paid), "and the treasury's wallet still holds exactly what it says, on top of what it held before");
  health = await healthOf(port);
  if (!health.body.ok) console.log(lastOf(service.lines));

  console.log("the guardian's command, with the service running");
  const tokenFile = join(dir, "token.json");
  const guardianFile = join(dir, "guardian.json");
  const strangerFile = join(dir, "stranger.json");
  writeFileSync(tokenFile, JSON.stringify({ rpc: local.rpc, hookProgram: HOOK.toBase58(), mint: mint.publicKey.toBase58() }));
  writeFileSync(guardianFile, keyJson(guardian));
  writeFileSync(strangerFile, keyJson(alice));
  const guardianSays = (...args: string[]) => guardianCommand(dir, tokenFile, ...args);
  const withKey = ["--key", guardianFile];
  const [newAgent, newKeeper] = [Keypair.generate().publicKey, Keypair.generate().publicKey];

  let told = await guardianSays("status");
  check(told.code === 0 && told.out.includes(`guardian    ${guardian.publicKey.toBase58()}`) && told.out.includes(`agent       ${agent.publicKey.toBase58()}`) && told.out.includes(`keeper      ${keeper.publicKey.toBase58()}`) && told.out.includes("state       running"), "status needs no key and shows who holds what");
  told = await guardianSays("pause", "--key", strangerFile, "--send");
  check(told.code === 1 && told.out.includes("It is not the guardian's key, so nothing was done") && told.out.includes(alice.publicKey.toBase58()) && !(await readBook()).paused, "a key that is not the guardian's is refused before anything is sent, with both addresses said");
  told = await guardianSays("pause");
  check(told.code === 1 && told.out.includes("needs the guardian's key"), "without a key it asks for one");
  told = await guardianSays("pause", ...withKey);
  check(told.code === 0 && told.out.includes("This is what --send would do") && told.out.includes("PAUSE the agent.") && told.out.includes("The chain would accept it.") && told.out.includes("Nothing was sent") && !(await readBook()).paused, "without --send it says what it would do, asks the chain, and sends nothing");
  told = await guardianSays("pause", ...withKey, "--send");
  check(told.code === 0 && told.out.includes("The rulebook shows the change.") && told.out.includes("state       PAUSED") && (await readBook()).paused, "pause, with --send, pauses");
  await until("the running agent sees it at its next poll and issues nothing", async () => (await healthOf(port)).body.agent.last === "paused", 20);
  told = await guardianSays("pause", ...withKey, "--send");
  check(told.code === 0 && told.out.includes("already paused: there is nothing to do"), "asked again, it finds nothing to do");
  told = await guardianSays("resume", ...withKey, "--send");
  check(told.code === 0 && told.out.includes("The rulebook shows the change.") && !(await readBook()).paused, "resume, with --send, resumes");
  await until("and the agent goes on", async () => { const last = (await healthOf(port)).body.agent.last; return last !== null && last !== "paused"; }, 30);

  told = await guardianSays("agent", book.toBase58(), ...withKey, "--send");
  check(told.code === 1 && told.out.includes("is not a wallet's address") && (await readBook()).agent.equals(agent.publicKey), "an address nobody can sign with is refused as the new agent");
  told = await guardianSays("agent", newAgent.toBase58(), ...withKey);
  check(told.code === 0 && told.out.includes(`old agent   ${agent.publicKey.toBase58()}`) && told.out.includes(`new agent   ${newAgent.toBase58()}`) && told.out.includes("The chain would accept it.") && (await readBook()).agent.equals(agent.publicKey), "replacing the agent, as a dry run, names the old key and the new and changes nothing");
  told = await guardianSays("agent", newAgent.toBase58(), ...withKey, "--send");
  check(told.code === 0 && (await readBook()).agent.equals(newAgent), "with --send the rulebook names the new agent");
  await until("the old agent's key, still on the server, gets nowhere, and /health says why", async () => (await healthOf(port)).body.problems.some((problem) => problem.includes("the agent keeps failing") && problem.includes("is not this token's agent")), 60);

  told = await guardianSays("keeper", newKeeper.toBase58(), ...withKey);
  check(told.code === 0 && told.out.includes(`old keeper  ${keeper.publicKey.toBase58()}`) && told.out.includes(`new keeper  ${newKeeper.toBase58()}`) && told.out.includes("Nothing was sent") && (await readBook()).keeper.equals(keeper.publicKey), "replacing the keeper, as a dry run, names the old key and the new and changes nothing");
  told = await guardianSays("keeper", newKeeper.toBase58(), ...withKey, "--send");
  check(told.code === 0 && (await readBook()).keeper.equals(newKeeper), "with --send the rulebook names the new keeper");
  // The old keeper claims nothing more, pays out what it holds round by round, each payment waiting for a finalized block, and only then stops.
  // What is waited for is the keeper's own words. Whether the service lists them as a failure or as a keeper that has finished is the service's to say.
  await until("the old keeper pays out what it held and stops for good, and /health says why", async () => (await healthOf(port)).body.problems.some((problem) => problem.includes("as the keeper, not my key") && problem.includes("stopped for good")), 300);
  check((await ledgerNow()).at(-1)?.kind === "note", "the last line of its ledger is its note of what was left with it");
  // The service lists it as a keeper that has finished, not as one that keeps failing, and takes no more rounds.
  // Two rounds' worth of time is let pass first, in which a loop that had not ended would speak again.
  await sleep(5_000);
  health = await healthOf(port);
  const finished = `the keeper has finished and no keeper runs here now: the rulebook names ${newKeeper.toBase58()} as the keeper, not my key ${keeper.publicKey.toBase58()}: I have paid out what my books owed and stopped for good. The last line of my ledger says what was left.`;
  const ofKeeper = health.body.problems.filter((problem) => problem.startsWith("the keeper"));
  check(health.status === 503 && !health.body.ok && ofKeeper.length === 1 && ofKeeper[0] === finished && !health.body.keeper.on && health.body.keeper.last === "retired" && health.body.keeper.errorsInARow === 0, `/health answers 503 with one line about the keeper, in words that are not a failure's, and shows it off, its last word "retired" and no error counted (${JSON.stringify(ofKeeper)})`);
  const saidOnce = (words: string) => service.lines.filter((line) => line.includes(words)).length === 1;
  check(saidOnce("keeper: finished: the rulebook names ") && saidOnce("keeper: it takes no more rounds. The fees in the pool wait for the new keeper. What to do next: put the new keeper's key in KEEPER_KEYPAIR_JSON."), "the log says once that it has finished, and once what to do next");
  const records = await fetch(at("/ledger-head.json"));
  check(records.status === 200 && (await records.text()).length > 0, "the records are still served while both loops are refused");

  signalToStop(service.child);
  check((await service.exited).code === 0 && !existsSync(join(dir, "service.lock")) && !existsSync(join(dir, "keeper", "private", "keeper.lock")), "it stops cleanly again, and both locks are let go");

  if (failures === 0) rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) FAILED, ${passed} passed. The service's folder is left at ${dir}` : `\nall ${passed} checks passed`);
  process.exit(failures ? 1 : 0);
}

if (process.argv.includes("--validator")) await onValidator();
else await offline();
