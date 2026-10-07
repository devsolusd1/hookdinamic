// Launches the token on a real network from a JSON file.
//
//   npm run launch -- .local/devnet/launch.json           prints what it would do
//   npm run launch -- .local/devnet/launch.json --send    does it
//
// The file names the network, the payer's keypair and every number that is fixed for good at
// launch (see LaunchFile below). Paths in it are relative to the file. The mint's and the
// curve config's keypairs are created next to it on the first run and reused after that, so a
// launch that stopped halfway continues where it stopped. The result goes to token.json in
// the same folder. Mainnet needs --mainnet as well as --send.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { curveConfig, METEORA_FEE_SHARE } from "../src/curve.js";
import { rulebookAddress, span, type Limits, type Name, type Split } from "../src/hook.js";
import { launch } from "../src/launch.js";
import { solPriceUsd } from "../src/price.js";

type LaunchFile = {
  rpc: string;
  hookProgram: string;
  payerKeypair: string;
  guardian: string;
  agent: string;
  /** The app's signing key, for app-only windows. */
  cosigner: string;
  /** Who receives the trading fees. The payer if left out. */
  feeClaimer?: string;
  feeBps: number;
  startCapSol: number;
  graduationCapUsd: number;
  limits: Limits;
  /** The fee split the token opens with. */
  split: Split;
  /** The names the token can go by, the one it launches with first. With one name it never changes. */
  names: Name[];
  uri: string;
};

const NETWORKS: Record<string, string> = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
};

const [file, ...flags] = process.argv.slice(2);
if (!file) throw new Error("which launch file? e.g. npm run launch -- .local/devnet/launch.json");
const dir = dirname(resolve(file));
const input = JSON.parse(readFileSync(file, "utf8")) as LaunchFile;
const send = flags.includes("--send");

const readKeypair = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
/** A keypair kept next to the launch file, made on first use. */
function keptKeypair(name: string): Keypair {
  const path = resolve(dir, name);
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  return readKeypair(path);
}

const connection = new Connection(input.rpc, "confirmed");
const network = NETWORKS[await connection.getGenesisHash()] ?? "an unknown network";
const hookProgram = new PublicKey(input.hookProgram);
const payer = readKeypair(resolve(dir, input.payerKeypair));
const mint = keptKeypair("mint.json");
const config = keptKeypair("curve-config.json");

const program = await connection.getAccountInfo(hookProgram);
if (!program?.executable) throw new Error(`${input.hookProgram} is not a program on ${network}: deploy the hook first`);
const price = await solPriceUsd();
const curve = { startCapSol: input.startCapSol, graduationCapSol: input.graduationCapUsd / price, feeBps: input.feeBps };
const solToGraduate = Number(curveConfig(curve).migrationQuoteThreshold.toString()) / LAMPORTS_PER_SOL;
const balance = (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
const round = (n: number) => Math.round(n).toLocaleString("en-US");

console.log(`
  network        ${network}
  token          ${input.names[0].name} (${input.names[0].symbol}), mint ${mint.publicKey.toBase58()}
  hook program   ${input.hookProgram}
  payer          ${payer.publicKey.toBase58()} with ${balance.toFixed(3)} SOL
  fees to        ${input.feeClaimer ?? payer.publicKey.toBase58()}
  guardian       ${input.guardian}
  agent          ${input.agent}
  app key        ${input.cosigner}

  fixed for good
  trading fee    ${input.feeBps / 100}% per trade, of which Meteora keeps ${METEORA_FEE_SHARE * 100}%
  curve          starts at ${input.startCapSol} SOL of market cap, graduates at ${round(curve.graduationCapSol)} SOL
                 (US$ ${round(input.graduationCapUsd)} at US$ ${price.toFixed(0)}/SOL), which takes ${round(solToGraduate)} SOL of buys
  limits         one edict every ${span(input.limits.minIntervalSecs)} at most, an edict stands ${span(input.limits.maxRuleSecs)} at most,
                 treasury never above ${input.limits.maxTreasuryBps / 100}% of the fees
  names          ${input.names.length > 1 ? `${input.names.map((name) => `${name.name} (${name.symbol})`).join(", ")}; one change every ${span(input.limits.minRenameSecs)} at most` : "one, for good"}
  opens with     no rule; fees ${input.split.holdersBps / 100}% holders, ${input.split.burnBps / 100}% burn, ${input.split.treasuryBps / 100}% treasury
`);

if (!send) {
  console.log("Nothing was sent. Add --send to launch.");
  process.exit(0);
}
if (network === "mainnet" && !flags.includes("--mainnet")) throw new Error("this is mainnet: add --mainnet if that is what you mean");
if (balance < 0.05) throw new Error("the payer needs at least 0.05 SOL: a launch pays about 0.02 SOL in rent");

const { pool } = await launch(
  {
    dbc: DynamicBondingCurveClient.create(connection, "confirmed"),
    hookProgram,
    payer,
    mint,
    config,
    feeClaimer: input.feeClaimer ? new PublicKey(input.feeClaimer) : payer.publicKey,
    guardian: new PublicKey(input.guardian),
    agent: new PublicKey(input.agent),
    cosigner: new PublicKey(input.cosigner),
    limits: input.limits,
    split: input.split,
    curve,
    names: input.names,
    uri: input.uri,
  },
  async (what, tx, signers) => {
    const signature = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
    console.log(`  ${what}: ${signature}`);
  },
);

const token = {
  network,
  rpc: input.rpc,
  hookProgram: input.hookProgram,
  mint: mint.publicKey.toBase58(),
  rulebook: rulebookAddress(hookProgram, mint.publicKey).toBase58(),
  curveConfig: config.publicKey.toBase58(),
  pool: pool.toBase58(),
  feeBps: input.feeBps,
  launchedAt: new Date().toISOString(),
};
writeFileSync(resolve(dir, "token.json"), `${JSON.stringify(token, null, 2)}\n`);
console.log(`\n  launched. Addresses are in ${resolve(dir, "token.json")}`);
