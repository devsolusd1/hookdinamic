// The agent's loop on a local validator (scripts/validator.sh), with a stand-in for the model:
// it proves everything around the model's answer. Market in, a pick from the catalogue out,
// the edict on chain with its words beside it as a memo, a log line whose hash matches the
// note in the rulebook. It is also where the figures behind the transaction's compute limit
// are measured: what the rule, a change of name and the memo really spend. And where the node
// is asked what a wallet has to keep, which is what the agent holds its own wallet to before
// it asks the model.
//
//   npm run validator        (in one terminal; needs WSL)
//   npm run e2e:agent
import "../src/quiet.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getTokenMetadata, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { FEE_HOOKS, recogniseRule, recogniseSplit, worded } from "../site/hooks.js";
import {
  ANNOUNCEMENT_MAX, buyingLabel, changeOf, EDICT_UNITS_MOST, edictFee, edictTransaction, edictUnits, figuresInWords, lamportsForAnEdict, MEMO_PROGRAM, MEMO_UNITS, memoIx, memoUnits, NAME_UNITS, noteOf, outsideLimits, PRIORITY_MICROLAMPORTS, readBook, readLog, RULE_UNITS, runOnce, somebodyCanBuy, unfit, WALLET_LEAST, watch,
  type Choice, type Context, type Decide, type Outcome, type Snapshot,
} from "../src/agent.js";
import { compile, describe, MAX_CONDITIONS, pauseIx, setRulesIx, type Change, type Clause, type Limits, type Name, type Split } from "../src/hook.js";
import { launch } from "../src/launch.js";
import { byRote } from "./stand-in.js";

const local = JSON.parse(readFileSync(new URL("../.local/validator.json", import.meta.url), "utf8")) as { rpc: string; hookProgram: string };
const connection = new Connection(local.rpc, "confirmed");
const HOOK = new PublicKey(local.hookProgram);
const dbc = DynamicBondingCurveClient.create(connection, "confirmed");

// The treasury's floor and cap are the ones the token launches with, and so is the fee.
const LIMITS: Limits = { minIntervalSecs: 6, maxRuleSecs: 6 * 3600, minTreasuryBps: 4_000, maxTreasuryBps: 5_000, minRenameSecs: 30 };
const SPLIT: Split = { holdersBps: 3_000, burnBps: 3_000, treasuryBps: 4_000 };
// The last name is in signs of three bytes each: the kind a change of name costs the most compute to write.
const NAMES: Name[] = [{ name: "Agent Hook Test", symbol: "AHT" }, { name: "Second Name", symbol: "SECOND" }, { name: "A Third And Rather Longer Name", symbol: "THIRD" }, { name: "€".repeat(10), symbol: "€€€" }];
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
  guardian: guardian.publicKey, agent: agent.publicKey, keeper: Keypair.generate().publicKey, cosigner: Keypair.generate().publicKey,
  limits: LIMITS, split: SPLIT,
  curve: { startCapSol: 30, feeBps: 300 },
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
const answering = (choice: Choice, announcement = "as told"): Decide => minded(async () => ({ action: "rewrite", choice, announcement, reasoning: "scripted", model: "stand-in" }));
const tokenName = async () => {
  const metadata = await getTokenMetadata(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
  return `${metadata?.name} (${metadata?.symbol})`;
};
const full = (name: Name) => `${name.name} (${name.symbol})`;

/** What each run of `program` spent according to a transaction's log, and what the transaction had left when the run began. */
const runsOf = (program: PublicKey, logs: string[]) =>
  logs.flatMap((line) => {
    const said = line.match(/^Program (\S+) consumed (\d+) of (\d+) compute units$/);
    return said && said[1] === program.toBase58() ? [{ spent: Number(said[2]), had: Number(said[3]) }] : [];
  });

/**
 * An edict's transaction, read from the node twice over: as it was sent, for the memo's own
 * bytes and who had to sign it, and parsed, which is how an explorer reads it. Null if the
 * node does not have it.
 */
async function transactionOf(signature: string | null | undefined) {
  if (!signature) return null;
  const finding = { commitment: "confirmed", maxSupportedTransactionVersion: 0 } as const;
  // A node can confirm a transaction a moment before it can show it.
  let [sent, shown] = [await connection.getTransaction(signature, finding), await connection.getParsedTransaction(signature, finding)];
  for (let i = 0; i < 20 && !(sent && shown); i++) {
    await sleep(0.5);
    [sent, shown] = [await connection.getTransaction(signature, finding), await connection.getParsedTransaction(signature, finding)];
  }
  if (!sent || !shown) return null;
  const { message } = sent.transaction;
  const keys = message.staticAccountKeys;
  const memo = message.compiledInstructions.find((instruction) => keys[instruction.programIdIndex].equals(MEMO_PROGRAM));
  const parsed = shown.transaction.message.instructions.filter((instruction) => instruction.programId.equals(MEMO_PROGRAM));
  const logs = sent.meta?.logMessages ?? [];
  // The compute-budget program's two instructions: a 2 and the units asked for, a 3 and the price bid for each.
  const budget = message.compiledInstructions.filter((instruction) => keys[instruction.programIdIndex].equals(ComputeBudgetProgram.programId)).map((instruction) => Buffer.from(instruction.data));
  const [limit, price] = [budget.find((data) => data[0] === 2), budget.find((data) => data[0] === 3)];
  const read = {
    /** The program each instruction goes to, in order. */
    programs: message.compiledInstructions.map((instruction) => keys[instruction.programIdIndex].toBase58()),
    /** The compute units it asked for, the price it bid for each in micro-lamports (null: it named none), what the network charged it in lamports, and its size on the wire. */
    asked: limit ? limit.readUInt32LE(1) : 0,
    price: price ? Number(price.readBigUInt64LE(1)) : null,
    fee: sent.meta?.fee ?? 0,
    bytes: 1 + 64 * sent.transaction.signatures.length + message.serialize().length,
    /** The memo's data, and whether the one account it names is the agent, signing. */
    data: memo ? Buffer.from(memo.data) : null,
    agentSigned: memo?.accountKeyIndexes.length === 1 && keys[memo.accountKeyIndexes[0]].equals(agent.publicKey) && message.isAccountSigner(memo.accountKeyIndexes[0]),
    /** What an explorer shows for the memo: the program by name, and the words. */
    explorer: parsed.length === 1 && "parsed" in parsed[0] ? { program: parsed[0].program, words: parsed[0].parsed as unknown } : null,
    logs,
    memoRun: runsOf(MEMO_PROGRAM, logs)[0],
    hookRuns: runsOf(HOOK, logs),
    spent: sent.meta?.computeUnitsConsumed ?? 0,
    failed: sent.meta?.err ?? null,
  };
  edictsRead.push(read);
  return read;
}
const inUtf8 = (text: string | undefined) => Buffer.from(text ?? "", "utf8");
const BUDGET = ComputeBudgetProgram.programId;
const inOrder = (...programs: PublicKey[]) => programs.map((program) => program.toBase58()).join();
type Read = { asked: number; price: number | null; fee: number; bytes: number; spent: number; hookRuns: { spent: number }[]; memoRun?: { spent: number; had: number }; failed: unknown };
/** Every edict's transaction read back in this run, for the figures at the end. */
const edictsRead: Read[] = [];
/** Whether a transaction used no more than its parts were reckoned at: the tenth it asked for on top was left untouched. */
const withinReckoning = (tx: Read | null) => !!tx && tx.failed === null && tx.spent * 11 <= tx.asked * 10;
const share = (tx: Read | null) => (tx ? `${((tx.spent / tx.asked) * 100).toFixed(1)}%` : "?");

const logPath = join(mkdtempSync(join(tmpdir(), "agent-")), "agent-log.jsonl");
const ctx: Context = { connection, dbc, hookProgram: HOOK, mint: mint.publicKey, pool, agent, logPath, decide: minded(byRote({ keepName: true })) };

console.log("is a pick from the catalogue fit to send?");
let book = await readBook(ctx);
{
  const facts = { now: book.renamedAt + 1, curveSolThousandths: 1_000 };
  const pick = (over: Partial<Choice>): Choice => ({ buying: { hook: "max-buy", setting: 3 }, fees: "buyback-burn", name: null, minutes: 30, ...over });
  const why = (over: Partial<Choice>, at = facts) => unfit(pick(over), book, at);
  const change = changeOf(pick({}), LIMITS);
  check(why({}) === null && describe(change.rule)[0] === "the buy is at most 1% of supply" && change.ruleSecs === 1800 && change.burnBps === 4_200 && change.treasuryBps === 4_000, "a hook at one of its settings is, and comes to a rule, a term and fee shares");
  check(!!why({ buying: { hook: "max-sell", setting: 1 } })?.includes("no buying hook"), "a hook the catalogue does not have is not");
  check(!!why({ buying: { hook: "max-buy", setting: 9 } })?.includes("settings 1 to 4"), "nor a setting the hook does not have");
  check(!!why({ buying: { hook: "slow-open", setting: 1 }, minutes: 10 })?.includes("at least 15 minutes"), "nor a slow opening in an edict too short for it to open");
  check(!!why({ minutes: 361 })?.includes("between 1 and 360"), "nor an edict that stands longer than the limit");
  check(!!why({ fees: "to-me" })?.includes("no fee hook"), "nor a fee hook the catalogue does not have");
  check(!!why({ name: NAMES.length })?.includes(`names 1 to ${NAMES.length}`) && !!why({ name: 0 })?.includes("already goes by"), "nor a name the token does not have, or the one it has");
  check(!!why({ name: 1 })?.includes("cannot change for another") && why({ name: 1 }, { ...facts, now: book.renamedAt + LIMITS.minRenameSecs }) === null, "nor a new name before the old one has had its time");
  const within = (minTreasuryBps: number, maxTreasuryBps: number) =>
    FEE_HOOKS.every((hook) => {
      const limits = { ...LIMITS, minTreasuryBps, maxTreasuryBps };
      const shares = changeOf(pick({ fees: hook.id }), limits);
      return shares.treasuryBps >= minTreasuryBps && shares.treasuryBps <= maxTreasuryBps && outsideLimits(shares, limits, true) === null;
    });
  check(within(0, 500) && within(1_000, 3_000) && within(2_500, 2_500) && within(LIMITS.minTreasuryBps, LIMITS.maxTreasuryBps), "no fee hook gives the treasury more than a token's cap or less than its floor");
  const inShort = FEE_HOOKS.map((hook) => changeOf(pick({ fees: hook.id }), LIMITS)).map((shares) => `${shares.holdersBps / 100}/${shares.burnBps / 100}/${shares.treasuryBps / 100}`).join(" ");
  check(inShort === "30/30/40 18/42/40 42/18/40 25/25/50", `between a floor of 40% and a cap of 50% the four fee hooks come to ${inShort} (holders/burn/treasury)`);
  const under = outsideLimits({ ...change, holdersBps: 6_001, burnBps: 0, treasuryBps: 3_999 }, LIMITS, true);
  const over = outsideLimits({ ...change, holdersBps: 4_999, burnBps: 0, treasuryBps: 5_001 }, LIMITS, true);
  check(!!under?.includes("at least 40%") && !!over?.includes("at most 50%") && outsideLimits({ ...change, holdersBps: 6_000, burnBps: 0, treasuryBps: 4_000 }, LIMITS, true) === null, "shares that leave the treasury under its floor or over its cap are caught before they are sent");
}

console.log("one look at a time");
await buy(1);
const first = await runOnce(ctx);
check(first.status === "rewritten" && !!first.signature, "the first look issues an edict on chain");
const sent = first.status === "rewritten" ? first : null;
book = await readBook(ctx);
const onChain = recogniseRule(book.rule);
check(book.epoch === 1n && onChain?.hook.id === sent?.choice.buying?.hook && onChain?.setting === 1, `the rule in the rulebook is the hook it picked: ${onChain ? worded(onChain.hook.name) : "none"}`);
check(recogniseSplit(book, LIMITS.maxTreasuryBps, LIMITS.minTreasuryBps)?.hook.id === sent?.choice.fees && book.ruleUntil - book.updatedAt === (sent?.choice.minutes ?? 0) * 60, "with that fee hook's shares, for the time it gave");
const [line] = readLog(logPath);
check(Buffer.from(book.note).equals(noteOf(line.record)) && line.note === book.note.toString("hex"), "the note in the rulebook is the hash of the logged decision");
check(line.record.hooks?.buying?.hook === sent?.choice.buying?.hook && line.record.hooks?.fees === sent?.choice.fees, "which names the hooks by their place in the catalogue");
const firstTx = await transactionOf(line.signature);
check(firstTx?.programs.join() === inOrder(BUDGET, BUDGET, HOOK, MEMO_PROGRAM) && firstTx.failed === null, "the edict's transaction says what it asks for and what it bids, then holds the rule, and a memo right after it");
check(!!firstTx?.data?.equals(inUtf8(line.record.announcement)) && line.record.announcement === sent?.announcement && line.record.memo === line.record.announcement && sent?.memo === line.record.memo, `the memo is the announcement, byte for byte, and the record says so: ${line.record.announcement}`);
check(firstTx?.asked === edictUnits(line.record.memo ?? "", false) && firstTx.price === PRIORITY_MICROLAMPORTS && firstTx.fee === edictFee(firstTx.asked, PRIORITY_MICROLAMPORTS) && sent?.transaction.units === firstTx.asked && sent.transaction.feeLamports === firstTx.fee && sent.transaction.bytes === firstTx.bytes, `it asked for ${firstTx?.asked} compute units, where it used to be given 400,000 unasked, and bid ${firstTx?.price} micro-lamports for each: the network charged it ${firstTx?.fee} lamports, which is what the agent said it would (${sent ? figuresInWords(sent.transaction) : ""})`);
check(!!firstTx?.agentSigned && firstTx.logs.includes(`Program log: Signed by ${agent.publicKey.toBase58()}`), "the agent signed the memo, and the Memo program says so in the transaction's log");
check(firstTx?.explorer?.program === "spl-memo" && firstTx.explorer.words === line.record.announcement && firstTx.logs.some((said) => said.startsWith(`Program log: Memo (len ${inUtf8(line.record.announcement).length}): `)), "read as an explorer reads it (getTransaction, parsed), the transaction shows the words");
check(!!firstTx && firstTx.memoRun.spent <= memoUnits(line.record.announcement ?? "") && firstTx.memoRun.had >= memoUnits(line.record.announcement ?? "") && withinReckoning(firstTx), `the memo cost ${firstTx?.memoRun.spent} compute units, under the ${memoUnits(line.record.announcement ?? "")} it was reckoned at, and after the rule (${firstTx?.hookRuns[0]?.spent} units) the transaction still had ${firstTx?.memoRun.had} for it; in all it used ${firstTx?.spent}, ${share(firstTx)} of what it asked for`);
check(seen[0].market.market_cap_sol > 30 && seen[0].market.sol_in_curve > 0.9 && seen[0].market.pool_transactions_since_last_edict >= 1 && seen[0].limits.longest_edict_minutes === 360, `it was shown the market: ${JSON.stringify(seen[0].market)}`);
check(seen[0].in_force.buying === "none" && seen[0].in_force.name === full(NAMES[0]) && seen[0].names.length === NAMES.length, "what was in force and the token's names");
check(seen[0].fee_hooks.find((hook) => hook.id === "buyback-burn")?.shares === "holders 18%, burn 42%, treasury 40%", "and what each fee hook would come to");
check(seen[0].limits.treasury_least_pct === 40 && seen[0].limits.treasury_most_pct === 50 && seen[0].in_force.fees === FEE_HOOKS[0].name, "the least and the most the treasury may get, and the opening split by its hook's name");
const second = await runOnce(ctx);
check(second.status === "too-soon", "a second look right away is turned back before the model is even asked");
check(seen.length === 1, "and costs no model call");

const impostor = await runOnce({ ...ctx, agent: guardian }).then(() => null, (error: Error) => error.message);
check(!!impostor && impostor.includes("is not this token's agent"), "a key that is not the agent does not get as far as deciding");
await sleep(LIMITS.minIntervalSecs + 1);
const stray = await runOnce({ ...ctx, decide: answering({ buying: { hook: "max-sell", setting: 1 }, fees: "even-split", name: null, minutes: 30 }) }).then(() => null, (error: Error) => error.message);
check(!!stray && stray.includes("cannot be used") && (await readBook(ctx)).epoch === 1n && readLog(logPath).length === 1, "a pick that is not in the catalogue is dropped before it is sent, and leaves no trace");

console.log("the agent's own wallet");
{
  // On a day when the owner has raised the price: a lamport for every unit asked for.
  const price = 1_000_000;
  const needs = lamportsForAnEdict(price);
  const move = (from: Keypair, to: Keypair, lamports: number) => sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to.publicKey, lamports })), [from], { commitment: "confirmed" });
  const holds = () => connection.getBalance(agent.publicKey, "confirmed");
  check((await connection.getMinimumBalanceForRentExemption(0)) === WALLET_LEAST, `the least a wallet may be left holding is what the node says an account with no data needs to be exempt from rent: ${WALLET_LEAST} lamports, the figure the agent reckons with`);

  // All the agent has goes to another wallet, but for one lamport less than an edict can take. The transfer itself costs its signature.
  await move(agent, alice, (await holds()) - 5_000 - (needs - 1));
  const left = await holds();
  const asked = seen.length;
  const thin: Context = { ...ctx, priorityMicroLamports: price, decide: answering({ buying: { hook: "max-wallet", setting: 2 }, fees: "holders-payday", name: null, minutes: 30 }) };
  const short = await runOnce(thin);
  check(left === needs - 1 && short.status === "short" && short.funds.holds === left && short.funds.needs === needs && seen.length === asked && (await readBook(ctx)).epoch === 1n && readLog(logPath).length === 1, `with ${left} lamports in its wallet, one short of the ${needs} an edict can take at ${price} micro-lamports a unit, a look at which an edict is due ends before the model is asked: nothing is sent and nothing written down`);
  const rehearsedThin = await runOnce({ ...thin, dryRun: true });
  check(rehearsedThin.status === "rewritten" && rehearsedThin.signature === null && rehearsedThin.funds?.holds === left && rehearsedThin.funds.needs === needs && seen.length === asked + 1 && (await readBook(ctx)).epoch === 1n, "a dry run with that wallet goes ahead, and carries what the wallet held for its caller to speak of");

  // The node's own word on that last lamport. Nothing is sent: it is asked to run a transaction
  // that pays exactly what the dearest edict pays, from this wallet.
  const asDearAsAnEdict = async () => {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: EDICT_UNITS_MOST }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }), memoIx(agent.publicKey, "As dear as an edict can be."));
    tx.feePayer = agent.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(agent);
    return (await connection.simulateTransaction(tx)).value.err;
  };
  const oneShort = await asDearAsAnEdict();
  await move(alice, agent, 1);
  const exact = await asDearAsAnEdict();
  check((await holds()) === needs && JSON.stringify(oneShort).includes("InsufficientFundsForRent") && exact === null, `the node agrees to the lamport: from that wallet it refuses a transaction that pays the ${edictFee(EDICT_UNITS_MOST, price)} lamports of the dearest edict, because the wallet would be left with less than it has to keep (${JSON.stringify(oneShort)}), and with one lamport more it takes it`);

  // The wallet is filled again for the rest of the run. The next look, further down, goes ahead by itself.
  await move(alice, agent, 50 * LAMPORTS_PER_SOL);
}

console.log("what the Memo program charges");
// The dearest character of each stretch of Unicode, from U+007F up to the last one there is,
// as running every character through this program found them.
const DEAREST = [0x7f, 0x8a, 0x7ba, 0xfdb, 0x1fff, 0x205f, 0x244b, 0x2ffc, 0x31ea, 0x9ffa, 0xabfa, 0xd7fc, 0xeaaa, 0xffef, 0x1eefa, 0x1faaa, 0x1fffd, 0x2b738, 0x10fffd].map((code) => String.fromCodePoint(code));
{
  /** What the Memo program spends on `text` signed by the agent. Nothing is sent: the node is asked to run it, with the most compute a transaction may ask for. */
  const charged = async (text: string) => {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), memoIx(agent.publicKey, text));
    tx.feePayer = agent.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(agent);
    const { value } = await connection.simulateTransaction(tx);
    return value.err ? Infinity : (runsOf(MEMO_PROGRAM, value.logs ?? [])[0]?.spent ?? Infinity);
  };
  const texts = [
    "",
    "Plain words, and nothing else. ".repeat(8).slice(0, ANNOUNCEMENT_MAX),
    // As long as a transaction has room for, in plain letters and in signs the program writes out as two.
    "Plain words, and nothing else. ".repeat(26),
    "\"".repeat(800),
    "\"It's\" a \\ and a\ttab\nand a new line. ".repeat(6),
    "For the next 30 minutes: Newcomers · up to 0.25%, and Holders’ Payday for the fees.",
    "“Slow” — ‘steady’ – small … 2% → 1%, 40 € ✓ ".repeat(3),
    "Aufträge, crédito, señal, Ωμέγα, Привет, שלום ".repeat(5),
    "你好，世界。한국어 テスト ".repeat(4),
    "\u{1f642} \u{1f680}\u{1f525} ok ".repeat(6),
    // Each of the dearest by itself, and then taking turns with plain letters, which makes the program stop and start its writing.
    ...DEAREST.flatMap((sign) => [sign.repeat(Math.min(60, Math.floor(1_200_000 / memoUnits(sign)))), `${sign} a`.repeat(40)]),
    DEAREST.join(" ").repeat(3),
  ];
  const costs: number[] = [];
  for (const text of texts) costs.push(await charged(text));
  const over = texts.filter((text, i) => costs[i] > memoUnits(text));
  const closest = Math.max(...texts.map((text, i) => costs[i] / memoUnits(text)));
  check(over.length === 0, `no memo costs more than the agent reckons: ${texts.length} texts run by the program itself, from an empty one (${costs[0]} units) to the dearest character of every stretch of Unicode, and the closest took ${(closest * 100).toFixed(1)}% of its estimate${over.map((text) => ` OVER: ${JSON.stringify(text)}`).join("")}`);
  check(costs[1] < 110_000 && costs[1] <= memoUnits(texts[1]), `${ANNOUNCEMENT_MAX} characters in plain letters cost ${costs[1]} units (reckoned at ${memoUnits(texts[1])})`);
  // What the model is told a sign costs next to a plain letter. Each is tried among words, as it would come in a sentence.
  const letter = (costs[1] - costs[0]) / texts[1].length;
  const among = async (sign: string) => ((await charged(`word${sign} `.repeat(40))) - (await charged("word ".repeat(40)))) / 40 / letter;
  const [accented, dot, apostrophe, dash, face] = [await among("é"), await among("·"), await among("’"), await among("—"), await among("\u{1f642}")];
  check(accented > 1 && accented < 2 && dot > 1 && dot < 2 && apostrophe > 20 && apostrophe < 30 && dash > 20 && dash < 30 && face > 45 && face < 55, `the prices the model is told are the program's own: next to a plain letter (${letter.toFixed(0)} units) an accented letter costs ${accented.toFixed(1)} times as much and a middle dot ${dot.toFixed(1)}, both under twice; a curly apostrophe ${apostrophe.toFixed(1)} times and a long dash ${dash.toFixed(1)}, about twenty-five; an emoji ${face.toFixed(1)}, about fifty`);
}

console.log("what the largest rule would cost");
{
  // Sixteen conditions, the most the program takes, of the kind it works hardest on. The catalogue's own rules have one or two. Run by the node, not sent.
  const largest = rule(Array.from({ length: MAX_CONDITIONS }, (_, i): Clause => ({ group: (i % 4) + 1, fact: "minute", op: "mod", value: 1, modulus: 2 })));
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), setRulesIx({ program: HOOK, agent: agent.publicKey, mint: mint.publicKey, change: largest }));
  tx.feePayer = agent.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(agent);
  const { value } = await connection.simulateTransaction(tx);
  const spent = runsOf(HOOK, value.logs ?? [])[0]?.spent ?? Infinity;
  check(value.err === null && (value.unitsConsumed ?? 0) - spent === 150 && spent + 300 <= RULE_UNITS / 2, `a rule of ${MAX_CONDITIONS} conditions costs the program ${spent} units, and the instruction that sets the limit ${(value.unitsConsumed ?? 0) - spent}: with the two instructions an edict has in front of its rule that comes to ${spent + 300}, under half of the ${RULE_UNITS} an edict allows for them${value.err ? ` FAILED ${JSON.stringify(value.err)}` : ""}`);
}

console.log("words that would be cut down to signs");
{
  // An announcement that has words and opens with twenty rockets. The Memo program could
  // afford fifteen of them and an ellipsis, which says nothing, so the edict goes without a
  // memo: a transaction of the limit, the price and the rule, and nothing after. Run by the
  // node, not sent.
  const said = `${"\u{1f680}".repeat(20)} Max Buy · 1% is on for 30 minutes. Selling is never restricted.`;
  const hooks = { buying: { hook: "max-buy", setting: 3 }, fees: "buyback-burn", name: null };
  const made = edictTransaction({
    program: HOOK, agent: agent.publicKey, mint: mint.publicKey, change: changeOf({ ...hooks, minutes: 30 }, LIMITS),
    record: { mint: mint.publicKey.toBase58(), epoch: 2, at: new Date().toISOString(), action: "rewrite", hooks, announcement: said, reasoning: "scripted", model: "stand-in" },
  });
  made.tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  made.tx.sign(agent);
  const { value } = await connection.simulateTransaction(made.tx);
  const logs = value.logs ?? [];
  check(made.memo === "" && made.record.memo === "" && made.record.announcement === said && made.units === edictUnits("", false) && made.tx.instructions.every((instruction) => !instruction.programId.equals(MEMO_PROGRAM)), `an announcement of ${said.length} characters that opens with twenty rockets has no memo the chain could afford that says anything, so its edict is built without one: ${figuresInWords(made)}`);
  check(value.err === null && runsOf(HOOK, logs).length === 1 && runsOf(MEMO_PROGRAM, logs).length === 0 && (value.unitsConsumed ?? Infinity) * 11 <= made.units * 10, `the node runs that transaction as it stands: the rule and no memo, using ${value.unitsConsumed} of the ${made.units} compute units it asks for${value.err ? ` FAILED ${JSON.stringify(value.err)}` : ""}`);
}

console.log("words the chain could not afford whole");
// The dearest sign there is, and the dearest of two cheaper kinds and of the accented letters.
const [DEAR, LESS_DEAR, LESSER, ACCENTED] = [0x1faaa, 0xffef, 0x2ffc, 0x7ba].map((code) => String.fromCodePoint(code));
// Words made of those, so that what the memo really costs comes as near to what it may cost as it can.
const dear = `${DEAR} ${LESS_DEAR} ${LESSER} a b c d e f g h `.repeat(10).trim();
// On a day when the owner has raised the price: a lamport for every unit asked for.
const BUSY = 1_000_000;
const sayingDear: Context = { ...ctx, priorityMicroLamports: BUSY, decide: answering({ buying: { hook: "max-wallet", setting: 2 }, fees: "holders-payday", name: null, minutes: 30 }, dear) };
// First as a rehearsal, which builds the transaction and sends nothing.
const rehearsed = await runOnce({ ...sayingDear, dryRun: true });
check(rehearsed.status === "rewritten" && rehearsed.signature === null && rehearsed.memo.endsWith("…") && rehearsed.memo !== dear && (await readBook(ctx)).epoch === 1n && readLog(logPath).length === 1, `a dry run says what the memo would be, here that it would be cut, and leaves the chain and the log as they were: ${rehearsed.status === "rewritten" ? figuresInWords(rehearsed.transaction) : ""}`);
const cut = await runOnce(sayingDear);
const cutLine = readLog(logPath).at(-1)!;
const cutTx = await transactionOf(cutLine.signature);
book = await readBook(ctx);
const memoWords = cutLine.record.memo ?? "";
check(cut.status === "rewritten" && book.epoch === 2n && memoUnits(dear) > MEMO_UNITS && cut.memo === cutLine.record.memo && cutLine.record.announcement === dear, `an edict whose words would cost too much (reckoned at ${memoUnits(dear)} units) lands all the same, and its record keeps the announcement whole`);
check(cut.status === "rewritten" && !!cut.funds && cut.funds.needs === lamportsForAnEdict(BUSY) && cut.funds.holds >= cut.funds.needs, `with its wallet filled again the agent went ahead by itself: before asking the model it found ${cut.status === "rewritten" ? cut.funds?.holds : "?"} lamports there, of the ${lamportsForAnEdict(BUSY)} an edict can take at that price`);
check(rehearsed.status === "rewritten" && cut.status === "rewritten" && rehearsed.memo === cut.memo && JSON.stringify(rehearsed.transaction) === JSON.stringify(cut.transaction) && cutTx?.bytes === rehearsed.transaction.bytes && cutTx.asked === rehearsed.transaction.units && cutTx.fee === rehearsed.transaction.feeLamports, "what the rehearsal said is what was then sent: the same memo, a transaction of the same size asking for the same units, and the fee the network charged");
check(cutTx?.price === BUSY && cutTx.asked === edictUnits(memoWords, false) && cutTx.fee === 5_000 + cutTx.asked, `with the price set to ${BUSY} micro-lamports it bid that, and paid ${cutTx?.fee} lamports: a lamport for each of the ${cutTx?.asked} units it asked for, on top of the 5,000 of its signature`);
check(memoWords.endsWith("…") && dear.startsWith(memoWords.slice(0, -1)) && /\s/.test(dear[memoWords.length - 1]) && memoUnits(memoWords) <= MEMO_UNITS, `the record says what the memo was: the first ${memoWords.length - 1} of its ${dear.length} characters, cut after a whole word and closed with an ellipsis`);
check(!!cutTx?.data?.equals(inUtf8(memoWords)) && cutTx.agentSigned && cutTx.explorer?.words === memoWords && cutTx.failed === null, "and that, byte for byte, is the memo in its transaction and what an explorer shows");
check(Buffer.from(book.note).equals(noteOf(cutLine.record)) && cutLine.note === book.note.toString("hex"), "the note in the rulebook is the hash of that record: the whole announcement, and the memo as it was cut");
check(!!cutTx && cutTx.memoRun.spent <= memoUnits(memoWords) && cutTx.memoRun.spent > 0.9 * MEMO_UNITS && cutTx.memoRun.had >= memoUnits(memoWords) && withinReckoning(cutTx), `the memo cost ${cutTx?.memoRun.spent} compute units of the ${MEMO_UNITS} it may (reckoned at ${memoUnits(memoWords)}), and the transaction had ${cutTx?.memoRun.had} left for it: with a memo as dear as they come it used ${share(cutTx)} of what it asked for`);

console.log("a new name");
// Words that only just fit: the dearest signs, as many as a memo can afford, and plain letters up to the limit.
const edge = `${`${DEAR.repeat(12)} ${ACCENTED.repeat(6)} `.padEnd(ANNOUNCEMENT_MAX - 1, "and a new name, ")}.`;
await sleep(Math.max(LIMITS.minIntervalSecs + 1, LIMITS.minRenameSecs + 1 - (Date.now() - launchedAt) / 1000));
// This one with the price set to 0: it bids nothing, and says nothing about a price.
const third = await runOnce({ ...ctx, priorityMicroLamports: 0, decide: answering({ buying: null, fees: "buyback-burn", name: 2, minutes: 0.3 }, edge) });
check(third.status === "rewritten", "a look that was not told to wait replaces the edict in force");
book = await readBook(ctx);
check(book.epoch === 3n && book.rule.length === 0 && book.ruleUntil - book.updatedAt === 18, "an edict with no buying hook has a term all the same");
check(book.name === 2 && book.renamedAt === book.updatedAt && (await tokenName()) === full(NAMES[2]), `the token is now called ${await tokenName()}`);
check(book.burnBps === 4_200 && book.treasuryBps === 4_000 && readLog(logPath).at(-1)?.record.hooks?.name === 2, "the fee hook it came with is on chain too, and the record names the new name");
const renamed = readLog(logPath).at(-1)!;
const renameTx = await transactionOf(renamed.signature);
check(edge.length === ANNOUNCEMENT_MAX && memoUnits(edge) <= MEMO_UNITS && memoUnits(edge) > MEMO_UNITS - 2_000 && renamed.record.announcement === edge && renamed.record.memo === edge, `its announcement is ${ANNOUNCEMENT_MAX} characters, not all of them plain, reckoned at ${memoUnits(edge)} units: as dear as a memo may be`);
check(renameTx?.programs.join() === inOrder(BUDGET, HOOK, HOOK, MEMO_PROGRAM) && !!renameTx.data?.equals(inUtf8(edge)) && renameTx.agentSigned && renameTx.explorer?.words === edge, `the rule, the change of name and all ${inUtf8(edge).length} bytes of those words went in one transaction`);
check(renameTx?.price === null && renameTx.fee === 5_000 && renameTx.asked === edictUnits(edge, true), `with the price at 0 it named none and paid the 5,000 lamports of its signature; it asked for ${renameTx?.asked} units, as near as this run comes to the most an edict can ask for`);
check(!!renameTx && renameTx.memoRun.spent <= memoUnits(edge) && renameTx.memoRun.had >= memoUnits(edge) && withinReckoning(renameTx), `where the memo cost ${renameTx?.memoRun.spent} units, the rule ${renameTx?.hookRuns[0]?.spent} and the change of name ${renameTx?.hookRuns[1]?.spent}; the transaction had ${renameTx?.memoRun.had} left for the memo, and used ${renameTx?.spent} in all, ${share(renameTx)} of what it asked for`);
const last = seen.at(-1)!;
check(last.history.length === 2 && last.history[0].buying === buyingLabel(sent?.choice.buying ?? null) && last.history[0].fees === FEE_HOOKS[0].name && last.history[1].announcement === dear, "it is shown its own earlier edicts by the names of their hooks, with what it said then, whole");
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
check(readLog(logPath).at(-1)?.record.action === "hold" && (await readBook(ctx)).epoch === 3n, "which it writes down, changing nothing");
await until("it tries again and issues the next edict", () => count("rewritten") === 1, 20);
book = await readBook(ctx);
check(book.epoch === 4n && book.rule.length > 0 && book.ruleUntil - book.updatedAt === 12, "a buying hook from the catalogue, for twelve seconds");
check((await tokenName()) === full(NAMES[2]), "the name stays: it changed too recently");
await until("then the one after, when those twelve seconds are up", () => count("rewritten") === 2, 40);
await until("and another", () => count("rewritten") === 3, 40);
book = await readBook(ctx);
check(book.epoch === 6n && book.name !== 2 && (await tokenName()) === full(NAMES[book.name]), `by now it has changed its name again, to ${await tokenName()}`);
check(readLog(logPath).filter((entry) => entry.record.hooks && entry.record.hooks.name !== null).length >= 2, "each change of name is in the record, with its edict");
const own = readLog(logPath).filter((entry) => entry.record.action === "rewrite").slice(-3);
const ownTxs = await Promise.all(own.map((entry) => transactionOf(entry.signature)));
check(own.length === 3 && ownTxs.every((tx, i) => !!tx?.data?.equals(inUtf8(own[i].record.announcement)) && tx.agentSigned && tx.explorer?.words === own[i].record.announcement && own[i].record.memo === own[i].record.announcement), `each of the three it issued by itself has its words in its transaction, and says so in its record: ${own.at(-1)?.record.announcement}`);
check(ownTxs.every((tx, i) => tx?.asked === edictUnits(own[i].record.memo ?? "", own[i].record.hooks?.name != null) && tx.price === PRIORITY_MICROLAMPORTS && tx.fee === edictFee(tx.asked, PRIORITY_MICROLAMPORTS) && withinReckoning(tx)), `and each asked for what its own parts are reckoned at, bid the price that stands when no setting says otherwise, and paid ${ownTxs.map((tx) => tx?.fee).join(", ")} lamports`);

// The figures the limit rests on, over every edict this run sent.
const ruleMost = Math.max(...edictsRead.map((tx) => tx.hookRuns[0]?.spent ?? 0));
const nameMost = Math.max(...edictsRead.map((tx) => tx.hookRuns[1]?.spent ?? 0));
const nearest = edictsRead.reduce((a, b) => (b.spent / b.asked > a.spent / a.asked ? b : a));
check(edictsRead.length === 6 && edictsRead.every(withinReckoning) && ruleMost + 300 <= RULE_UNITS / 2 && own.some((entry) => entry.record.hooks?.name === 3) && nameMost + 150 <= NAME_UNITS * 0.6, `none of the ${edictsRead.length} edicts used more than its parts were reckoned at, so the tenth asked for on top was never touched: the nearest used ${share(nearest)} of what it asked for. Their rules took ${ruleMost} units at most. A change of name took ${nameMost} at most, to a name in signs of three bytes, which is the dearest kind: with a top-up (150) that is under six tenths of the ${NAME_UNITS} an edict allows for it`);

await sendAndConfirmTransaction(connection, new Transaction().add(pauseIx({ program: HOOK, guardian: guardian.publicKey, mint: mint.publicKey, paused: true })), [guardian], { commitment: "confirmed" });
const asked = seen.length;
await until("the guardian's pause stops it", () => events.at(-1)?.status === "paused", 20);
check(seen.length === asked, "and a paused agent asks the model nothing");
stop.abort();
await running;
check(count("error") === 0, `no errors along the way${events.filter((e) => e.status === "error").map((e) => ` ${String((e as { error: unknown }).error)}`).join(";")}`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
