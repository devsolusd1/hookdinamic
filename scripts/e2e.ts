// End to end against the real Meteora DBC bytecode on a local validator (scripts/validator.sh):
// launch on a curve that never graduates, trade under each rule, claim the fees.
//
//   npm run validator     (in one terminal; needs WSL)
//   npm run e2e
import { readFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  deriveDbcTokenVaultAddress,
  DynamicBondingCurveClient,
  SwapMode,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { METEORA_FEE_SHARE, TOKEN_DECIMALS, TOTAL_SUPPLY } from "../src/curve.js";
import { decodeRulebook, pauseIx, REFUSAL, rulebookAddress, setRulesIx, type Change, type Limits } from "../src/hook.js";
import { launch } from "../src/launch.js";
import { solPriceUsd } from "../src/price.js";

const local = JSON.parse(readFileSync(new URL("../.local/validator.json", import.meta.url), "utf8")) as { rpc: string; hookProgram: string };
const connection = new Connection(local.rpc, "confirmed");
const HOOK = new PublicKey(local.hookProgram);
const dbc = DynamicBondingCurveClient.create(connection, "confirmed");

const FEE_BPS = 200;
const START_CAP_SOL = 30;
const GRADUATION_CAP_USD = 1_000_000_000;
const LIMITS: Limits = { minIntervalSecs: 2, maxGateSecs: 6 * 3600, minMaxBuyBps: 25, minMaxWalletBps: 50, maxTreasuryBps: 3_000 };
const OPEN: Change = { gateSecs: 0, maxBuyBps: 0, maxWalletBps: 0, holdersBps: 5_000, burnBps: 3_000, treasuryBps: 2_000 };

const sol = (n: number) => new BN(Math.round(n * LAMPORTS_PER_SOL));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(ok: boolean, what: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
}

type Sent = { err: unknown; code: number | null; logs: string[]; units: number };

/** Sends without preflight so a refused transfer lands and shows its error the way a wallet would see it. */
async function send(tx: Transaction, signers: Keypair[]): Promise<Sent> {
  const latest = await connection.getLatestBlockhash();
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(...signers);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const { value } = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  const seen = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const custom = (value.err as { InstructionError?: [number, { Custom?: number }] } | null)?.InstructionError?.[1]?.Custom;
  return { err: value.err, code: custom ?? null, logs: seen?.meta?.logMessages ?? [], units: seen?.meta?.computeUnitsConsumed ?? 0 };
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
const mint = Keypair.generate();
const config = Keypair.generate();
const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, config.publicKey);
const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint.publicKey, owner, false, TOKEN_2022_PROGRAM_ID);

async function held(owner: PublicKey): Promise<number> {
  const balance = await connection.getTokenAccountBalance(ata(owner)).catch(() => null);
  return balance ? Number(balance.value.amount) / 10 ** TOKEN_DECIMALS : 0;
}

const pct = (tokens: number) => `${((tokens / TOTAL_SUPPLY) * 100).toFixed(2)}%`;

async function swap(who: Keypair, buy: boolean, amount: BN, throughApp = false): Promise<Sent> {
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
  if (throughApp) {
    // The shape of a real app buy: the app's key pays for the buyer's token account in a
    // top-level instruction of its own, next to the swap.
    swapTx.instructions.unshift(createAssociatedTokenAccountIdempotentInstruction(app.publicKey, ata(who.publicKey), who.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID));
    signers.push(app);
  }
  return send(swapTx, signers);
}

const buy = (who: Keypair, solIn: number, throughApp = false) => swap(who, true, sol(solIn), throughApp);
const sell = (who: Keypair, tokens: number) => swap(who, false, new BN(Math.floor(tokens * 10 ** TOKEN_DECIMALS)));

async function rewrite(change: Change, signer = agent): Promise<Sent> {
  await sleep((LIMITS.minIntervalSecs + 1) * 1000);
  return send(tx(setRulesIx({ program: HOOK, agent: signer.publicKey, mint: mint.publicKey, change })), [signer]);
}

const refusedWith = (sent: Sent, code: number, what: string) => check(sent.code === code, `${what} (refused: ${REFUSAL[code]})${sent.code === code ? "" : ` got ${JSON.stringify(sent.err)}`}`);

async function main() {
  await fund(partner, guardian, agent, app, alice, bob);
  const price = await solPriceUsd().catch(() => 150);
  const graduationCapSol = GRADUATION_CAP_USD / price;

  console.log("launch");
  const { solToGraduate } = await launch({
    dbc, hookProgram: HOOK, payer: partner, mint, config,
    feeClaimer: partner.publicKey, guardian: guardian.publicKey, agent: agent.publicKey, cosigner: app.publicKey,
    limits: LIMITS, first: OPEN,
    curve: { startCapSol: START_CAP_SOL, graduationCapSol, feeBps: FEE_BPS },
    name: "Agent Hook Test", symbol: "AHT", uri: "https://example.com/aht.json",
  }, mustSend);
  check(true, `launched on a curve from ${START_CAP_SOL} SOL to ${Math.round(graduationCapSol).toLocaleString("en-US")} SOL of market cap (US$ 1B at US$ ${price.toFixed(0)}/SOL); it would take ${Math.round(solToGraduate).toLocaleString("en-US")} SOL of buys to graduate`);
  const vault = await connection.getParsedAccountInfo(deriveDbcTokenVaultAddress(pool, mint.publicKey));
  const vaultOwner = (vault.value?.data as { parsed?: { info?: { owner?: string } } })?.parsed?.info?.owner;
  check(vaultOwner === deriveDbcPoolAuthority().toBase58() && vaultOwner === "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM", "the curve's vault is owned by the pool authority the hook knows");

  console.log("open rules");
  const first = await buy(alice, 1);
  check(!first.err, `alice buys 1 SOL: ${pct(await held(alice.publicKey))} of supply, ${first.units.toLocaleString("en-US")} compute units`);
  check(!(await buy(bob, 0.2)).err, `bob buys 0.2 SOL: ${pct(await held(bob.publicKey))}`);

  console.log("max buy 1%");
  check(!(await rewrite({ ...OPEN, maxBuyBps: 100 })).err, "the agent caps one buy at 1% of supply");
  refusedWith(await buy(alice, 1), 2, "alice cannot buy 1 SOL at once");
  check(!(await buy(alice, 0.1)).err, "alice buys 0.1 SOL");

  console.log("app-only window");
  check(!(await rewrite({ ...OPEN, gateSecs: 600 })).err, "the agent opens a 10-minute app-only window");
  refusedWith(await buy(bob, 0.1), 1, "bob cannot buy from outside the app");
  const gated = await buy(bob, 0.1, true);
  check(!gated.err, `bob buys through the app, ${gated.units.toLocaleString("en-US")} compute units`);
  const aliceHolds = await held(alice.publicKey);
  check(!(await sell(alice, aliceHolds / 2)).err, "alice sells half without the app");

  console.log("max wallet 0.5%");
  check(!(await rewrite({ ...OPEN, gateSecs: 0, maxWalletBps: 50 })).err, "the agent closes the window and caps a wallet at 0.5%");
  refusedWith(await buy(alice, 0.01), 3, `alice, holding ${pct(await held(alice.publicKey))}, cannot buy more`);
  check(!(await sell(alice, await held(alice.publicKey))).err, "alice sells everything");

  console.log("limits and keys");
  refusedWith(await rewrite({ ...OPEN, maxBuyBps: 24 }), 14, "the agent cannot set a max buy under the floor");
  refusedWith(await rewrite({ ...OPEN, holdersBps: 6_999, burnBps: 0, treasuryBps: 3_001 }), 14, "the agent cannot send more than 30% of the fees to the treasury");
  refusedWith(await rewrite(OPEN, guardian), 10, "the guardian cannot write rules");
  check(!(await rewrite({ ...OPEN, gateSecs: 600, holdersBps: 7_000, burnBps: 3_000, treasuryBps: 0 })).err, "the agent opens another window and sends 70% of the fees to holders");
  refusedWith(await buy(bob, 0.1), 1, "bob is outside again");
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

  const book = decodeRulebook((await connection.getAccountInfo(rulebookAddress(HOOK, mint.publicKey)))!.data);
  console.log("rulebook", { epoch: book.epoch.toString(), paused: book.paused, gateUntil: book.gateUntil, holdersBps: book.holdersBps, burnBps: book.burnBps, treasuryBps: book.treasuryBps });
  check(book.epoch === 4n && book.paused && book.holdersBps === 7_000, "the rulebook reads back as the agent and the guardian left it");

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
