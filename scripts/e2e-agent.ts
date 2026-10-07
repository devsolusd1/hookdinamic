// The agent's loop on a local validator (scripts/validator.sh), with a stand-in for the model:
// it proves everything around the model's answer. Market in, a pick from the catalogue out,
// the edict on chain, a log line whose hash matches the note in the rulebook.
//
//   npm run validator        (in one terminal; needs WSL)
//   npm run e2e:agent
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getTokenMetadata, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { FEE_HOOKS, recogniseRule, recogniseSplit, worded } from "../site/hooks.js";
import { buyingLabel, changeOf, noteOf, readBook, readLog, runOnce, somebodyCanBuy, unfit, watch, type Choice, type Context, type Decide, type Outcome, type Snapshot } from "../src/agent.js";
import { compile, describe, pauseIx, type Change, type Clause, type Limits, type Name, type Split } from "../src/hook.js";
import { launch } from "../src/launch.js";
import { byRote } from "./stand-in.js";

const local = JSON.parse(readFileSync(new URL("../.local/validator.json", import.meta.url), "utf8")) as { rpc: string; hookProgram: string };
const connection = new Connection(local.rpc, "confirmed");
const HOOK = new PublicKey(local.hookProgram);
const dbc = DynamicBondingCurveClient.create(connection, "confirmed");

const LIMITS: Limits = { minIntervalSecs: 6, maxRuleSecs: 6 * 3600, maxTreasuryBps: 3_000, minRenameSecs: 30 };
const SPLIT: Split = { holdersBps: 5_000, burnBps: 3_000, treasuryBps: 2_000 };
const NAMES: Name[] = [{ name: "Agent Hook Test", symbol: "AHT" }, { name: "Second Name", symbol: "SECOND" }, { name: "A Third And Rather Longer Name", symbol: "THIRD" }];
const rule = (clauses: Clause[], seconds = 3600, split = SPLIT): Change => ({ ruleSecs: seconds, rule: compile(clauses), ...split });
const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));

let failures = 0;
function check(ok: boolean, what: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
}

console.log("could anybody buy?");
{
  // 08:10 UTC on a Friday, with 2 SOL in the curve
  const facts = { now: 1_800_000_600, curveSolThousandths: 2_000, appAvailable: true };
  const can = (clauses: Clause[], seconds = 3600, appAvailable = true) => somebodyCanBuy(rule(clauses, seconds), { ...facts, appAvailable });
  check(can([]), "with no rule, yes");
  check(can([{ group: 1, fact: "size", op: "<=", value: 1 }]), "a cap on size leaves room under it");
  check(!can([{ group: 1, fact: "luck", op: ">", value: 99 }]), "luck never goes above 99");
  check(!can([{ group: 1, fact: "size", op: "<", value: 1 }, { group: 1, fact: "size", op: ">", value: 2 }]), "no buy is under 1% and over 2% at once");
  check(can([{ group: 1, fact: "luck", op: ">", value: 99 }, { group: 2, fact: "held_before", op: "==", value: 0 }]), "one group that can be met is enough");
  check(!can([{ group: 1, fact: "hour", op: "==", value: 20 }]), "an hour that does not come while the rule lasts is no use");
  check(can([{ group: 1, fact: "hour", op: "==", value: 20 }], 6 * 3600 * 2), "the same hour, in a rule long enough to reach it, is");
  check(!can([{ group: 1, fact: "weekday", op: "==", value: 1 }]), "nor is a Monday in an hour that starts on Friday");
  check(can([{ group: 1, fact: "minute", op: "mod", value: 1, modulus: 2 }]), "odd minutes come round within the hour");
  check(!can([{ group: 1, fact: "curve_sol", op: ">=", value: 50 }]), "a curve that must hold 50 SOL before anyone may add the first is stuck");
  check(!can([{ group: 1, fact: "elapsed", op: ">", value: 3600 }]), "a rule cannot open after it has ended");
  check(!can([{ group: 1, fact: "via_app", op: "==", value: 1 }], 3600, false), "nobody comes through an app the token does not name");
  check(!can([{ group: 1, fact: "size", op: "==", value: 0 }]), "a buy of nothing is not a buy");
}

const [payer, guardian, agent, alice, mint, config] = Array.from({ length: 6 }, () => Keypair.generate());
for (const wallet of [payer, guardian, agent, alice]) {
  const signature = await connection.requestAirdrop(wallet.publicKey, 100 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
}

const { pool } = await launch({
  dbc, hookProgram: HOOK, payer, mint, config,
  feeClaimer: payer.publicKey, guardian: guardian.publicKey, agent: agent.publicKey, cosigner: Keypair.generate().publicKey,
  limits: LIMITS, split: SPLIT,
  curve: { startCapSol: 30, graduationCapSol: 8_000_000, feeBps: 200 },
  names: NAMES, uri: "https://example.com/aht.json",
}, (_what, tx, signers) => sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" }));
const launchedAt = Date.now();

async function buy(solIn: number) {
  const tx = await dbc.pool.swap2WithTransferHook({
    owner: alice.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null,
    swapMode: SwapMode.ExactIn, amountIn: new BN(solIn * LAMPORTS_PER_SOL), minimumAmountOut: new BN(0),
  });
  await sendAndConfirmTransaction(connection, tx, [alice], { commitment: "confirmed" });
}

// The model's part is played by a stand-in that takes the catalogue in order. `seen` keeps
// what it was shown; while `outages` lasts it answers as if the API were down.
const seen: Snapshot[] = [];
let outages = 0;
const minded = (inner: Decide): Decide => async (snapshot, book) => {
  seen.push(snapshot);
  if (outages-- > 0) return { action: "hold", reasoning: "could not reach the model's API; nothing changes", model: "stand-in" };
  return inner(snapshot, book);
};
/** A mind that gives one answer, whatever it is shown. */
const answering = (choice: Choice): Decide => minded(async () => ({ action: "rewrite", choice, announcement: "as told", reasoning: "scripted", model: "stand-in" }));
const tokenName = async () => {
  const metadata = await getTokenMetadata(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
  return `${metadata?.name} (${metadata?.symbol})`;
};
const full = (name: Name) => `${name.name} (${name.symbol})`;

const logPath = join(mkdtempSync(join(tmpdir(), "agent-")), "agent-log.jsonl");
const ctx: Context = { connection, dbc, hookProgram: HOOK, mint: mint.publicKey, pool, agent, logPath, decide: minded(byRote({ keepName: true })) };

console.log("is a pick from the catalogue fit to send?");
let book = await readBook(ctx);
{
  const facts = { now: book.renamedAt + 1, curveSolThousandths: 1_000 };
  const pick = (over: Partial<Choice>): Choice => ({ buying: { hook: "max-buy", setting: 3 }, fees: "buyback-burn", name: null, minutes: 30, ...over });
  const why = (over: Partial<Choice>, at = facts) => unfit(pick(over), book, at);
  const change = changeOf(pick({}), LIMITS);
  check(why({}) === null && describe(change.rule)[0] === "the buy is at most 1% of supply" && change.ruleSecs === 1800 && change.burnBps === 6_300, "a hook at one of its settings is, and comes to a rule, a term and fee shares");
  check(!!why({ buying: { hook: "max-sell", setting: 1 } })?.includes("no buying hook"), "a hook the catalogue does not have is not");
  check(!!why({ buying: { hook: "max-buy", setting: 9 } })?.includes("settings 1 to 4"), "nor a setting the hook does not have");
  check(!!why({ buying: { hook: "slow-open", setting: 1 }, minutes: 10 })?.includes("at least 15 minutes"), "nor a slow opening in an edict too short for it to open");
  check(!!why({ minutes: 361 })?.includes("between 1 and 360"), "nor an edict that stands longer than the limit");
  check(!!why({ fees: "to-me" })?.includes("no fee hook"), "nor a fee hook the catalogue does not have");
  check(!!why({ name: 3 })?.includes("names 1 to 3") && !!why({ name: 0 })?.includes("already goes by"), "nor a name the token does not have, or the one it has");
  check(!!why({ name: 1 })?.includes("cannot change for another") && why({ name: 1 }, { ...facts, now: book.renamedAt + LIMITS.minRenameSecs }) === null, "nor a new name before the old one has had its time");
  check(FEE_HOOKS.every((hook) => changeOf(pick({ fees: hook.id }), { ...LIMITS, maxTreasuryBps: 500 }).treasuryBps <= 500), "no fee hook gives the treasury more than a token's cap");
}

console.log("one look at a time");
await buy(1);
const first = await runOnce(ctx);
check(first.status === "rewritten" && !!first.signature, "the first look issues an edict on chain");
const sent = first.status === "rewritten" ? first : null;
book = await readBook(ctx);
const onChain = recogniseRule(book.rule);
check(book.epoch === 1n && onChain?.hook.id === sent?.choice.buying?.hook && onChain?.setting === 1, `the rule in the rulebook is the hook it picked: ${onChain ? worded(onChain.hook.name) : "none"}`);
check(recogniseSplit(book, LIMITS.maxTreasuryBps)?.hook.id === sent?.choice.fees && book.ruleUntil - book.updatedAt === (sent?.choice.minutes ?? 0) * 60, "with that fee hook's shares, for the time it gave");
const [line] = readLog(logPath);
check(Buffer.from(book.note).equals(noteOf(line.record)) && line.note === book.note.toString("hex"), "the note in the rulebook is the hash of the logged decision");
check(line.record.hooks?.buying?.hook === sent?.choice.buying?.hook && line.record.hooks?.fees === sent?.choice.fees, "which names the hooks by their place in the catalogue");
check(seen[0].market.market_cap_sol > 30 && seen[0].market.sol_in_curve > 0.9 && seen[0].market.pool_transactions_since_last_edict >= 1 && seen[0].limits.longest_edict_minutes === 360, `it was shown the market: ${JSON.stringify(seen[0].market)}`);
check(seen[0].in_force.buying === "none" && seen[0].in_force.name === full(NAMES[0]) && seen[0].names.length === 3, "what was in force and the token's names");
check(seen[0].fee_hooks.find((hook) => hook.id === "buyback-burn")?.shares === "holders 27%, burn 63%, treasury 10%", "and what each fee hook would come to");
const second = await runOnce(ctx);
check(second.status === "too-soon", "a second look right away is turned back before the model is even asked");
check(seen.length === 1, "and costs no model call");

const impostor = await runOnce({ ...ctx, agent: guardian }).then(() => null, (error: Error) => error.message);
check(!!impostor && impostor.includes("is not this token's agent"), "a key that is not the agent does not get as far as deciding");
await sleep(LIMITS.minIntervalSecs + 1);
const stray = await runOnce({ ...ctx, decide: answering({ buying: { hook: "max-sell", setting: 1 }, fees: "even-split", name: null, minutes: 30 }) }).then(() => null, (error: Error) => error.message);
check(!!stray && stray.includes("cannot be used") && (await readBook(ctx)).epoch === 1n && readLog(logPath).length === 1, "a pick that is not in the catalogue is dropped before it is sent, and leaves no trace");

console.log("a new name");
await sleep(Math.max(0, LIMITS.minRenameSecs + 1 - (Date.now() - launchedAt) / 1000));
const third = await runOnce({ ...ctx, decide: answering({ buying: null, fees: "buyback-burn", name: 2, minutes: 0.3 }) });
check(third.status === "rewritten", "a look that was not told to wait replaces the edict in force");
book = await readBook(ctx);
check(book.epoch === 2n && book.rule.length === 0 && book.ruleUntil - book.updatedAt === 18, "an edict with no buying hook has a term all the same");
check(book.name === 2 && book.renamedAt === book.updatedAt && (await tokenName()) === full(NAMES[2]), `the token is now called ${await tokenName()}`);
check(book.burnBps === 6_300 && readLog(logPath).at(-1)?.record.hooks?.name === 2, "the fee hook it came with is on chain too, and the record names the new name");
const last = seen.at(-1)!;
check(last.history.length === 1 && last.history[0].buying === buyingLabel(sent?.choice.buying ?? null) && last.history[0].fees === FEE_HOOKS[0].name, "it is shown its own earlier edicts by the names of their hooks");
check(last.in_force.minutes_left > 0 && last.name_change.allowed_now, "what was in force when it looked, and that a new name was allowed");

console.log("on its own");
const events: (Outcome | { status: "error"; error: unknown })[] = [];
const count = (status: string) => events.filter((e) => e.status === status).length;
const stop = new AbortController();
const calls = seen.length;
outages = 1;
// From here every edict stands for twelve seconds, and the stand-in takes the catalogue in order.
const running = watch({ ...ctx, decide: minded(byRote({ minutes: 0.2 })) }, { pollSecs: 1, thinkEverySecs: 2, signal: stop.signal, report: (event) => events.push(event) });
const until = async (what: string, done: () => boolean, seconds: number) => {
  for (let i = 0; i < seconds * 4 && !done(); i++) await sleep(0.25);
  check(done(), what);
};
await until("it leaves an edict that still has time on it alone, rule or no rule", () => count("in-force") > 0, 10);
check(seen.length === calls, "and asks the model nothing meanwhile");
await until("when the time is up it looks by itself; the model cannot be reached, so it issues nothing", () => count("held") === 1, 40);
check(readLog(logPath).at(-1)?.record.action === "hold" && (await readBook(ctx)).epoch === 2n, "which it writes down, changing nothing");
await until("it tries again and issues the next edict", () => count("rewritten") === 1, 20);
book = await readBook(ctx);
check(book.epoch === 3n && book.rule.length > 0 && book.ruleUntil - book.updatedAt === 12, "a buying hook from the catalogue, for twelve seconds");
check((await tokenName()) === full(NAMES[2]), "the name stays: it changed too recently");
await until("then the one after, when those twelve seconds are up", () => count("rewritten") === 2, 40);
await until("and another", () => count("rewritten") === 3, 40);
book = await readBook(ctx);
check(book.epoch === 5n && book.name !== 2 && (await tokenName()) === full(NAMES[book.name]), `by now it has changed its name again, to ${await tokenName()}`);
check(readLog(logPath).filter((entry) => entry.record.hooks && entry.record.hooks.name !== null).length >= 2, "each change of name is in the record, with its edict");

await sendAndConfirmTransaction(connection, new Transaction().add(pauseIx({ program: HOOK, guardian: guardian.publicKey, mint: mint.publicKey, paused: true })), [guardian], { commitment: "confirmed" });
const asked = seen.length;
await until("the guardian's pause stops it", () => events.at(-1)?.status === "paused", 20);
check(seen.length === asked, "and a paused agent asks the model nothing");
stop.abort();
await running;
check(count("error") === 0, `no errors along the way${events.filter((e) => e.status === "error").map((e) => ` ${String((e as { error: unknown }).error)}`).join(";")}`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
