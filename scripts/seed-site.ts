// Puts a token on the local validator and has the agent issue a few edicts, so the site can be
// seen reading a real rulebook: `npm run validator`, `npm run site:seed`, `npm run site:local`.
//
// The model is replaced by a fixed script of decisions. Everything else is the real path: the
// rules go on chain through the agent's key, and the log the page reads is the agent's own.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { runOnce, type Context, type Decide } from "../src/agent.js";
import { rulebookAddress, type Change, type Limits } from "../src/hook.js";
import { launch } from "../src/launch.js";

const local = JSON.parse(readFileSync(new URL("../.local/validator.json", import.meta.url), "utf8")) as { rpc: string; hookProgram: string };
const connection = new Connection(local.rpc, "confirmed");
const HOOK = new PublicKey(local.hookProgram);
const dbc = DynamicBondingCurveClient.create(connection, "confirmed");
const out = new URL("../.local/site/", import.meta.url);

const FEE_BPS = 200;
const LIMITS: Limits = { minIntervalSecs: 5, maxGateSecs: 6 * 3600, minMaxBuyBps: 25, minMaxWalletBps: 50, maxTreasuryBps: 3_000 };
const OPEN: Change = { gateSecs: 0, maxBuyBps: 0, maxWalletBps: 0, holdersBps: 5_000, burnBps: 3_000, treasuryBps: 2_000 };

type Scripted = { change?: Change; announcement?: string; reasoning: string };
const script: Scripted[] = [
  {
    change: { ...OPEN, maxWalletBps: 200 },
    announcement: "Until the next edict no wallet may hold more than two percent of supply. Buying is open to everyone.",
    reasoning: "The first hour of a curve is when a few wallets take most of it. A cap spreads the early supply while it is still cheap.",
  },
  { reasoning: "Two buys since my last edict and the cap is doing its work. Nothing here needs changing." },
  {
    change: { ...OPEN, holdersBps: 4_000, burnBps: 5_000, treasuryBps: 1_000 },
    announcement: "The wallet cap is lifted. From now on half of every fee goes to burning. Holders take four tenths and the treasury one.",
    reasoning: "Supply sits in more wallets now, so the cap has done what it was for. Burning is the plainest use of fees while volume is thin.",
  },
  {
    change: { ...OPEN, maxBuyBps: 100, holdersBps: 4_000, burnBps: 5_000, treasuryBps: 1_000 },
    announcement: "No single purchase above one percent of supply, until I say otherwise. The fee split stays as it was.",
    reasoning: "The last three buys were each larger than everything before them put together. Smaller steps make the price easier to follow.",
  },
  {
    change: { ...OPEN, gateSecs: 1_800, maxBuyBps: 100, holdersBps: 7_000, burnBps: 3_000, treasuryBps: 0 },
    announcement: "For the next thirty minutes I can only be bought through the FOMO app. Selling stays open, as it always does. Seven tenths of the fees from this window go to holders.",
    reasoning: "Volume doubled in a quarter of an hour and most of it came from a few large buys. A short window through one app slows that down, and holders are paid for the wait.",
  },
];

const [payer, guardian, agent, alice, mint, config] = Array.from({ length: 6 }, () => Keypair.generate());
for (const wallet of [payer, agent, alice]) {
  const signature = await connection.requestAirdrop(wallet.publicKey, 100 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
}

const { pool } = await launch(
  {
    dbc, hookProgram: HOOK, payer, mint, config,
    feeClaimer: payer.publicKey, guardian: guardian.publicKey, agent: agent.publicKey, cosigner: Keypair.generate().publicKey,
    limits: LIMITS, first: OPEN,
    curve: { startCapSol: 30, graduationCapSol: 8_000_000, feeBps: FEE_BPS },
    name: "Edict (local)", symbol: "EDICT", uri: "https://example.com/edict.json",
  },
  (_what, tx, signers) => sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" }),
);

async function buy(solIn: number) {
  const tx = await dbc.pool.swap2WithTransferHook({
    owner: alice.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null,
    swapMode: SwapMode.ExactIn, amountIn: new BN(solIn * LAMPORTS_PER_SOL), minimumAmountOut: new BN(0),
  });
  await sendAndConfirmTransaction(connection, tx, [alice], { commitment: "confirmed" });
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const logPath = new URL("log.jsonl", out);

let step = 0;
const decide: Decide = async () => {
  const { change, announcement, reasoning } = script[step];
  return change ? { action: "rewrite", change, announcement: announcement!, reasoning, model: "scripted" } : { action: "hold", reasoning, model: "scripted" };
};
const ctx: Context = { connection, dbc, hookProgram: HOOK, mint: mint.publicKey, pool, agent, logPath: fileURLToPath(logPath), decide };

for (; step < script.length; step++) {
  // Small buys keep inside whichever caps the previous edict set.
  await buy(0.2);
  await new Promise((r) => setTimeout(r, (LIMITS.minIntervalSecs + 1) * 1000));
  const outcome = await runOnce(ctx);
  console.log(`${step + 1}/${script.length} ${outcome.status}`);
}

const site = {
  rpc: local.rpc,
  rulebook: rulebookAddress(HOOK, mint.publicKey).toBase58(),
  program: HOOK.toBase58(),
  pool: pool.toBase58(),
  log: "data/log.jsonl",
  feeBps: FEE_BPS,
  app: "FOMO",
  explorer: "https://solscan.io",
  trade: [{ label: "Jupiter", url: `https://jup.ag/swap/SOL-${mint.publicKey.toBase58()}` }],
};
writeFileSync(
  new URL("config.js", out),
  `// Written by scripts/seed-site.ts: the page pointed at the local validator.\nwindow.SITE = ${JSON.stringify(site, null, 2)};\n\ndocument.documentElement.dataset.mode = "live";\n`,
);
console.log(`token ${mint.publicKey.toBase58()}\nrulebook ${site.rulebook}\nnow run: npm run site:local`);
