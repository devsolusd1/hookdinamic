// Puts a token on the local validator and has the agent issue a few edicts, so the site can be
// seen reading a real rulebook: `npm run validator`, `npm run site:seed`, `npm run site:local`.
//
// The model is replaced by a stand-in (scripts/stand-in.ts) that takes the hooks of the
// catalogue in order. Everything else is the real path: the edicts go on chain through the
// agent's key, and the log the page reads is the agent's own.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { runOnce, type Context } from "../src/agent.js";
import { rulebookAddress, type Limits, type Name, type Split } from "../src/hook.js";
import { launch } from "../src/launch.js";
import { byRote } from "./stand-in.js";

const local = JSON.parse(readFileSync(new URL("../.local/validator.json", import.meta.url), "utf8")) as { rpc: string; hookProgram: string };
const connection = new Connection(local.rpc, "confirmed");
const HOOK = new PublicKey(local.hookProgram);
const dbc = DynamicBondingCurveClient.create(connection, "confirmed");
const out = new URL("../.local/site/", import.meta.url);

const FEE_BPS = 200;
const EDICTS = 5;
// The name may change every twenty seconds here, so that the page has a change of name to show.
const LIMITS: Limits = { minIntervalSecs: 5, maxRuleSecs: 2 * 3600, maxTreasuryBps: 3_000, minRenameSecs: 20 };
const SPLIT: Split = { holdersBps: 4_000, burnBps: 4_000, treasuryBps: 2_000 };
const NAMES: Name[] = [{ name: "Edict", symbol: "EDICT" }, { name: "Decree", symbol: "DECREE" }, { name: "By Order", symbol: "BYORDER" }, { name: "Same Coin", symbol: "SAME" }];

const [payer, guardian, agent, alice, mint, config] = Array.from({ length: 6 }, () => Keypair.generate());
for (const wallet of [payer, agent, alice]) {
  const signature = await connection.requestAirdrop(wallet.publicKey, 100 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
}

const { pool } = await launch(
  {
    dbc, hookProgram: HOOK, payer, mint, config,
    feeClaimer: payer.publicKey, guardian: guardian.publicKey, agent: agent.publicKey, cosigner: Keypair.generate().publicKey,
    limits: LIMITS, split: SPLIT,
    curve: { startCapSol: 30, graduationCapSol: 8_000_000, feeBps: FEE_BPS },
    names: NAMES, uri: "https://example.com/edict.json",
  },
  (_what, tx, signers) => sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" }),
);

/** A small buy. Under some hooks it is refused, which is fine here: the page needs edicts, not trades. */
async function buy(solIn: number) {
  const tx = await dbc.pool.swap2WithTransferHook({
    owner: alice.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null,
    swapMode: SwapMode.ExactIn, amountIn: new BN(solIn * LAMPORTS_PER_SOL), minimumAmountOut: new BN(0),
  });
  await sendAndConfirmTransaction(connection, tx, [alice], { commitment: "confirmed" }).catch(() => undefined);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const ctx: Context = { connection, dbc, hookProgram: HOOK, mint: mint.publicKey, pool, agent, logPath: fileURLToPath(new URL("log.jsonl", out)), decide: byRote() };

for (let i = 1; i <= EDICTS; i++) {
  await buy(0.2);
  await new Promise((r) => setTimeout(r, (LIMITS.minIntervalSecs + 1) * 1000));
  const outcome = await runOnce(ctx);
  console.log(`${i}/${EDICTS} ${outcome.status}${outcome.status === "rewritten" ? `: ${outcome.announcement}` : ""}`);
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
