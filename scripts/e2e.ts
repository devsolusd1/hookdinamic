// End to end against the real Meteora DBC bytecode on a local validator (scripts/validator.sh):
// launch on a curve that cannot graduate, trade under rules built from every fact the hook
// can see, change the token's name, claim the fees. Then the same for a second token with the
// shape the real one launches with, and there the whole of how the fees leave the curve: only
// through the program, only for the keeper, and with a keeper the guardian can replace. Last,
// one buy of nearly the whole supply, which leaves the curve open and the hook on the token.
//
//   npm run validator     (in one terminal; needs WSL)
//   npm run e2e
import "../src/quiet.js";
import { readFileSync } from "node:fs";
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  deriveDbcTokenVaultAddress,
  DynamicBondingCurveClient,
  getPriceFromSqrtPrice,
  SwapMode,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, getMint, getTokenMetadata, getTransferHook, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { createUpdateFieldInstruction } from "@solana/spl-token-metadata";
import BN from "bn.js";
import { FEE_HOOKS, recogniseSplit, ruleOf } from "../site/hooks.js";
import { GRADUATION_SOL, METEORA_FEE_SHARE, SOL_IN_EXISTENCE, TOKEN_DECIMALS, TOTAL_SUPPLY } from "../src/curve.js";
import { claimFeesTx, EVERYTHING } from "../src/fees.js";
import { BPS, claimFeesIx, compile, decodeRulebook, describe, METEORA_DBC, pauseIx, REFUSAL, rulebookAddress, setKeeperIx, setNameIx, setRulesIx, type Change, type Clause, type Limits, type Name, type Split } from "../src/hook.js";
import { launch } from "../src/launch.js";

const local = JSON.parse(readFileSync(new URL("../.local/validator.json", import.meta.url), "utf8")) as { rpc: string; hookProgram: string };
const connection = new Connection(local.rpc, "confirmed");
const HOOK = new PublicKey(local.hookProgram);
const dbc = DynamicBondingCurveClient.create(connection, "confirmed");

const FEE_BPS = 300;
const START_CAP_SOL = 30;
// The fee and the treasury's floor and cap are the ones the token launches with.
const LIMITS: Limits = { minIntervalSecs: 2, maxRuleSecs: 6 * 3600, minTreasuryBps: 4_000, maxTreasuryBps: 5_000, minRenameSecs: 20 };
const SPLIT: Split = { holdersBps: 3_000, burnBps: 3_000, treasuryBps: 4_000 };
/** The second name is the longer one, so taking it makes the mint grow. */
const NAMES: Name[] = [{ name: "Agent Hook Test", symbol: "AHT" }, { name: "Same Hook Under Another Name", symbol: "SAMEHOOK" }];
const inFull = (name?: Name | null) => (name ? `${name.name} (${name.symbol})` : "nothing");
/** An edict with no rule, standing for ten minutes. */
const OPEN: Change = { ruleSecs: 600, rule: [], ...SPLIT };
/** A rule in force for an hour unless said otherwise. */
const rule = (clauses: Clause[], seconds = 3600): Change => ({ ruleSecs: seconds, rule: compile(clauses), ...SPLIT });

const sol = (n: number) => new BN(Math.round(n * LAMPORTS_PER_SOL));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(ok: boolean, what: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
}

/**
 * `code` is the hook's refusal, read from its own line in the logs: other programs reuse the
 * same numbers. `meteora` is the error Meteora's program stopped on, read the same way.
 * `fee` is what the transaction cost whoever paid for it, in lamports.
 */
type Sent = { err: unknown; code: number | null; meteora: number | null; logs: string[]; units: number; fee: number };

/** Sends without preflight so a refused transfer lands and shows its error the way a wallet would see it. */
async function send(tx: Transaction, signers: Keypair[]): Promise<Sent> {
  const latest = await connection.getLatestBlockhash();
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(...signers);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  // web3.js reports a transaction that failed in its result or as a rejection, whichever of its two checks sees it first.
  const err = await connection.confirmTransaction({ signature, ...latest }, "confirmed").then(
    (result) => result.value.err,
    (error) => (error instanceof Error ? Promise.reject(error) : error),
  );
  // A node can confirm a transaction a moment before it can show it.
  let seen = null;
  for (let attempt = 0; attempt < 20 && !seen; attempt++) {
    seen = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!seen) await sleep(150);
  }
  const logs = seen?.meta?.logMessages ?? [];
  const stoppedOn = (program: PublicKey) => {
    const line = logs.map((line) => line.match(new RegExp(`^Program ${program.toBase58()} failed: custom program error: 0x([0-9a-f]+)`))).find(Boolean);
    return line ? parseInt(line[1], 16) : null;
  };
  return { err, code: stoppedOn(HOOK), meteora: stoppedOn(METEORA_DBC), logs, units: seen?.meta?.computeUnitsConsumed ?? 0, fee: seen?.meta?.fee ?? 0 };
}

async function mustSend(what: string, tx: Transaction, signers: Keypair[]): Promise<Sent> {
  const sent = await send(tx, signers);
  if (sent.err) throw new Error(`${what} failed: ${JSON.stringify(sent.err)}\n${sent.logs.join("\n")}`);
  return sent;
}

const tx = (...ixs: TransactionInstruction[]) => new Transaction().add(...ixs);

async function airdrop(wallet: Keypair, solAmount: number) {
  const signature = await connection.requestAirdrop(wallet.publicKey, solAmount * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
}

async function fund(...wallets: Keypair[]) {
  for (const wallet of wallets) await airdrop(wallet, 100);
}

const partner = Keypair.generate(); // pays for the launches
const guardian = Keypair.generate();
const agent = Keypair.generate();
const keeper = Keypair.generate(); // takes the fees out of the curve, through the program
const app = Keypair.generate(); // stands in for the app's co-signer
const alice = Keypair.generate();
const bob = Keypair.generate();
const carol = Keypair.generate();
const mint = Keypair.generate();
const config = Keypair.generate();

const pct = (tokens: number) => `${((tokens / TOTAL_SUPPLY) * 100).toFixed(2)}%`;

/** Trading one token, writing its rules and reading what the chain holds about it. Two tokens are launched below. */
function market(mint: PublicKey, config: PublicKey) {
  const pool = deriveDbcPoolAddress(NATIVE_MINT, mint, config);
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);

  async function held(owner: PublicKey): Promise<number> {
    const balance = await connection.getTokenAccountBalance(ata(owner)).catch(() => null);
    return balance ? Number(balance.value.amount) / 10 ** TOKEN_DECIMALS : 0;
  }

  async function swap(who: Keypair, buy: boolean, amount: BN, how: { throughApp?: boolean; priorityFee?: number } = {}): Promise<Sent> {
    const swapTx = await dbc.pool.swap2WithTransferHook({
      owner: who.publicKey,
      pool,
      swapBaseForQuote: !buy,
      referralTokenAccount: null,
      swapMode: SwapMode.ExactIn,
      amountIn: amount,
      minimumAmountOut: new BN(0),
    });
    const signers = [who];
    if (how.throughApp) {
      // The shape of a real app buy: the app's key pays for the buyer's token account in a
      // top-level instruction of its own, next to the swap.
      swapTx.instructions.unshift(createAssociatedTokenAccountIdempotentInstruction(app.publicKey, ata(who.publicKey), who.publicKey, mint, TOKEN_2022_PROGRAM_ID));
      signers.push(app);
    }
    if (how.priorityFee !== undefined) swapTx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: how.priorityFee }));
    return send(swapTx, signers);
  }

  const buy = (who: Keypair, solIn: number, how?: { throughApp?: boolean; priorityFee?: number }) => swap(who, true, sol(solIn), how);
  const sell = (who: Keypair, tokens: number) => swap(who, false, new BN(Math.floor(tokens * 10 ** TOKEN_DECIMALS)));

  /** An edict, sent once the shortest wait between two has passed. Both tokens are launched with the same wait. */
  async function rewrite(change: Change, signer = agent): Promise<Sent> {
    await sleep((LIMITS.minIntervalSecs + 1) * 1000);
    return send(tx(setRulesIx({ program: HOOK, agent: signer.publicKey, mint, change })), [signer]);
  }

  /** The agent writes `clauses` as the rule; the check line says the rule the way the page would. */
  async function edict(clauses: Clause[], seconds = 3600) {
    const change = rule(clauses, seconds);
    check(!(await rewrite(change)).err, `the agent rules: a buy goes through if ${describe(change.rule).join("; or if ")}`);
  }

  const book = () => connection.getAccountInfo(rulebookAddress(HOOK, mint)).then((account) => decodeRulebook(account!.data));
  const named = () => getTokenMetadata(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);

  /** Lamports of fees waiting in the pool for its fee claimer, and all it was ever credited, by Meteora's own count. */
  async function fees(): Promise<{ waiting: bigint; ever: bigint }> {
    const metrics = await dbc.state.getPoolFeeMetrics(pool);
    return { waiting: BigInt(metrics.current.partnerQuoteFee.toString()), ever: BigInt(metrics.total.totalTradingQuoteFee.toString()) };
  }

  /** The claim as `who` would send it through the hook program: everything waiting unless a figure is given. */
  const claim = (who: PublicKey, lamports?: bigint) => claimFeesTx({ program: HOOK, keeper: who, mint, config, lamports });

  /**
   * Sends `who`'s claim and says how many lamports of fees reached its wallet: the rise of
   * its balance, with what it paid for the transaction and for the token account a first
   * claim opens added back.
   */
  async function claimed(who: Keypair, lamports?: bigint): Promise<{ sent: Sent; reached: bigint }> {
    const rent = async () => BigInt((await connection.getAccountInfo(ata(who.publicKey)))?.lamports ?? 0);
    const [before, rentBefore] = [await connection.getBalance(who.publicKey), await rent()];
    const sent = await send(claim(who.publicKey, lamports), [who]);
    const [after, rentAfter] = [await connection.getBalance(who.publicKey), await rent()];
    return { sent, reached: BigInt(after - before + sent.fee) + rentAfter - rentBefore };
  }

  return { mint, config, pool, ata, held, buy, sell, rewrite, edict, book, named, fees, claim, claimed };
}

const { pool, held, buy, sell, rewrite, edict, book, named, fees, claimed } = market(mint.publicKey, config.publicKey);

const refusedWith = (sent: Sent, code: number, what: string) => check(sent.code === code, `${what} (refused: ${REFUSAL[code]})${sent.code === code ? "" : ` got ${JSON.stringify(sent.err)}`}`);
const refused = (sent: Sent, what: string) => refusedWith(sent, 1, what);
const inSol = (lamports: bigint) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);

async function main() {
  await fund(partner, guardian, agent, keeper, app, alice, bob, carol);

  console.log("launch");
  await launch({
    dbc, hookProgram: HOOK, payer: partner, mint, config,
    guardian: guardian.publicKey, agent: agent.publicKey, keeper: keeper.publicKey, cosigner: app.publicKey,
    limits: LIMITS, split: SPLIT,
    curve: { startCapSol: START_CAP_SOL, feeBps: FEE_BPS },
    names: NAMES, uri: "https://example.com/aht.json",
  }, mustSend);
  // What the program itself wrote in the config, not what the launch meant to send.
  const made = (await dbc.state.getPoolConfig(config.publicKey))!;
  const segments = made.curve.filter((point) => !point.sqrtPrice.isZero());
  const opening = (await dbc.state.getPool(pool))!.poolState;
  const startsAt = getPriceFromSqrtPrice(opening.sqrtPrice, TOKEN_DECIMALS, 9).toNumber() * TOTAL_SUPPLY;
  check(
    made.migrationQuoteThreshold.eq(new BN(GRADUATION_SOL).mul(new BN(LAMPORTS_PER_SOL))) && GRADUATION_SOL > 10 * SOL_IN_EXISTENCE && segments.length === 1 && made.migrationSqrtPrice.eq(segments[0].sqrtPrice),
    `launched on a single curve that cannot graduate: its config asks for ${GRADUATION_SOL.toLocaleString("en-US")} SOL in the curve, ${Math.floor(GRADUATION_SOL / SOL_IN_EXISTENCE)} times all the SOL there is`,
  );
  check(Math.abs(startsAt - START_CAP_SOL) < 1e-6 && opening.quoteReserve.isZero() && opening.baseReserve.eq(new BN(TOTAL_SUPPLY).mul(new BN(10 ** TOKEN_DECIMALS))), `it opens at ${startsAt.toFixed(6)} SOL of market cap, holding the whole supply and no SOL`);
  const vault = await connection.getParsedAccountInfo(deriveDbcTokenVaultAddress(pool, mint.publicKey));
  const vaultOwner = (vault.value?.data as { parsed?: { info?: { owner?: string } } })?.parsed?.info?.owner;
  check(vaultOwner === deriveDbcPoolAuthority().toBase58() && vaultOwner === "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM", "the curve's token vault is owned by the pool authority the hook knows");
  const opened = await book();
  const asLaunched = (Object.keys(LIMITS) as (keyof Limits)[]).every((limit) => opened.limits[limit] === LIMITS[limit]) && (Object.keys(SPLIT) as (keyof Split)[]).every((share) => opened[share] === SPLIT[share]);
  check(asLaunched, `the rulebook holds the limits it was launched with (treasury between ${opened.limits.minTreasuryBps / 100}% and ${opened.limits.maxTreasuryBps / 100}% of the fees) and the opening split`);
  const solVault = await connection.getParsedAccountInfo((await book()).curveVault);
  const solVaultInfo = (solVault.value?.data as { parsed?: { info?: { mint?: string; owner?: string } } })?.parsed?.info;
  check(solVaultInfo?.mint === NATIVE_MINT.toBase58() && solVaultInfo?.owner === vaultOwner, "the SOL vault written in the rulebook before the pool existed is the pool's own");
  const minted = await getMint(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
  check(inFull(await named()) === inFull(NAMES[0]) && !!(await named())?.updateAuthority?.equals(rulebookAddress(HOOK, mint.publicKey)), `it is called ${inFull(await named())}, and only its rulebook's address may edit that`);
  check(minted.mintAuthority === null && minted.freezeAuthority === null, "nobody can mint more of it or freeze an account");

  console.log("no rule");
  const first = await buy(alice, 1);
  check(!first.err, `alice buys 1 SOL: ${pct(await held(alice.publicKey))} of supply, ${first.units.toLocaleString("en-US")} compute units`);
  check(!(await buy(bob, 0.2)).err, `bob buys 0.2 SOL: ${pct(await held(bob.publicKey))}`);

  console.log("size and balances");
  await edict([{ group: 1, fact: "size", op: "<=", value: 1 }]);
  refused(await buy(alice, 1), "alice cannot buy 1 SOL at once");
  check(!(await buy(alice, 0.1)).err, "alice buys 0.1 SOL");
  await edict([{ group: 1, fact: "held_after", op: "<=", value: 0.5 }]);
  refused(await buy(alice, 0.01), `alice, holding ${pct(await held(alice.publicKey))}, cannot buy more`);
  await edict([{ group: 1, fact: "held_before", op: "==", value: 0 }]);
  refused(await buy(bob, 0.05), "bob, who already holds, is kept out");
  check(!(await buy(carol, 0.3)).err, `carol, who holds none, buys 0.3 SOL: ${pct(await held(carol.publicKey))}`);
  refused(await buy(carol, 0.05), "and is kept out the second time");

  console.log("the app, in two groups");
  await edict([
    { group: 1, fact: "via_app", op: "==", value: 1 },
    { group: 2, fact: "size", op: "<=", value: 0.05 },
  ]);
  refused(await buy(bob, 0.1), "bob cannot buy 0.1 SOL from outside the app");
  check(!(await buy(bob, 0.01)).err, "a small buy from outside goes through the second group");
  const viaApp = await buy(bob, 0.1, { throughApp: true });
  check(!viaApp.err, `the same 0.1 SOL goes through the app, ${viaApp.units.toLocaleString("en-US")} compute units`);

  console.log("the curve, the fee, the clock and luck");
  await edict([
    { group: 1, fact: "curve_sol", op: ">=", value: 1000 },
    { group: 2, fact: "size", op: "<=", value: 0.05 },
  ]);
  refused(await buy(bob, 0.1), "a curve with a little over 1 SOL is not one with 1,000");
  await edict([{ group: 1, fact: "curve_sol", op: ">=", value: 0.5 }]);
  check(!(await buy(bob, 0.1)).err, "but it does hold more than half a SOL, read from Meteora's own vault");
  await edict([{ group: 1, fact: "priority_fee", op: "<=", value: 1000 }]);
  refused(await buy(bob, 0.05, { priorityFee: 5000 }), "a buy that bids 5,000 for priority is refused");
  check(!(await buy(bob, 0.05, { priorityFee: 1000 })).err, "one that bids 1,000 is not");
  await edict([{ group: 1, fact: "elapsed", op: ">=", value: 6 }]);
  refused(await buy(bob, 0.05), "a rule that opens six seconds in refuses a buy at once");
  await sleep(6500);
  check(!(await buy(bob, 0.05)).err, "and lets it through six seconds later");
  await edict([{ group: 1, fact: "luck", op: ">", value: 99 }], 8);
  refused(await buy(bob, 0.05), "nobody's luck is above 99");
  await sleep(9000);
  check(!(await buy(bob, 0.05)).err, "eight seconds on, the rule has lapsed by itself and bob buys");

  console.log("selling and sending");
  await edict([{ group: 1, fact: "luck", op: ">", value: 99 }]);
  refused(await buy(alice, 0.05), "under a rule nobody can meet, alice cannot buy");
  const aliceHolds = await held(alice.publicKey);
  check(!(await sell(alice, aliceHolds / 2)).err, "but she sells half");
  check(!(await sell(alice, await held(alice.publicKey))).err, "and then the rest");

  console.log("names");
  const takeName = (index: number) => setNameIx({ program: HOOK, agent: agent.publicKey, mint: mint.publicKey, index });
  /** An edict with no rule and, right behind it in the same transaction, a change of name. */
  const edictWithName = async (index: number) => {
    await sleep((LIMITS.minIntervalSecs + 1) * 1000);
    return send(tx(setRulesIx({ program: HOOK, agent: agent.publicKey, mint: mint.publicKey, change: OPEN }), takeName(index)), [agent]);
  };
  refusedWith(await send(tx(takeName(1)), [agent]), 18, "the agent cannot change the name outside an edict");
  refusedWith(await edictWithName(0), 17, "nor to the name it already has");
  const bytesBefore = (await connection.getAccountInfo(mint.publicKey))!.data.length;
  const renamed = await edictWithName(1);
  check(!renamed.err && inFull(await named()) === inFull(NAMES[1]), `an edict gives it its other name: ${inFull(await named())}, ${renamed.units.toLocaleString("en-US")} compute units`);
  check((await book()).name === 1 && (await connection.getAccountInfo(mint.publicKey))!.data.length > bytesBefore, "the rulebook says which name is in use, and the mint grew to hold the longer one");
  check(!(await buy(bob, 0.05)).err && !(await sell(bob, 1000)).err, "it trades as before under the new name");
  refusedWith(await edictWithName(0), 13, "it cannot change back at once");
  const around = await send(tx(createUpdateFieldInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint.publicKey, updateAuthority: partner.publicKey, field: "name", value: "Mine" })), [partner]);
  check(!!around.err && inFull(await named()) === inFull(NAMES[1]), "the wallet that launched it cannot rename it around the rulebook");

  console.log("limits and keys");
  refusedWith(await rewrite(rule([{ group: 1, fact: "size", op: "<=", value: 1 }], 6 * 3600 + 1)), 14, "the agent cannot make a rule last longer than the limit");
  refusedWith(await rewrite({ ...OPEN, holdersBps: BPS - LIMITS.maxTreasuryBps - 1, burnBps: 0, treasuryBps: LIMITS.maxTreasuryBps + 1 }), 14, `the agent cannot send more than ${LIMITS.maxTreasuryBps / 100}% of the fees to the treasury`);
  refusedWith(await rewrite({ ...OPEN, holdersBps: BPS - LIMITS.minTreasuryBps + 1, burnBps: 0, treasuryBps: LIMITS.minTreasuryBps - 1 }), 14, `nor leave it less than ${LIMITS.minTreasuryBps / 100}%`);
  refusedWith(await rewrite({ ...OPEN, ruleSecs: 60, rule: [{ group: 0, fact: 99, op: 0, value: 1n }] }), 16, "the agent cannot write a condition about a fact that does not exist");
  refusedWith(await rewrite(OPEN, guardian), 10, "the guardian cannot write rules");
  check(!(await rewrite({ ...rule([{ group: 1, fact: "luck", op: ">", value: 99 }]), holdersBps: 6_000, burnBps: 0, treasuryBps: 4_000 })).err, "the agent closes buying again and sends 60% of the fees to holders, all that the treasury's floor leaves");
  refused(await buy(bob, 0.1), "bob is outside again");
  await mustSend("pause", tx(pauseIx({ program: HOOK, guardian: guardian.publicKey, mint: mint.publicKey, paused: true })), [guardian]);
  check(!(await buy(bob, 0.1)).err, "the guardian pauses the agent and bob buys freely");

  console.log("fees");
  const due = await fees();
  const taken = await claimed(keeper);
  check(
    !taken.sent.err && due.waiting > 0n && taken.reached === due.waiting && (await fees()).waiting === 0n,
    `the keeper claims through the program, and the ${inSol(taken.reached)} SOL of fees that were waiting reach its wallet as plain SOL (${FEE_BPS / 100}% per trade, Meteora keeps ${METEORA_FEE_SHARE * 100}% of it)${taken.sent.err ? ` got ${JSON.stringify(taken.sent.err)}` : ""}`,
  );

  const last = await book();
  check(last.epoch === 12n && last.paused && last.holdersBps === 6_000 && last.treasuryBps === 4_000 && last.rule.length === 1 && last.name === 1, `the rulebook reads back as the agent and the guardian left it, after ${last.epoch} edicts`);

  await asItLaunches();

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

/**
 * A second token, with the shape the real one launches with: the numbers of
 * launch.example.json, one name and no app key. Then how its fees leave the curve, and a buy
 * of nearly the whole supply, which does not fill it.
 */
async function asItLaunches() {
  console.log("the token as it launches");
  const example = JSON.parse(readFileSync(new URL("../launch.example.json", import.meta.url), "utf8")) as {
    cosigner?: string;
    feeBps: number;
    startCapSol: number;
    limits: Limits;
    split: Split;
    names: Name[];
  };
  // The file asks for ten minutes between edicts, and the four below would take most of an
  // hour. The wait between edicts is the one number here that is not the file's.
  const limits: Limits = { ...example.limits, minIntervalSecs: LIMITS.minIntervalSecs };
  const [floor, cap] = [limits.minTreasuryBps, limits.maxTreasuryBps];
  const [mint, config, stranger, successor] = Array.from({ length: 4 }, () => Keypair.generate());
  await fund(stranger, successor);
  const token = market(mint.publicKey, config.publicKey);
  const rulebook = rulebookAddress(HOOK, mint.publicKey);

  check(example.names.length === 1 && example.cosigner === undefined, `launch.example.json describes a token with one name and no app key: ${inFull(example.names[0])}, fee ${example.feeBps / 100}%, treasury between ${floor / 100}% and ${cap / 100}% of the fees`);
  await launch({
    dbc, hookProgram: HOOK, payer: partner, mint, config,
    guardian: guardian.publicKey, agent: agent.publicKey, keeper: keeper.publicKey,
    limits, split: example.split,
    curve: { startCapSol: example.startCapSol, feeBps: example.feeBps },
    names: example.names, uri: "https://example.com/veluno.json",
  }, mustSend);
  const opened = await token.book();
  const asAsked = (Object.keys(limits) as (keyof Limits)[]).every((limit) => opened.limits[limit] === limits[limit]) && (Object.keys(example.split) as (keyof Split)[]).every((share) => opened[share] === example.split[share]);
  check(
    asAsked && opened.names.length === 1 && inFull(opened.names[0]) === inFull(example.names[0]) && opened.cosigner.equals(PublicKey.default) && opened.keeper.equals(keeper.publicKey),
    "its rulebook holds those limits, the opening split, its one name, no app key, and the keeper",
  );
  const metadata = await token.named();
  const minted = await getMint(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
  check(!!metadata && inFull(metadata) === inFull(example.names[0]) && !metadata.updateAuthority && minted.mintAuthority === null && minted.freezeAuthority === null, `it is called ${inFull(metadata)} for good: nobody can edit its name, mint more of it or freeze an account`);
  const curve = await dbc.state.getPoolConfig(config.publicKey);
  check(!!curve?.feeClaimer.equals(rulebook) && !PublicKey.isOnCurve(rulebook.toBytes()), "its curve names the rulebook's address as the one that claims the fees, and that address has no private key");

  console.log("its fee");
  check(!(await token.buy(alice, 1)).err, `with no rule, alice buys 1 SOL: ${pct(await token.held(alice.publicKey))} of supply`);
  const fee = (BigInt(LAMPORTS_PER_SOL) * BigInt(example.feeBps)) / BigInt(BPS);
  const meteoras = (fee * BigInt(Math.round(METEORA_FEE_SHARE * 100))) / 100n;
  const forMeteora = BigInt((await dbc.state.getPool(token.pool))!.poolState.protocolQuoteFee.toString());
  check((await token.fees()).waiting === fee - meteoras && forMeteora === meteoras, `of that 1 SOL, ${example.feeBps / 100}% is the fee: ${inSol(meteoras)} SOL for Meteora and ${inSol(fee - meteoras)} SOL waiting for the token`);

  console.log("an edict of each fee hook");
  const shares = FEE_HOOKS.map((hook) => hook.split(cap, floor));
  for (const [i, hook] of FEE_HOOKS.entries()) {
    // The first comes with a buying hook from the catalogue to trade under: Max Buy, at 0.25% of supply.
    const sent = await token.rewrite({ ruleSecs: 3600, rule: i === 0 ? ruleOf("max-buy", 1) : [], ...shares[i] });
    const now = await token.book();
    const onChain = now.holdersBps === shares[i].holdersBps && now.burnBps === shares[i].burnBps && now.treasuryBps === shares[i].treasuryBps;
    check(!sent.err && onChain && recogniseSplit(now, cap, floor)?.hook.id === hook.id, `${hook.name}: holders ${now.holdersBps / 100}%, burn ${now.burnBps / 100}%, treasury ${now.treasuryBps / 100}%`);
    if (i > 0) continue;
    refused(await token.buy(bob, 1), "under Max Buy at 0.25% of supply, bob cannot buy 1 SOL at once");
    check(!(await token.buy(bob, 0.05)).err, `but he buys 0.05 SOL: ${pct(await token.held(bob.publicKey))}`);
    check(!(await token.sell(alice, (await token.held(alice.publicKey)) / 2)).err, "and alice sells half of what she holds");
  }
  const inShort = shares.map((split) => `${split.holdersBps / 100}/${split.burnBps / 100}/${split.treasuryBps / 100}`).join(" ");
  check(inShort === "30/30/40 18/42/40 42/18/40 25/25/50", `between that floor and that cap the four fee hooks came to ${inShort} (holders/burn/treasury)`);

  console.log("what it does not have");
  refusedWith(await token.rewrite({ ruleSecs: 600, rule: compile([{ group: 1, fact: "via_app", op: "==", value: 1 }]), ...example.split }), 16, "with no app key, the agent cannot write a rule about the app");
  await sleep((limits.minIntervalSecs + 1) * 1000);
  const rename = tx(setRulesIx({ program: HOOK, agent: agent.publicKey, mint: mint.publicKey, change: { ruleSecs: 600, rule: [], ...example.split } }), setNameIx({ program: HOOK, agent: agent.publicKey, mint: mint.publicKey, index: 0 }));
  refusedWith(await send(rename, [agent]), 17, "with one name, no edict can give it another");
  check((await token.book()).epoch === BigInt(FEE_HOOKS.length), `its rulebook counts the ${FEE_HOOKS.length} edicts that went through and neither of those two`);

  console.log("its fees leave only through the program, and only for the keeper");
  const due = await token.fees();
  const untouched = async () => (await token.fees()).waiting === due.waiting;
  refusedWith((await token.claimed(stranger)).sent, 19, "a stranger cannot claim through the program");
  refusedWith((await token.claimed(guardian)).sent, 19, "nor can the guardian");
  refusedWith((await token.claimed(agent)).sent, 19, "nor the agent");
  // The bare instruction, with the SOL's destination changed to an account the keeper does not own.
  const strangersSol = getAssociatedTokenAddressSync(NATIVE_MINT, stranger.publicKey);
  const astray = tx(
    createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, token.ata(keeper.publicKey), keeper.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, strangersSol, stranger.publicKey, NATIVE_MINT),
    claimFeesIx({
      program: HOOK, keeper: keeper.publicKey, mint: mint.publicKey, config: config.publicKey, pool: token.pool,
      tokenVault: deriveDbcTokenVaultAddress(token.pool, mint.publicKey), solVault: deriveDbcTokenVaultAddress(token.pool, NATIVE_MINT),
      tokenAccount: token.ata(keeper.publicKey), solAccount: strangersSol, maxTokens: 0n, maxLamports: EVERYTHING,
    }),
  );
  refusedWith(await send(astray, [keeper]), 20, "the keeper itself cannot have them sent to somebody else's account");

  // Meteora's own claim, sent straight to Meteora the way its client builds it.
  const direct = (feeClaimer: PublicKey) => dbc.partner.claimPartnerTradingFee2({ feeClaimer, payer: stranger.publicKey, pool: token.pool, maxBaseAmount: new BN(0), maxQuoteAmount: new BN(due.waiting.toString()), receiver: stranger.publicKey });
  const inOwnName = await send(await direct(stranger.publicKey), [stranger]);
  check(inOwnName.meteora === 6053, `Meteora turns away a wallet that claims in its own name (its error 6053, not permitted)${inOwnName.meteora === 6053 ? "" : ` got ${JSON.stringify(inOwnName.err)}`}`);
  // Naming the rulebook is as far as a wallet can go: there is no key to sign for it with, so it is sent unsigned.
  const forRulebook = await direct(rulebook);
  for (const ix of forRulebook.instructions) for (const key of ix.keys) if (key.pubkey.equals(rulebook)) key.isSigner = false;
  const unsigned = await send(forRulebook, [stranger]);
  check(unsigned.meteora === 3010, `and a claim in the rulebook's name that the rulebook did not sign (its error 3010, account did not sign)${unsigned.meteora === 3010 ? "" : ` got ${JSON.stringify(unsigned.err)}`}`);
  check(due.waiting > 0n && (await untouched()), `after all of that the ${inSol(due.waiting)} SOL of fees are still in the pool`);

  const half = due.waiting / 2n;
  const first = await token.claimed(keeper, half);
  check(
    !first.sent.err && first.reached === half && (await token.fees()).waiting === due.waiting - half,
    `the keeper asks for ${inSol(half)} SOL through the program and exactly that reaches its wallet as plain SOL, ${first.sent.units.toLocaleString("en-US")} compute units${first.sent.err ? ` got ${JSON.stringify(first.sent.err)}` : ""}`,
  );

  console.log("the guardian replaces the keeper");
  const appoint = (signer: Keypair) => send(tx(setKeeperIx({ program: HOOK, guardian: signer.publicKey, mint: mint.publicKey, keeper: successor.publicKey })), [signer]);
  refusedWith(await appoint(keeper), 11, "the keeper cannot name who comes after it");
  refusedWith(await appoint(successor), 11, "nor can a key appoint itself");
  check(!(await appoint(guardian)).err && (await token.book()).keeper.equals(successor.publicKey), "the guardian puts another keeper in the rulebook");
  refusedWith((await token.claimed(keeper)).sent, 19, "the old keeper is refused from then on");
  const rest = await token.claimed(successor);
  const end = await token.fees();
  check(!rest.sent.err && rest.reached === due.waiting - half && end.waiting === 0n, `and the new one claims the rest, ${inSol(rest.reached)} SOL${rest.sent.err ? ` got ${JSON.stringify(rest.sent.err)}` : ""}`);
  check(first.reached + rest.reached === end.ever, `between them the two keepers were paid every lamport of fees the pool ever counted for the token: ${inSol(end.ever)} SOL`);
  check(!(await token.buy(bob, 0.05)).err && (await token.fees()).waiting > 0n, "the curve trades on, and fees start to gather again");

  // Meteora takes the hook off a token in the buy that fills its curve. One buy of 20,000
  // SOL takes nearly all the supply there is to buy, and leaves this curve nowhere near full.
  console.log("it cannot graduate");
  const whale = Keypair.generate();
  const size = 20_000;
  for (let given = 0; given < size; given += 5_000) await airdrop(whale, 5_000);
  await airdrop(whale, 10);
  const hooked = async () => getTransferHook(await getMint(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID))?.programId.equals(HOOK) === true;
  const large = await token.buy(whale, size);
  const full = (await dbc.state.getPool(token.pool))!.poolState;
  check(
    !large.err && full.isMigrated === 0 && full.migrationProgress === 0 && (await hooked()),
    `one buy of ${size.toLocaleString("en-US")} SOL takes ${pct(await token.held(whale.publicKey))} of supply and leaves ${inSol(BigInt(full.quoteReserve.toString()))} SOL in the curve: the curve is not full, and the hook is still on the token${large.err ? ` got ${JSON.stringify(large.err)}` : ""}`,
  );
  check(!(await token.rewrite({ ruleSecs: 600, rule: compile([{ group: 1, fact: "luck", op: ">", value: 99 }]), ...example.split })).err, "the agent closes buying");
  refused(await token.buy(bob, 0.05), "and up there its rule still turns a buy away");
  check(!(await token.sell(whale, await token.held(whale.publicKey))).err && (await hooked()), "all of it sells back, as a sale always can");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
