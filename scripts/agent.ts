// The agent, running. Start it and leave it: it watches the token and rewrites its rules by
// itself for as long as the process lives.
//
//   npm run agent            runs until stopped
//   npm run agent -- --once  takes one look and exits
//
// Settings come from the environment, or from a .env file next to package.json:
//   RPC_URL, HOOK_PROGRAM, MINT, POOL   where the token lives
//   AGENT_KEYPAIR                       path to the agent's keypair file (keep it out of the repository)
//   ANTHROPIC_API_KEY                   read by the Anthropic SDK
//   AGENT_LOG                           its memory and public record (default agent-log.jsonl)
//   AGENT_MODEL, AGENT_EFFORT           default claude-opus-5-5, medium
//   AGENT_POLL_SECS                     how often it checks the market (default 20)
//   AGENT_THINK_EVERY_SECS              how long between looks when the market is quiet (default 300)
//   AGENT_WAKE_ON_MOVE_PCT              a market-cap move that makes it look right away (default 10)
//   DRY_RUN=1                           decide and log, send nothing
import { existsSync, readFileSync } from "node:fs";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { askClaude, runOnce, watch, type Context, type Outcome } from "../src/agent.js";
import { solPriceUsd } from "../src/price.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const env = (name: string, fallback?: string) => {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
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

let waiting = false;
function report(event: Outcome | { status: "error"; error: unknown }) {
  // "too soon" repeats on every poll until the chain's interval opens: say it once.
  if (event.status === "too-soon" && waiting) return;
  waiting = event.status === "too-soon";
  const line =
    event.status === "rewritten" ? `rewrote the rules: ${event.announcement}${event.signature ? ` (${event.signature})` : " (dry run, nothing sent)"}`
    : event.status === "held" ? `left the rules as they are: ${event.reasoning}`
    : event.status === "too-soon" ? `wants to look, but the last change was too recent; ${event.seconds}s to go`
    : event.status === "paused" ? "paused by the guardian"
    : `error: ${event.error instanceof Error ? event.error.message : String(event.error)}`;
  console.log(`${new Date().toISOString()} ${line}`);
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
    wakeOnMovePct: Number(env("AGENT_WAKE_ON_MOVE_PCT", "10")),
    signal: stop.signal,
    report,
  });
}
