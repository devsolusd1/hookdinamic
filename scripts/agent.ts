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
//   AGENT_LOG                           its memory and public record (default agent-log.jsonl)
//   AGENT_MODEL, AGENT_EFFORT           default claude-opus-5-5, medium
//   AGENT_POLL_SECS                     how often it checks whether it is time to write again (default 20)
//   AGENT_THINK_EVERY_SECS              how long it waits before trying again after a look that issued nothing (default 300)
//   DRY_RUN=1                           decide and print; send and record nothing
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { askClaude, inWords, readBook, runOnce, watch, type Context, type Outcome } from "../src/agent.js";
import { solPriceUsd } from "../src/price.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const env = (name: string, fallback?: string) => {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
// The SDK also accepts a login profile kept under ~/.config/anthropic; without any of these
// it would only fail at the first look, with a stack trace.
const hasCredential = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE"].some((name) => process.env[name]) || existsSync(join(homedir(), ".config", "anthropic"));
if (!hasCredential) {
  console.error("No Anthropic credential found. Create a key at console.anthropic.com (API keys) and put it in .env as ANTHROPIC_API_KEY=...");
  process.exit(1);
}

const effort = env("AGENT_EFFORT", "medium");
if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error(`AGENT_EFFORT cannot be ${effort}`);

const connection = new Connection(env("RPC_URL"), "confirmed");
const ctx: Context = {
  connection,
  dbc: DynamicBondingCurveClient.create(connection, "confirmed"),
  hookProgram: new PublicKey(env("HOOK_PROGRAM")),
  mint: new PublicKey(env("MINT")),
  pool: new PublicKey(env("POOL")),
  agent: Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(env("AGENT_KEYPAIR"), "utf8")))),
  logPath: env("AGENT_LOG", "agent-log.jsonl"),
  decide: askClaude({
    persona: readFileSync(new URL("../agent/persona.md", import.meta.url), "utf8"),
    model: env("AGENT_MODEL", "claude-opus-5-5"),
    effort: effort as "low" | "medium" | "high" | "xhigh" | "max",
  }),
  solPriceUsd,
  dryRun: process.env.DRY_RUN === "1",
};

// The token's names are written at launch and never added to, so they are read once.
const { names } = await readBook(ctx);
let waitingOn: string | null = null;
function report(event: Outcome | { status: "error"; error: unknown }) {
  // Waiting repeats on every poll until the edict's time is up or the chain's interval opens: say it once.
  const waiting = event.status === "in-force" || event.status === "too-soon";
  if (waiting && waitingOn === event.status) return;
  waitingOn = waiting ? event.status : null;
  const line =
    event.status === "rewritten" ? `${event.signature ? "issued an edict" : "would issue an edict (dry run, nothing sent)"}: ${event.announcement}`
    : event.status === "held" ? `issued nothing: ${event.reasoning}`
    : event.status === "in-force" ? `the edict in force has ${Math.ceil(event.seconds / 60)} min left; the next one comes when its time is up`
    : event.status === "too-soon" ? `wants to look, but the last edict was too recent; ${event.seconds}s to go`
    : event.status === "paused" ? "paused by the guardian"
    : `error: ${event.error instanceof Error ? event.error.message : String(event.error)}`;
  console.log(`${new Date().toISOString()} ${line}`);
  if (event.status === "rewritten") {
    for (const line of inWords(event.choice, event.change, names)) console.log(`    ${line}`);
    console.log(`    why: ${event.reasoning}`);
    if (event.signature) console.log(`    transaction ${event.signature}`);
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
    pollSecs: Number(env("AGENT_POLL_SECS", "20")),
    thinkEverySecs: Number(env("AGENT_THINK_EVERY_SECS", "300")),
    signal: stop.signal,
    report,
  });
}
