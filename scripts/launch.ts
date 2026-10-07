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
//
// Whatever it refuses, it says in one sentence and leaves with exit code 1.
import "../src/quiet.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { curveConfig, METEORA_FEE_SHARE } from "../src/curve.js";
import { BPS, rulebookAddress, span, type Limits, type Name, type Split } from "../src/hook.js";
import { launch } from "../src/launch.js";
import { solPriceUsd } from "../src/price.js";

type LaunchFile = {
  rpc: string;
  hookProgram: string;
  payerKeypair: string;
  guardian: string;
  agent: string;
  /**
   * The public key of the keeper: the process that takes the trading fees out of the curve
   * and pays them out. The guardian can replace it later. The curve's own fee claimer is not
   * asked for: it is always the token's rulebook, an address no key controls.
   */
  keeper: string;
  /**
   * The app's signing key, for app-only windows. Left out, the token names no app and no hook
   * about one applies to it. The guardian can name one later; nothing else here can change.
   */
  cosigner?: string;
  feeBps: number;
  startCapSol: number;
  graduationCapUsd: number;
  limits: Limits;
  /** The fee split the token opens with. */
  split: Split;
  /** The names the token can go by, the one it launches with first. With one name it never changes. */
  names: Name[];
  /** Where the token's card is: a small JSON file with its name, ticker and picture. Written into the token for good. */
  uri: string;
};

const NETWORKS: Record<string, string> = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
};

/** What a launch takes out of the payer's wallet, in SOL: rent for the accounts it creates and the network's fees. Measured: 0.0295. */
const COST_SOL = 0.03;
/** The least the payer has to hold before anything is sent. */
const PAYER_NEEDS_SOL = 0.05;

/** An error as one line that is safe to print: the RPC's address carries its key, so only the host of any address is kept. */
function plain(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).split("\n")[0];
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/g, (address) => {
    try {
      return new URL(address).origin;
    } catch {
      return "(an address)";
    }
  });
}

/** Whether the first transaction of this run has been handed over. Before that, a refusal has changed nothing. */
let sending = false;

/**
 * What the address of the token's card answers today. That address goes into the token for
 * good, so it is looked at before anything is sent. A file that is not there yet can still be
 * put there; an address that sends readers on to another one cannot be mended afterwards.
 */
async function cardAt(uri: string, name: Name): Promise<string> {
  try {
    const response = await fetch(uri, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (response.status >= 300 && response.status < 400) return `WARNING: it sends readers on to ${response.headers.get("location") ?? "another address"}, and not every reader follows. Name the address it ends at`;
    if (!response.ok) return `WARNING: it answers ${response.status} today. The file has to be there before anybody looks the token up`;
    const card = (await response.json()) as { name?: unknown; symbol?: unknown; image?: unknown };
    if (card.name !== name.name || card.symbol !== name.symbol) return `WARNING: the card there says ${String(card.name)} (${String(card.symbol)}), not ${name.name} (${name.symbol})`;
    return `answers with the card of ${name.name} (${name.symbol})${typeof card.image === "string" && card.image ? "" : ", which names no picture"}`;
  } catch {
    return "WARNING: it could not be read today, or what is there is not a card. Open it in a browser before launching";
  }
}

async function run() {
  const [file, ...flags] = process.argv.slice(2);
  if (!file || file.startsWith("--")) throw new Error("which launch file? e.g. npm run launch -- .local/devnet/launch.json");
  const dir = dirname(resolve(file));
  let input: LaunchFile;
  try {
    input = JSON.parse(readFileSync(file, "utf8")) as LaunchFile;
  } catch (error) {
    throw new Error(existsSync(file) ? `${file} is not valid JSON: ${plain(error)}` : `there is no file at ${file}`);
  }
  const send = flags.includes("--send");

  // Meteora never lets a curve's fee claimer change, so it is not a wallet and not a choice.
  if ("feeClaimer" in input) throw new Error("the launch file cannot name a feeClaimer: the fees are claimed by the token's rulebook, for the keeper. Remove that line and name the keeper");
  /** An address the launch file has to give. A placeholder left in from the example is caught here, before anything is paid for. */
  function address(name: "guardian" | "agent" | "keeper" | "hookProgram" | "cosigner"): PublicKey {
    try {
      return new PublicKey(input[name] ?? "");
    } catch {
      throw new Error(`the launch file needs ${name}, a public key`);
    }
  }
  const [guardian, agent, keeper, hookProgram] = [address("guardian"), address("agent"), address("keeper"), address("hookProgram")];
  const cosigner = input.cosigner === undefined ? undefined : address("cosigner");

  // The program refuses limits or a split that make no sense when the rulebook is written, and
  // by then the curve's config is paid for. So they are refused here first.
  const { limits, split } = input;
  for (const name of ["minIntervalSecs", "maxRuleSecs", "minTreasuryBps", "maxTreasuryBps", "minRenameSecs"] as const) {
    if (!Number.isInteger(limits?.[name]) || limits[name] < 0) throw new Error(`the launch file needs limits.${name}, a whole number`);
  }
  if (limits.minTreasuryBps > limits.maxTreasuryBps || limits.maxTreasuryBps > BPS) throw new Error(`the treasury's floor cannot be above its cap, nor its cap above ${BPS} bps`);
  if (![split?.holdersBps, split?.burnBps, split?.treasuryBps].every((share) => Number.isInteger(share) && share >= 0)) throw new Error("the launch file needs split.holdersBps, split.burnBps and split.treasuryBps, whole numbers");
  if (split.holdersBps + split.burnBps + split.treasuryBps !== BPS) throw new Error(`the opening split has to add up to ${BPS} bps`);
  if (split.treasuryBps < limits.minTreasuryBps || split.treasuryBps > limits.maxTreasuryBps) throw new Error(`the opening split has to give the treasury between ${limits.minTreasuryBps} and ${limits.maxTreasuryBps} bps`);
  // The rest of what is written into the token or the curve for good.
  for (const name of ["feeBps", "startCapSol", "graduationCapUsd"] as const) {
    if (!(typeof input[name] === "number" && input[name] > 0)) throw new Error(`the launch file needs ${name}, a number above zero`);
  }
  if (!Array.isArray(input.names) || input.names.length === 0 || !input.names.every((name) => typeof name?.name === "string" && name.name && typeof name?.symbol === "string" && name.symbol)) {
    throw new Error(`the launch file needs names, a list with at least one { "name": ..., "symbol": ... }`);
  }
  if (typeof input.uri !== "string" || !/^https:\/\/[^\s<>]+$/.test(input.uri)) throw new Error("the launch file needs uri, the https:// address of the token's card. The example's placeholder is still there, or it is not an address");
  if (typeof input.rpc !== "string" || !/^https?:\/\//.test(input.rpc)) throw new Error("the launch file needs rpc, the address of a node, starting with https://");

  const readKeypair = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  /** A keypair kept next to the launch file, made on first use. */
  function keptKeypair(name: string): Keypair {
    const path = resolve(dir, name);
    if (!existsSync(path)) writeFileSync(path, JSON.stringify(Array.from(Keypair.generate().secretKey)));
    return readKeypair(path);
  }
  let payer: Keypair;
  try {
    payer = readKeypair(resolve(dir, String(input.payerKeypair)));
  } catch {
    // Said without the reason, which could quote what is in the file.
    throw new Error(`the launch file needs payerKeypair, the keypair file that pays, next to it or by its full path. ${resolve(dir, String(input.payerKeypair))} is not one`);
  }

  const connection = new Connection(input.rpc, "confirmed");
  let genesis: string;
  try {
    genesis = await connection.getGenesisHash();
  } catch (error) {
    throw new Error(`the node named as rpc in the launch file did not answer (${plain(error)}). Check that address`);
  }
  const network = NETWORKS[genesis] ?? "an unknown network";
  const mint = keptKeypair("mint.json");
  const config = keptKeypair("curve-config.json");
  const rulebook = rulebookAddress(hookProgram, mint.publicKey);

  const program = await connection.getAccountInfo(hookProgram);
  if (!program?.executable) throw new Error(`${input.hookProgram} is not a program on ${network}: deploy the hook first`);
  const price = await solPriceUsd();
  const curve = { startCapSol: input.startCapSol, graduationCapSol: input.graduationCapUsd / price, feeBps: input.feeBps };
  const solToGraduate = Number(curveConfig(curve).migrationQuoteThreshold.toString()) / LAMPORTS_PER_SOL;
  const balance = (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
  const round = (n: number) => Math.round(n).toLocaleString("en-US");
  /** A line under one of the summary's, when there is something to warn of. */
  const also = (yes: boolean, text: string) => (yes ? `\n                 ${text}` : "");

  console.log(`
  network        ${network}
  token          ${input.names[0].name} (${input.names[0].symbol}), mint ${mint.publicKey.toBase58()}
  hook program   ${input.hookProgram}
  payer          ${payer.publicKey.toBase58()} with ${balance.toFixed(3)} SOL${also(balance < PAYER_NEEDS_SOL, `WARNING: a launch costs about ${COST_SOL} SOL and is not started with less than ${PAYER_NEEDS_SOL} SOL in this wallet`)}
  guardian       ${guardian.toBase58()}
  agent          ${agent.toBase58()}${also(agent.equals(guardian), "WARNING: it is the guardian's own key here: the brake would sit on the server, next to what it is there to stop")}
  keeper         ${keeper.toBase58()}
                 takes the trading fees out of the curve and pays them out; the guardian can replace it${also(keeper.equals(guardian), "WARNING: it is the guardian's own key here: whoever breaks into one has both")}${also(keeper.equals(agent), "WARNING: it is the agent's own key here: one stolen key would write the rules and take the fees")}
  fee claimer    ${rulebook.toBase58()}
                 the token's rulebook, an address no key controls: only the program claims, and only for the keeper
  app key        ${cosigner?.toBase58() ?? "none: no hook about the app applies to this token unless the guardian names an app key later"}

  fixed for good
  trading fee    ${input.feeBps / 100}% per trade, of which Meteora keeps ${METEORA_FEE_SHARE * 100}%
  curve          starts at ${input.startCapSol} SOL of market cap, graduates at ${round(curve.graduationCapSol)} SOL
                 (US$ ${round(input.graduationCapUsd)} at US$ ${price.toFixed(0)}/SOL), which takes ${round(solToGraduate)} SOL of buys
  limits         one edict every ${span(limits.minIntervalSecs)} at most, an edict stands ${span(limits.maxRuleSecs)} at most,
                 treasury never below ${limits.minTreasuryBps / 100}% and never above ${limits.maxTreasuryBps / 100}% of the fees
  names          ${input.names.length > 1 ? `${input.names.map((name) => `${name.name} (${name.symbol})`).join(", ")}; one change every ${span(limits.minRenameSecs)} at most` : "one, for good"}
  card           ${input.uri}
                 ${await cardAt(input.uri, input.names[0])}
  opens with     no rule; fees ${split.holdersBps / 100}% holders, ${split.burnBps / 100}% burn, ${split.treasuryBps / 100}% treasury
`);

  // A dry run ends by reaching the end of the file, not through process.exit. On Windows that
  // call cuts across the connections to the RPC and the price feed while Node is still closing
  // them, and the process dies on its way out with a failed assertion and exit code 127.
  if (!send) return void console.log(`Nothing was sent. Add --send to launch${network === "mainnet" ? ", and --mainnet with it" : ""}. A launch costs the payer about ${COST_SOL} SOL.`);

  if (network === "mainnet" && !flags.includes("--mainnet")) throw new Error("this is mainnet: add --mainnet if that is what you mean");
  if (balance < PAYER_NEEDS_SOL) throw new Error(`the payer needs at least ${PAYER_NEEDS_SOL} SOL: a launch costs about ${COST_SOL} SOL`);

  sending = true;
  const { pool } = await launch(
    {
      dbc: DynamicBondingCurveClient.create(connection, "confirmed"),
      hookProgram,
      payer,
      mint,
      config,
      guardian,
      agent,
      keeper,
      cosigner,
      limits,
      split,
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
    rulebook: rulebook.toBase58(),
    curveConfig: config.publicKey.toBase58(),
    pool: pool.toBase58(),
    feeBps: input.feeBps,
    launchedAt: new Date().toISOString(),
  };
  writeFileSync(resolve(dir, "token.json"), `${JSON.stringify(token, null, 2)}\n`);
  console.log(`\n  launched. Addresses are in ${resolve(dir, "token.json")}`);
}

// A refusal is one sentence, not a stack trace. The command still ends by reaching the end of
// the file, with the exit code set, for the reason given above.
try {
  await run();
} catch (error) {
  console.error(sending
    ? `\n  The launch stopped: ${plain(error)}\n  What was done before that stays done. Run the same command again: it goes on from where it stopped.\n`
    : `\n  Nothing was sent: ${plain(error)}\n`);
  process.exitCode = 1;
}
