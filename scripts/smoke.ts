// One small buy and one sell on a launched token, through the hook, to see it trade.
//
//   npm run smoke -- .local/devnet 0.05
//
// Reads token.json and trader.json from the folder; the number is the SOL to buy with.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, type Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { REFUSAL } from "../src/hook.js";

const [dir, amount = "0.05"] = process.argv.slice(2);
if (!dir) throw new Error("which folder? e.g. npm run smoke -- .local/devnet");
const token = JSON.parse(readFileSync(resolve(dir, "token.json"), "utf8")) as { rpc: string; hookProgram: string; mint: string; pool: string };
const trader = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(resolve(dir, "trader.json"), "utf8"))));
const connection = new Connection(token.rpc, "confirmed");
const dbc = DynamicBondingCurveClient.create(connection, "confirmed");
const pool = new PublicKey(token.pool);
const account = getAssociatedTokenAddressSync(new PublicKey(token.mint), trader.publicKey, false, TOKEN_2022_PROGRAM_ID);

/** Sends without preflight, so a trade the hook refuses lands and shows why. */
async function trade(what: string, tx: Transaction): Promise<boolean> {
  const latest = await connection.getLatestBlockhash();
  tx.feePayer = trader.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(trader);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  // web3.js reports a transaction that failed in its result or as a rejection, whichever of its two checks sees it first.
  const err = await connection.confirmTransaction({ signature, ...latest }, "confirmed").then(
    (result) => result.value.err,
    (error) => (error instanceof Error ? Promise.reject(error) : error),
  );
  let outcome = "went through";
  if (err) {
    // Other programs use the same small error numbers (the system program's 1 is "not enough
    // SOL"), so a refusal counts as the hook's only when the hook is the program that failed.
    // A node can confirm a transaction a moment before it can show it.
    let seen = null;
    for (let attempt = 0; attempt < 20 && !seen; attempt++) {
      seen = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!seen) await new Promise((r) => setTimeout(r, 150));
    }
    const logs = seen?.meta?.logMessages ?? [];
    const refusal = logs.map((line) => line.match(new RegExp(`^Program ${token.hookProgram} failed: custom program error: 0x([0-9a-f]+)`))).find(Boolean);
    const said = logs.find((line) => /^Program log: (Error: )?(insufficient|max |app-only)/i.test(line))?.replace("Program log: ", "");
    outcome = refusal ? `refused by the hook (${REFUSAL[parseInt(refusal[1], 16)] ?? `code ${refusal[1]}`})` : `failed, not because of the hook: ${said ?? JSON.stringify(err)}`;
  }
  console.log(`${what} ${outcome}  ${signature}`);
  return !err;
}

const held = async () => BigInt((await connection.getTokenAccountBalance(account).catch(() => null))?.value.amount ?? "0");

const before = await held();
await trade(
  `buy with ${amount} SOL`,
  await dbc.pool.swap2WithTransferHook({
    owner: trader.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null,
    swapMode: SwapMode.ExactIn, amountIn: new BN(Math.round(Number(amount) * LAMPORTS_PER_SOL)), minimumAmountOut: new BN(0),
  }),
);
const bought = (await held()) - before;
console.log(`tokens received: ${Number(bought) / 1e6}`);
if (bought > 0n) {
  await trade(
    "sell half of them",
    await dbc.pool.swap2WithTransferHook({
      owner: trader.publicKey, pool, swapBaseForQuote: true, referralTokenAccount: null,
      swapMode: SwapMode.ExactIn, amountIn: new BN((bought / 2n).toString()), minimumAmountOut: new BN(0),
    }),
  );
}
