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
// What an earlier run left on chain is compared with the file before anything is sent. A
// config and a rulebook can never be changed, so a file that now asks for something else is
// refused, with what can still be done. Once the token is there, at the end of a launch and
// on every later run, its config and its mint are read back from the chain and printed.
//
// Whatever it refuses, it says in one sentence and leaves with exit code 1.
import "../src/quiet.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, SendTransactionError } from "@solana/web3.js";
import { curveConfig, METEORA_FEE_SHARE, SOL_IN_EXISTENCE } from "../src/curve.js";
import { BPS, rulebookAddress, span, type Limits, type Name, type Split } from "../src/hook.js";
import { earlierRun, launch, mustNotGraduate, readBack, Refused, TIMES_ALL_SOL, type Launch, type Launched } from "../src/launch.js";

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
  /**
   * The market cap the curve starts at, in SOL. Where the curve would graduate is not asked
   * for: it cannot, and that is set in src/curve.ts, not by a number here.
   */
  startCapSol: number;
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
/** What of that is spent once the curve's config is made, and once the rulebook is written as well. Measured: 0.00875 and 0.01762. */
const SPENT_SOL = { config: 0.009, rulebook: 0.018 };
/** The least the payer has to hold before anything is sent. */
const PAYER_NEEDS_SOL = 0.05;

/** An error as one line that is safe to print: the RPC's address carries its key, so only the host of any address is kept. */
function plain(error: unknown): string {
  // For a transaction a node refused, the library's first line is only "Simulation failed.":
  // the node's own reason is what tells a busy node from a refusal by a program.
  const said = error instanceof SendTransactionError ? `the node refused the transaction: ${error.transactionError.message}` : error instanceof Error ? error.message : String(error);
  const text = said.split("\n")[0];
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/g, (address) => {
    try {
      return new URL(address).origin;
    } catch {
      return "(an address)";
    }
  });
}

/**
 * How far this run has got, which decides how a refusal ends. "checking": the file and the
 * chain are being looked at, and nothing can have been sent. "launching": transactions are
 * going out. "reading": the token is launched and is being read back.
 */
let stage: "checking" | "launching" | "reading" = "checking";
/** How many transactions this run has sent. */
let sentNow = 0;
/** The launch file's own name, for the sentences that say what to do with it. */
let fileName = "launch.json";

/**
 * What can still be done after the chain was found to hold something else than the file
 * asks for, said in the files of the launch folder. It depends on how far the earlier run
 * got: a new config is a way out only until the rulebook is written.
 */
function wayOut({ reached, guardianCan }: Refused): string {
  const back = `put this folder back as the earlier run left it (${fileName} as it was, with the same mint.json and curve-config.json) and run the same command again, which goes on from where that run stopped`;
  if (reached === "config") {
    return `A config can never be changed. Either ${back}; or, to launch what the file says now, delete curve-config.json and run the command again: it makes a new config, and the about ${SPENT_SOL.config} SOL the old one cost is lost.`;
  }
  if (reached === "rulebook") {
    return (
      `Neither a config nor a rulebook can ever be changed, and a new curve-config.json is no way out now: the rulebook is written once for this mint, and it holds the vault of the one pool this mint and the old config make. ` +
      `Either ${back}; or, to launch what the file says now, start again in a new folder, with a copy of ${fileName} and of the payer's key and without this folder's mint.json and curve-config.json: the command makes new ones there, so the token gets another address, and the about ${SPENT_SOL.rulebook} SOL spent on the old one is lost.` +
      (guardianCan ? " Once the token is launched its guardian can replace the agent, the keeper and the app key (docs/emergencia.md), so the first way need not lose anything." : "")
    );
  }
  return `The token is launched, and it is what the chain holds: nothing in ${fileName} can change it now. Put ${fileName} back as it was, and this command reads the token back. What the file says now would be another token, launched from a new folder.`;
}

/** The last lines of a run that did not end well. They never say "run the same command again" unless that would go on from here. */
function ending(error: unknown): string {
  if (error instanceof Refused) {
    // Read back right after this run's own transactions, the token can only differ from the file if something else wrote to the chain.
    if (sentNow > 0) return `  The token is launched, and read back from the chain it is not what ${fileName} describes: ${error.difference}.\n  Do not announce it before whoever programs has looked at this.`;
    return `  ${stage === "checking" ? "Nothing was sent" : "The launch stopped, and this run sent nothing"}: ${error.difference}.\n  ${wayOut(error)}`;
  }
  if (stage === "checking") return `  Nothing was sent: ${plain(error)}`;
  if (stage === "reading") return `  The token is launched, and it could not be read back just now: ${plain(error)}\n  Run the same command again: it sends nothing more, and reads the token back.`;
  return `  The launch stopped: ${plain(error)}\n  What was done before that stays done. Run the same command again, with ${fileName} as it is: it goes on from where it stopped.`;
}

/** What the chain says of the launched token, as lines under the summary. */
function readBackLines(back: Launched, rulebook: PublicKey): string {
  const whole = (n: number) => Math.round(n).toLocaleString("en-US");
  // This line is printed on any later day too, so it does not count the times: there is more SOL every year.
  const times = back.graduationSol > TIMES_ALL_SOL * SOL_IN_EXISTENCE ? `more than ${TIMES_ALL_SOL} times` : `${TIMES_ALL_SOL} times`;
  return [
    "  read back from the chain",
    `  curve          ${back.segments === 1 ? "one segment" : `${back.segments} segments`}, starting at ${back.startCapSol} SOL of market cap; graduating takes`,
    `                 ${whole(back.graduationSol)} SOL in the curve, ${times} all the SOL there is`,
    `  trading fee    ${back.feeBps / 100}% per trade, ${back.feeFlat ? "the same for good" : "changing over time"}, taken in ${back.feeInSol ? "SOL" : "the token as well as SOL"}`,
    `  fee claimer    ${back.feeClaimer.toBase58()}${back.feeClaimer.equals(rulebook) ? ", the token's rulebook" : ""}`,
    `  hook           on the mint: ${back.hook.toBase58()}`,
    `  token          ${back.name} (${back.symbol}), card ${back.uri}`,
    ...back.since.map((note) => `  since launch   ${note}`),
  ].join("\n");
}

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
  fileName = basename(file);
  let input: LaunchFile;
  try {
    input = JSON.parse(readFileSync(file, "utf8")) as LaunchFile;
  } catch (error) {
    throw new Error(existsSync(file) ? `${file} is not valid JSON: ${plain(error)}` : `there is no file at ${file}`);
  }
  const send = flags.includes("--send");

  // Meteora never lets a curve's fee claimer change, so it is not a wallet and not a choice.
  if ("feeClaimer" in input) throw new Error("the launch file cannot name a feeClaimer: the fees are claimed by the token's rulebook, for the keeper. Remove that line and name the keeper");
  // A file from before the curve was set never to graduate still names where it would. Left
  // in, the line would read as if it decided something.
  const graduation = Object.keys(input).find((key) => /^graduat/i.test(key));
  if (graduation) throw new Error(`the launch file cannot name a ${graduation}: the curve is built never to graduate, and no number in the file changes that. Remove that line`);
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
  for (const name of ["feeBps", "startCapSol"] as const) {
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
  const curve = { startCapSol: input.startCapSol, feeBps: input.feeBps };
  // Read from the config the launch would send, so the summary says what goes on chain. The
  // summary says "cannot graduate" only of a curve that is refused if it could.
  const wouldSend = curveConfig(curve);
  mustNotGraduate(wouldSend);
  const graduationSol = Number(wouldSend.migrationQuoteThreshold.toString()) / LAMPORTS_PER_SOL;
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
  curve          starts at ${input.startCapSol} SOL of market cap and cannot graduate: graduating takes
                 ${round(graduationSol)} SOL in the curve, ${Math.floor(graduationSol / SOL_IN_EXISTENCE)} times all the SOL there is (about ${round(SOL_IN_EXISTENCE / 1e6)} million)
  limits         one edict every ${span(limits.minIntervalSecs)} at most, an edict stands ${span(limits.maxRuleSecs)} at most,
                 treasury never below ${limits.minTreasuryBps / 100}% and never above ${limits.maxTreasuryBps / 100}% of the fees
  names          ${input.names.length > 1 ? `${input.names.map((name) => `${name.name} (${name.symbol})`).join(", ")}; one change every ${span(limits.minRenameSecs)} at most` : "one, for good"}
  card           ${input.uri}
                 ${await cardAt(input.uri, input.names[0])}
  opens with     no rule; fees ${split.holdersBps / 100}% holders, ${split.burnBps / 100}% burn, ${split.treasuryBps / 100}% treasury
`);

  const launching: Launch = { dbc: DynamicBondingCurveClient.create(connection, "confirmed"), hookProgram, payer, mint, config, guardian, agent, keeper, cosigner, limits, split, curve, names: input.names, uri: input.uri };

  // A dry run ends by reaching the end of the file, not through process.exit. On Windows that
  // call cuts across the connections to the RPC and to the card's address while Node is still
  // closing them, and the process dies on its way out with a failed assertion and exit code 127.
  if (!send) {
    // It looks at what an earlier run left as well, so that the summary above is never shown for a token the chain would not let this file make.
    const reached = await earlierRun(launching);
    if (reached === "pool") {
      console.log(`${readBackLines(await readBack(launching, 1), rulebook)}\n`);
      return void console.log("Nothing was sent. This token is already launched, and --send would send nothing either.");
    }
    if (reached) return void console.log(`Nothing was sent. An earlier run already ${reached === "config" ? "made the curve's config" : "made the curve's config and wrote the rulebook"}, as this file describes ${reached === "config" ? "it" : "them"}: --send${network === "mainnet" ? " with --mainnet" : ""} goes on from there.`);
    return void console.log(`Nothing was sent. Add --send to launch${network === "mainnet" ? ", and --mainnet with it" : ""}. A launch costs the payer about ${COST_SOL} SOL.`);
  }

  if (network === "mainnet" && !flags.includes("--mainnet")) throw new Error("this is mainnet: add --mainnet if that is what you mean");
  if (balance < PAYER_NEEDS_SOL) throw new Error(`the payer needs at least ${PAYER_NEEDS_SOL} SOL: a launch costs about ${COST_SOL} SOL`);

  stage = "launching";
  const { pool } = await launch(launching, async (what, tx, signers) => {
    const signature = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
    sentNow++;
    console.log(`  ${what}: ${signature}`);
  });

  // The addresses are written down before the token is read back, so that a node that is slow to show it costs nothing.
  stage = "reading";
  const tokenFile = resolve(dir, "token.json");
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
  /** Whether the file already there is this token's. A run that sent nothing leaves it as it is, with the day of the launch in it. */
  const written = () => {
    try {
      const kept = JSON.parse(readFileSync(tokenFile, "utf8")) as Partial<typeof token>;
      return kept.mint === token.mint && kept.pool === token.pool && kept.hookProgram === token.hookProgram;
    } catch {
      return false;
    }
  };
  if (sentNow > 0 || !written()) writeFileSync(tokenFile, `${JSON.stringify(token, null, 2)}\n`);
  console.log(sentNow > 0 ? `\n  launched. Addresses are in ${tokenFile}` : `\n  already launched: this run sent nothing. Addresses are in ${tokenFile}`);

  console.log(`\n${readBackLines(await readBack(launching), rulebook)}\n`);
}

// A refusal is one sentence, not a stack trace. The command still ends by reaching the end of
// the file, with the exit code set, for the reason given above.
try {
  await run();
} catch (error) {
  console.error(`\n${ending(error)}\n`);
  process.exitCode = 1;
}
