// The agent, running. Start it and leave it: it issues an edict, lets it stand for the time it
// gave it, and issues the next one, for as long as the process lives.
//
//   npm run agent            runs until stopped
//   npm run agent -- --once  takes one look now, replacing whatever edict is in force, and exits
//
// Settings come from the environment, or from a .env file next to package.json:
//   RPC_URL, HOOK_PROGRAM, MINT, POOL   where the token lives
//   AGENT_KEYPAIR                       path to the agent's keypair file (keep it out of the repository)
//   ANTHROPIC_API_KEY                   read by the Anthropic SDK
//   AGENT_LOG                           its memory and public record (default agent-log.jsonl). Next to it, under the
//                                       same name with .pending added, an edict's line waits while its transaction is out.
//   AGENT_MODEL, AGENT_EFFORT           default claude-opus-5-5, medium
//   AGENT_POLL_SECS                     how often it reads the rulebook to see whether it is time to write again (default 20)
//   AGENT_THINK_EVERY_SECS              how long it leaves the model alone after a look that issued nothing (default 300)
//   AGENT_PRIORITY_MICROLAMPORTS        what an edict's transaction bids for each compute unit it asks for, to get into a
//                                       block (default 50000, a price for a quiet day, which comes to about 0.00001 SOL
//                                       an edict; 1000000 for a day like the launch's, about 0.0001 SOL an edict;
//                                       0 bids nothing; at most 5000000)
//   DRY_RUN=1                           decide and print; send and record nothing. The model is asked as often
//                                       as it would be for real: once, and again when that edict's time would be up.
//                                       The edict's transaction is built all the same, and its memo, size and fee are printed.
//
// Before it asks the model it reads its own wallet. With too little in it to be sure of paying
// for an edict it says so, asks nothing, and looks again at every poll: it goes on by itself
// once SOL has arrived. A dry run says the same and goes ahead.
import "../src/quiet.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { askClaude, figuresInWords, inWords, memoInWords, priorityFrom, readBook, runOnce, shortInWords, watch, type Context, type Outcome } from "../src/agent.js";
import { solPriceUsd } from "../src/price.js";
import { plain } from "./serve.js";

async function run() {
  if (existsSync(".env")) process.loadEnvFile(".env");

  const env = (name: string, fallback?: string) => {
    const value = process.env[name] || fallback;
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  // The SDK also accepts a login profile kept under ~/.config/anthropic; without any of these
  // it would only fail at the first look, with a stack trace.
  const hasCredential = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE"].some((name) => process.env[name]) || existsSync(join(homedir(), ".config", "anthropic"));
  if (!hasCredential) throw new Error("No Anthropic credential found. Create a key at console.anthropic.com (API keys) and put it in .env as ANTHROPIC_API_KEY=...");

  const effort = env("AGENT_EFFORT", "medium");
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error(`AGENT_EFFORT cannot be ${effort}`);
  const seconds = (name: string, fallback: string) => {
    const value = Number(env(name, fallback));
    if (!(value > 0)) throw new Error(`${name} has to be a number of seconds above zero`);
    return value;
  };

  const keyFile = env("AGENT_KEYPAIR");
  let agent: Keypair;
  try {
    agent = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyFile, "utf8"))));
  } catch {
    // Said without the reason, which could quote what is in the file.
    throw new Error(`AGENT_KEYPAIR names ${keyFile}, which is not a keypair file: it has to hold a list of 64 numbers`);
  }

  const connection = new Connection(env("RPC_URL"), "confirmed");
  const ctx: Context = {
    connection,
    dbc: DynamicBondingCurveClient.create(connection, "confirmed"),
    hookProgram: new PublicKey(env("HOOK_PROGRAM")),
    mint: new PublicKey(env("MINT")),
    pool: new PublicKey(env("POOL")),
    agent,
    logPath: env("AGENT_LOG", "agent-log.jsonl"),
    decide: askClaude({
      persona: readFileSync(new URL("../agent/persona.md", import.meta.url), "utf8"),
      model: env("AGENT_MODEL", "claude-opus-5-5"),
      effort: effort as "low" | "medium" | "high" | "xhigh" | "max",
    }),
    solPriceUsd,
    dryRun: process.env.DRY_RUN === "1",
    priorityMicroLamports: priorityFrom(process.env.AGENT_PRIORITY_MICROLAMPORTS),
  };

  // The token's names are written at launch and never added to, so they are read once.
  const { names } = await readBook(ctx);
  let saidLast: string | null = null;
  /** What a rehearsal last said of a wallet that holds too little, so that it says it once and not at every look. */
  let saidOfWallet: string | null = null;
  const address = ctx.agent.publicKey.toBase58();
  function report(event: Outcome | { status: "error"; error: unknown }) {
    // Only a rehearsal gets as far as the model with too little in the wallet, and it only says so.
    if (event.status === "held" || event.status === "rewritten") {
      const lacking = event.funds && event.funds.holds < event.funds.needs ? `my wallet ${address} needs topping up before this is for real: ${shortInWords(event.funds)}. A dry run goes on all the same; for real I would ask the model nothing until SOL arrives.` : null;
      if (lacking !== null && lacking !== saidOfWallet) console.log(`${new Date().toISOString()} ${lacking}`);
      saidOfWallet = lacking;
    }
    const line =
      event.status === "rewritten" ? `${event.signature ? "issued an edict" : "would issue an edict (dry run, nothing sent)"}: ${event.announcement}`
      : event.status === "held" ? `issued nothing: ${event.reasoning}`
      : event.status === "in-force" ? `the edict in force has ${Math.ceil(event.seconds / 60)} min left; the next one comes when its time is up`
      : event.status === "too-soon" ? `wants to look, but the last edict was too recent; ${event.seconds}s to go`
      : event.status === "paused" ? "paused by the guardian"
      : event.status === "resting" ? "the next look is not due yet"
      : event.status === "short" ? `my wallet ${address} needs topping up: ${shortInWords(event.funds)}. I ask the model nothing until SOL arrives, and go on by myself once it has.`
      // An RPC node's complaint can quote the address it was sent to, which carries its key: only the host is printed.
      : `error: ${plain(event.error)}`;
    // Waiting repeats on every poll, a pause for as long as it lasts, and an error that does
    // not go away at every try: each is said once. So is a wallet that holds too little, which
    // is found again at every poll, and said again when what it holds has changed.
    const news = event.status === "in-force" || event.status === "too-soon" || event.status === "paused" || event.status === "resting" ? event.status : event.status === "error" || event.status === "short" ? line : null;
    if (news !== null && news === saidLast) return;
    saidLast = news;
    console.log(`${new Date().toISOString()} ${line}`);
    if (event.status === "rewritten") {
      for (const line of inWords(event.choice, event.change, names)) console.log(`    ${line}`);
      console.log(`    why: ${event.reasoning}`);
      if (event.signature) console.log(`    transaction ${event.signature}`);
      // The transaction carries the announcement as its memo. For one that was sent, only a
      // memo that had to be cut is worth a line; a rehearsal says what it would have been.
      if (!event.signature || event.memo !== event.announcement) console.log(`    ${memoInWords(event.announcement, event.memo)}`);
      console.log(`    ${figuresInWords(event.transaction)}${event.signature ? "" : " (built, not signed)"}`);
    }
    if ((event.status === "rewritten" || event.status === "held") && event.usage) {
      console.log(`    tokens: ${event.usage.inputTokens} in, ${event.usage.outputTokens} out`);
    }
  }

  console.log(`agent ${ctx.agent.publicKey.toBase58()} on token ${ctx.mint.toBase58()}${ctx.dryRun ? " (dry run)" : ""}`);
  if (process.argv.includes("--once")) {
    report(await runOnce(ctx));
  } else {
    const stop = new AbortController();
    process.on("SIGINT", () => stop.abort());
    process.on("SIGTERM", () => stop.abort());
    await watch(ctx, {
      pollSecs: seconds("AGENT_POLL_SECS", "20"),
      thinkEverySecs: seconds("AGENT_THINK_EVERY_SECS", "300"),
      signal: stop.signal,
      report,
    });
  }
}

// What stops it before it starts, or stops a single look, is said in one line. The command
// ends by reaching the end of the file, not through process.exit: on Windows that call cuts
// across the connection to the RPC while Node is still closing it.
try {
  await run();
} catch (error) {
  console.error(plain(error));
  process.exitCode = 1;
}
