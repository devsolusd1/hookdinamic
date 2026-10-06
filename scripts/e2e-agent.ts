// The agent's loop on a local validator (scripts/validator.sh), with a stand-in for the model:
// it proves everything around the model's answer. Market in, decision out, rules on chain, a
// log line whose hash matches the note in the rulebook.
//
//   npm run validator        (in one terminal; needs WSL)
//   npm run e2e:agent
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { noteOf, readBook, readLog, runOnce, watch, type Context, type Decide, type Outcome, type Snapshot } from "../src/agent.js";
import { pauseIx, type Change, type Limits } from "../src/hook.js";
import { launch } from "../src/launch.js";

const local = JSON.parse(readFileSync(new URL("../.local/validator.json", import.meta.url), "utf8")) as { rpc: string; hookProgram: string };
const connection = new Connection(local.rpc, "confirmed");
const HOOK = new PublicKey(local.hookProgram);
const dbc = DynamicBondingCurveClient.create(connection, "confirmed");

const LIMITS: Limits = { minIntervalSecs: 6, maxGateSecs: 6 * 3600, minMaxBuyBps: 25, minMaxWalletBps: 50, maxTreasuryBps: 3_000 };
const OPEN: Change = { gateSecs: 0, maxBuyBps: 0, maxWalletBps: 0, holdersBps: 5_000, burnBps: 3_000, treasuryBps: 2_000 };

let failures = 0;
function check(ok: boolean, what: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
}

const [payer, guardian, agent, alice, mint, config] = Array.from({ length: 6 }, () => Keypair.generate());
for (const wallet of [payer, guardian, agent, alice]) {
  const signature = await connection.requestAirdrop(wallet.publicKey, 100 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
}

const { pool } = await launch({
  dbc, hookProgram: HOOK, payer, mint, config,
  feeClaimer: payer.publicKey, guardian: guardian.publicKey, agent: agent.publicKey, cosigner: Keypair.generate().publicKey,
  limits: LIMITS, first: OPEN,
  curve: { startCapSol: 30, graduationCapSol: 8_000_000, feeBps: 200 },
  name: "Agent Hook Test", symbol: "AHT", uri: "https://example.com/aht.json",
}, (_what, tx, signers) => sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" }));

async function buy(solIn: number) {
  const tx = await dbc.pool.swap2WithTransferHook({
    owner: alice.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null,
    swapMode: SwapMode.ExactIn, amountIn: new BN(solIn * LAMPORTS_PER_SOL), minimumAmountOut: new BN(0),
  });
  await sendAndConfirmTransaction(connection, tx, [alice], { commitment: "confirmed" });
}

// The stand-in mind: a fixed sequence of answers, recording what it was shown.
const seen: Snapshot[] = [];
const answers: (Change | "hold")[] = [
  { ...OPEN, holdersBps: 6_000, burnBps: 2_000 },
  "hold",
  { ...OPEN, gateSecs: 600, holdersBps: 7_000, burnBps: 3_000, treasuryBps: 0 },
  { ...OPEN, maxWalletBps: 200 },
];
const script: Decide = async (snapshot) => {
  seen.push(snapshot);
  const answer = answers[(seen.length - 1) % answers.length];
  return answer === "hold"
    ? { action: "hold", reasoning: "nothing happened worth a change", model: "stand-in" }
    : { action: "rewrite", change: answer, announcement: `rules #${seen.length}`, reasoning: "scripted", model: "stand-in" };
};

const logPath = join(mkdtempSync(join(tmpdir(), "agent-")), "agent-log.jsonl");
const ctx: Context = { connection, dbc, hookProgram: HOOK, mint: mint.publicKey, pool, agent, logPath, decide: script };

console.log("one look at a time");
await buy(1);
const first = await runOnce(ctx);
check(first.status === "rewritten" && !!first.signature, "the first look rewrites the rules on chain");
let book = await readBook(ctx);
check(book.epoch === 1n && book.holdersBps === 6_000, "the rulebook has the new fee split");
const [line] = readLog(logPath);
check(Buffer.from(book.note).equals(noteOf(line.record)) && line.note === book.note.toString("hex"), "the note in the rulebook is the hash of the logged decision");
check(seen[0].market.market_cap_sol > 30 && seen[0].market.sol_in_curve > 0.9 && seen[0].market.pool_transactions_since_last_change >= 1 && seen[0].limits.lowest_max_buy_pct === 0.25, `it was shown the market: ${JSON.stringify(seen[0].market)}`);
const second = await runOnce(ctx);
check(second.status === "too-soon", "a second look right away is turned back before the model is even asked");
check(seen.length === 1, "and costs no model call");

const impostor = await runOnce({ ...ctx, agent: guardian }).then(() => null, (error: Error) => error.message);
check(!!impostor && impostor.includes("is not this token's agent"), "a key that is not the agent does not get as far as deciding");
const outside = await new Promise((r) => setTimeout(r, (LIMITS.minIntervalSecs + 1) * 1000))
  .then(() => runOnce({ ...ctx, decide: async () => ({ action: "rewrite", change: { ...OPEN, maxBuyBps: 10 }, announcement: "x", reasoning: "x", model: "stand-in" }) }))
  .then(() => null, (error: Error) => error.message);
check(!!outside && outside.includes("outside the limits"), "a decision outside the limits is dropped before it is sent");

console.log("on its own");
const events: (Outcome | { status: "error"; error: unknown })[] = [];
const stop = new AbortController();
// Quiet-market looks are a minute apart here, so within this test only a move in the market can wake it.
const running = watch(ctx, { pollSecs: 1, thinkEverySecs: 60, wakeOnMovePct: 5, signal: stop.signal, report: (event) => events.push(event) });
const until = async (what: string, done: () => boolean, seconds: number) => {
  for (let i = 0; i < seconds * 4 && !done(); i++) await new Promise((r) => setTimeout(r, 250));
  check(done(), what);
};
await until("it looks by itself and holds when that is its answer", () => events.some((e) => e.status === "held"), 15);
const before = events.filter((e) => e.status === "rewritten").length;
await buy(3); // moves the market cap well past 5%
await until("a jump in the market makes it look again, and it rewrites the rules", () => events.filter((e) => e.status === "rewritten").length > before, 15);
book = await readBook(ctx);
check(book.gateUntil > 0 && book.holdersBps === 7_000, "the app-only window and the new fee split are on chain");
check(seen.at(-1)!.history.length >= 2 && seen.at(-1)!.history[0].announcement === "rules #1", "it is shown its own earlier decisions");

await sendAndConfirmTransaction(connection, new Transaction().add(pauseIx({ program: HOOK, guardian: guardian.publicKey, mint: mint.publicKey, paused: true })), [guardian], { commitment: "confirmed" });
const calls = seen.length;
await buy(2); // a paused hook enforces nothing, so this goes through the open window
await until("the guardian's pause stops it", () => events.at(-1)?.status === "paused", 20);
check(seen.length === calls, "and a paused agent asks the model nothing");
stop.abort();
await running;
check(!events.some((e) => e.status === "error"), `no errors along the way${events.filter((e) => e.status === "error").map((e) => ` ${String((e as { error: unknown }).error)}`).join(";")}`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
