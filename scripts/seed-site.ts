// Puts a token on the local validator and has the agent issue a few edicts, so the site can be
// seen reading a real rulebook: `npm run validator`, `npm run site:seed`, `npm run site:local`.
//
// The token has the shape of the one that launches (launch.example.json): Veluno, one name, no
// app key, the same limits and opening split. Only the wait between two edicts is shorter, so
// that seeding takes a minute and not an hour.
//
// The model is replaced by a stand-in (scripts/stand-in.ts) that takes the hooks of the
// catalogue in order. Everything else is the real path: the edicts go on chain through the
// agent's key, and the log the page reads is the agent's own. No keeper runs here, so the page
// has no ledger to show: `node scripts/site.mjs --ledger <file>` puts one in for a preview.
import "../src/quiet.js";
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

const FEE_BPS = 300;
const EDICTS = 5;
// As in launch.example.json, except minIntervalSecs, which is ten minutes there.
const LIMITS: Limits = { minIntervalSecs: 5, maxRuleSecs: 2 * 3600, minTreasuryBps: 4_000, maxTreasuryBps: 5_000, minRenameSecs: 86_400 };
const SPLIT: Split = { holdersBps: 3_000, burnBps: 3_000, treasuryBps: 4_000 };
const NAMES: Name[] = [{ name: "Veluno", symbol: "VELUNO" }];

/**
 * The page's settings as they ship. site/config.js is a script for a browser, so it is run
 * here with a stand-in for the window. Taking them from there means a setting added to the
 * page is in the seeded page too, without this file being told.
 */
function shippedSettings(): Record<string, unknown> {
  const page = { SITE: {} as Record<string, unknown> };
  new Function("window", "document", readFileSync(new URL("../site/config.js", import.meta.url), "utf8"))(page, { documentElement: { dataset: {} } });
  return page.SITE;
}

const [payer, guardian, agent, keeper, treasury, alice, mint, config] = Array.from({ length: 8 }, () => Keypair.generate());
for (const wallet of [payer, agent, alice]) {
  const signature = await connection.requestAirdrop(wallet.publicKey, 100 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
}

const { pool } = await launch(
  {
    dbc, hookProgram: HOOK, payer, mint, config,
    guardian: guardian.publicKey, agent: agent.publicKey, keeper: keeper.publicKey,
    limits: LIMITS, split: SPLIT,
    curve: { startCapSol: 30, feeBps: FEE_BPS },
    names: NAMES, uri: "https://www.veluno.li/metadata.json",
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

// The page as it ships, pointed at this token. The treasury is a made-up address: nothing is
// ever sent to it here, and the real one has no place next to a token on a local chain.
const site = {
  ...shippedSettings(),
  rpc: local.rpc,
  rulebook: rulebookAddress(HOOK, mint.publicKey).toBase58(),
  program: HOOK.toBase58(),
  pool: pool.toBase58(),
  treasury: treasury.publicKey.toBase58(),
  feeBps: FEE_BPS,
  trade: [{ label: "Jupiter", url: `https://jup.ag/swap/SOL-${mint.publicKey.toBase58()}` }],
};
writeFileSync(
  new URL("config.js", out),
  `// Written by scripts/seed-site.ts: the page pointed at the local validator.\nwindow.SITE = ${JSON.stringify(site, null, 2)};\n\ndocument.documentElement.dataset.mode = "live";\n`,
);
console.log(`token ${mint.publicKey.toBase58()}\nrulebook ${site.rulebook}\nnow run: npm run site:local`);
