// End to end against the real Meteora DBC bytecode on a local validator (scripts/validator.sh):
// launch on a curve that never graduates, trade under rules built from every fact the hook
// can see, change the token's name, claim the fees.
//
//   npm run validator     (in one terminal; needs WSL)
//   npm run e2e
import { readFileSync } from "node:fs";
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  deriveDbcTokenVaultAddress,
  DynamicBondingCurveClient,
  SwapMode,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, getMint, getTokenMetadata, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { createUpdateFieldInstruction } from "@solana/spl-token-metadata";
import BN from "bn.js";
import { METEORA_FEE_SHARE, TOKEN_DECIMALS, TOTAL_SUPPLY } from "../src/curve.js";
import { compile, decodeRulebook, describe, pauseIx, REFUSAL, rulebookAddress, setNameIx, setRulesIx, type Change, type Clause, type Limits, type Name, type Split } from "../src/hook.js";
import { launch } from "../src/launch.js";
import { solPriceUsd } from "../src/price.js";

const local = JSON.parse(readFileSync(new URL("../.local/validator.json", import.meta.url), "utf8")) as { rpc: string; hookProgram: string };
const connection = new Connection(local.rpc, "confirmed");
const HOOK = new PublicKey(local.hookProgram);
const dbc = DynamicBondingCurveClient.create(connection, "confirmed");

const FEE_BPS = 200;
const START_CAP_SOL = 30;
const GRADUATION_CAP_USD = 1_000_000_000;
const LIMITS: Limits = { minIntervalSecs: 2, maxRuleSecs: 6 * 3600, maxTreasuryBps: 3_000, minRenameSecs: 20 };
const SPLIT: Split = { holdersBps: 5_000, burnBps: 3_000, treasuryBps: 2_000 };
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

/** `code` is the hook's refusal, read from its own line in the logs: other programs reuse the same numbers. */
type Sent = { err: unknown; code: number | null; logs: string[]; units: number };

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
  const refusal = logs.map((line) => line.match(new RegExp(`^Program ${HOOK.toBase58()} failed: custom program error: 0x([0-9a-f]+)`))).find(Boolean);
  return { err, code: refusal ? parseInt(refusal[1], 16) : null, logs, units: seen?.meta?.computeUnitsConsumed ?? 0 };
}

async function mustSend(what: string, tx: Transaction, signers: Keypair[]): Promise<Sent> {
  const sent = await send(tx, signers);
  if (sent.err) throw new Error(`${what} failed: ${JSON.stringify(sent.err)}\n${sent.logs.join("\n")}`);
  return sent;
}

const tx = (...ixs: TransactionInstruction[]) => new Transaction().add(...ixs);

async function fund(...wallets: Keypair[]) {
  for (const wallet of wallets) {
    const signature = await connection.requestAirdrop(wallet.publicKey, 100 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
  }
}

const partner = Keypair.generate(); // pays for the launch and claims the fees
const guardian = Keypair.generate();
const agent = Keypair.generate();
const app = Keypair.generate(); // stands in for the app's co-signer
const alice = Keypair.generate();
const bob = Keypair.generate();
const carol = Keypair.generate();
const mint = Keypair.generate();
const config = Keypair.generate();
const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, config.publicKey);
const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint.publicKey, owner, false, TOKEN_2022_PROGRAM_ID);

async function held(owner: PublicKey): Promise<number> {
  const balance = await connection.getTokenAccountBalance(ata(owner)).catch(() => null);
  return balance ? Number(balance.value.amount) / 10 ** TOKEN_DECIMALS : 0;
}

const pct = (tokens: number) => `${((tokens / TOTAL_SUPPLY) * 100).toFixed(2)}%`;

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
    swapTx.instructions.unshift(createAssociatedTokenAccountIdempotentInstruction(app.publicKey, ata(who.publicKey), who.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID));
    signers.push(app);
  }
  if (how.priorityFee !== undefined) swapTx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: how.priorityFee }));
  return send(swapTx, signers);
}

const buy = (who: Keypair, solIn: number, how?: { throughApp?: boolean; priorityFee?: number }) => swap(who, true, sol(solIn), how);
const sell = (who: Keypair, tokens: number) => swap(who, false, new BN(Math.floor(tokens * 10 ** TOKEN_DECIMALS)));

async function rewrite(change: Change, signer = agent): Promise<Sent> {
  await sleep((LIMITS.minIntervalSecs + 1) * 1000);
  return send(tx(setRulesIx({ program: HOOK, agent: signer.publicKey, mint: mint.publicKey, change })), [signer]);
}

/** The agent writes `clauses` as the rule; the check line says the rule the way the page would. */
async function edict(clauses: Clause[], seconds = 3600) {
  const change = rule(clauses, seconds);
  check(!(await rewrite(change)).err, `the agent rules: a buy goes through if ${describe(change.rule).join("; or if ")}`);
}

const refusedWith = (sent: Sent, code: number, what: string) => check(sent.code === code, `${what} (refused: ${REFUSAL[code]})${sent.code === code ? "" : ` got ${JSON.stringify(sent.err)}`}`);
const refused = (sent: Sent, what: string) => refusedWith(sent, 1, what);

async function main() {
  await fund(partner, guardian, agent, app, alice, bob, carol);
  const price = await solPriceUsd().catch(() => 150);
  const graduationCapSol = GRADUATION_CAP_USD / price;

  console.log("launch");
  const { solToGraduate } = await launch({
    dbc, hookProgram: HOOK, payer: partner, mint, config,
    feeClaimer: partner.publicKey, guardian: guardian.publicKey, agent: agent.publicKey, cosigner: app.publicKey,
    limits: LIMITS, split: SPLIT,
    curve: { startCapSol: START_CAP_SOL, graduationCapSol, feeBps: FEE_BPS },
    names: NAMES, uri: "https://example.com/aht.json",
  }, mustSend);
  check(true, `launched on a curve from ${START_CAP_SOL} SOL to ${Math.round(graduationCapSol).toLocaleString("en-US")} SOL of market cap (US$ 1B at US$ ${price.toFixed(0)}/SOL); it would take ${Math.round(solToGraduate).toLocaleString("en-US")} SOL of buys to graduate`);
  const vault = await connection.getParsedAccountInfo(deriveDbcTokenVaultAddress(pool, mint.publicKey));
  const vaultOwner = (vault.value?.data as { parsed?: { info?: { owner?: string } } })?.parsed?.info?.owner;
  check(vaultOwner === deriveDbcPoolAuthority().toBase58() && vaultOwner === "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM", "the curve's token vault is owned by the pool authority the hook knows");
  const book = () => connection.getAccountInfo(rulebookAddress(HOOK, mint.publicKey)).then((account) => decodeRulebook(account!.data));
  const solVault = await connection.getParsedAccountInfo((await book()).curveVault);
  const solVaultInfo = (solVault.value?.data as { parsed?: { info?: { mint?: string; owner?: string } } })?.parsed?.info;
  check(solVaultInfo?.mint === NATIVE_MINT.toBase58() && solVaultInfo?.owner === vaultOwner, "the SOL vault written in the rulebook before the pool existed is the pool's own");
  const named = () => getTokenMetadata(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
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
  refusedWith(await rewrite({ ...OPEN, holdersBps: 6_999, burnBps: 0, treasuryBps: 3_001 }), 14, "the agent cannot send more than 30% of the fees to the treasury");
  refusedWith(await rewrite({ ...OPEN, ruleSecs: 60, rule: [{ group: 0, fact: 99, op: 0, value: 1n }] }), 16, "the agent cannot write a condition about a fact that does not exist");
  refusedWith(await rewrite(OPEN, guardian), 10, "the guardian cannot write rules");
  check(!(await rewrite({ ...rule([{ group: 1, fact: "luck", op: ">", value: 99 }]), holdersBps: 7_000, burnBps: 3_000, treasuryBps: 0 })).err, "the agent closes buying again and sends 70% of the fees to holders");
  refused(await buy(bob, 0.1), "bob is outside again");
  await mustSend("pause", tx(pauseIx({ program: HOOK, guardian: guardian.publicKey, mint: mint.publicKey, paused: true })), [guardian]);
  check(!(await buy(bob, 0.1)).err, "the guardian pauses the agent and bob buys freely");

  console.log("fees");
  const before = await connection.getBalance(guardian.publicKey);
  const claim = await dbc.partner.claimPartnerTradingFee2({
    feeClaimer: partner.publicKey,
    payer: partner.publicKey,
    pool,
    maxBaseAmount: new BN(0),
    maxQuoteAmount: new BN("18446744073709551615"),
    receiver: guardian.publicKey,
  });
  await mustSend("claim fees", claim, [partner]);
  const claimed = ((await connection.getBalance(guardian.publicKey)) - before) / LAMPORTS_PER_SOL;
  check(claimed > 0, `claimed ${claimed.toFixed(5)} SOL of fees, in SOL, to a chosen receiver (${FEE_BPS / 100}% per trade, Meteora keeps ${METEORA_FEE_SHARE * 100}% of it)`);

  const last = await book();
  check(last.epoch === 12n && last.paused && last.holdersBps === 7_000 && last.rule.length === 1 && last.name === 1, `the rulebook reads back as the agent and the guardian left it, after ${last.epoch} edicts`);

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
