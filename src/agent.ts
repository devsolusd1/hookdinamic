// The agent: looks at the token's market, asks Claude what the rules should be next, and writes
// them to the rulebook. It holds one key, and that key can do one thing: rewrite the rules
// inside the limits fixed at launch. Whatever goes wrong here, the program has the last word.
//
// The model only ever sees numbers read from the chain and its own earlier decisions, never
// text written by other people, so nobody can talk it into anything through a post or a memo.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { getPriceFromSqrtPrice, type DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { type Connection, type Keypair, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import { z } from "zod";
import { TOKEN_DECIMALS, TOTAL_SUPPLY } from "./curve.js";
import { BPS, decodeRulebook, rulebookAddress, setRulesIx, type Change, type Limits, type Rulebook } from "./hook.js";

/** What the model answers with. Percentages rather than basis points: they are what people read. */
const Decision = z.object({
  action: z.enum(["rewrite", "hold"]).describe("rewrite: put the rules below in force. hold: change nothing this time."),
  gate_minutes: z.number().describe("Length of the app-only window that starts now, in minutes. 0 for none."),
  max_buy_pct: z.number().describe("Cap on one buy, in percent of total supply. 0 for no cap."),
  max_wallet_pct: z.number().describe("Cap on what one wallet may hold, in percent of total supply. 0 for no cap."),
  holders_pct: z.number().describe("Share of the trading fees paid to holders, in percent."),
  burn_pct: z.number().describe("Share of the trading fees used to buy the token back and burn it, in percent."),
  treasury_pct: z.number().describe("Share of the trading fees kept by the project, in percent."),
  announcement: z.string().describe("What holders read. Says what changes and for how long. At most 240 characters."),
  reasoning: z.string().describe("Two to four sentences on why. Public as well."),
});
type Decision = z.infer<typeof Decision>;

/** What the model is shown. */
export type Snapshot = {
  now: string;
  rules: {
    times_rewritten: number;
    minutes_since_last_change: number | null;
    app_only_window_minutes_left: number;
    max_buy_pct: number;
    max_wallet_pct: number;
    fee_split: { holders_pct: number; burn_pct: number; treasury_pct: number };
  };
  limits: {
    max_app_only_window_minutes: number;
    lowest_max_buy_pct: number;
    lowest_max_wallet_pct: number;
    max_treasury_pct: number;
    minutes_between_changes: number;
  };
  market: {
    market_cap_sol: number;
    market_cap_usd: number | null;
    sol_in_curve: number;
    supply_sold_pct: number;
    fees_collected_sol: number;
    pool_transactions_since_last_change: number;
  };
  /** Its own earlier decisions, oldest first. */
  history: { at: string; action: string; rules?: Change; announcement?: string; market_cap_sol: number }[];
};

export type Verdict =
  | { action: "hold"; reasoning: string; model: string }
  | { action: "rewrite"; change: Change; announcement: string; reasoning: string; model: string };

export type Decide = (snapshot: Snapshot, book: Rulebook) => Promise<Verdict>;

/** One line of the agent's log. `note` is the sha256 of `record`, and is what the rulebook stores. */
export type LogEntry = {
  record: { mint: string; epoch: number; at: string; action: "rewrite" | "hold"; change?: Change; announcement?: string; reasoning: string; model: string };
  note?: string;
  signature?: string;
  marketCapSol: number;
};

export type Context = {
  connection: Connection;
  dbc: DynamicBondingCurveClient;
  hookProgram: PublicKey;
  mint: PublicKey;
  pool: PublicKey;
  agent: Keypair;
  /** A JSON-lines file: the agent's memory and the public record of its decisions. */
  logPath: string;
  decide: Decide;
  solPriceUsd?: () => Promise<number>;
  /** Decide and log, but send nothing. */
  dryRun?: boolean;
};

export type Outcome =
  | { status: "paused" }
  | { status: "too-soon"; seconds: number }
  | { status: "held"; reasoning: string }
  | { status: "rewritten"; change: Change; announcement: string; signature: string | null };

/** Why the program would refuse this change, or null. Mirrors `Limits::admit` in the program. */
export function outsideLimits(change: Change, limits: Limits, hasCosigner: boolean): string | null {
  const whole = (n: number) => Number.isInteger(n) && n >= 0;
  if (![change.gateSecs, change.maxBuyBps, change.maxWalletBps, change.holdersBps, change.burnBps, change.treasuryBps].every(whole)) return "every value must be a non-negative number";
  if (change.gateSecs > limits.maxGateSecs) return `the app-only window can last at most ${limits.maxGateSecs / 60} minutes`;
  if (change.gateSecs > 0 && !hasCosigner) return "this token has no app key, so it cannot open an app-only window";
  if (change.maxBuyBps !== 0 && (change.maxBuyBps < limits.minMaxBuyBps || change.maxBuyBps > BPS)) return `a max buy is 0 (none) or between ${limits.minMaxBuyBps / 100}% and 100%`;
  if (change.maxWalletBps !== 0 && (change.maxWalletBps < limits.minMaxWalletBps || change.maxWalletBps > BPS)) return `a max wallet is 0 (none) or between ${limits.minMaxWalletBps / 100}% and 100%`;
  if (change.holdersBps + change.burnBps + change.treasuryBps !== BPS) return "the three fee shares must add up to exactly 100%";
  if (change.treasuryBps > limits.maxTreasuryBps) return `the treasury can get at most ${limits.maxTreasuryBps / 100}% of the fees`;
  return null;
}

const toChange = (d: Decision): Change => ({
  gateSecs: Math.round(d.gate_minutes * 60),
  maxBuyBps: Math.round(d.max_buy_pct * 100),
  maxWalletBps: Math.round(d.max_wallet_pct * 100),
  holdersBps: Math.round(d.holders_pct * 100),
  burnBps: Math.round(d.burn_pct * 100),
  treasuryBps: Math.round(d.treasury_pct * 100),
});

const MECHANICS = `You decide the trading rules of a token on Solana. The token trades on one bonding curve, and a program attached to the token enforces whatever rules are in force on every buy. You are the only one who can change those rules. Each time you are called you see the market and your own earlier decisions, and you choose the rules for the next stretch.

What you control:
- An app-only window. While it is open the token can only be bought through the FOMO app; it closes by itself when its time is up.
- A cap on one buy, as a share of total supply.
- A cap on what one wallet may hold, as a share of total supply.
- Where the trading fees collected from now on go: to holders, to buying the token back and burning it, or to the project's treasury.

Selling is never restricted, by you or by anyone: a holder can always leave. Do not describe any rule as locking people in.

The limits in the message are enforced on chain. A choice outside them is rejected, so stay inside them.

The point of this token is that its rules keep changing in ways people can follow and react to. A good change has one clear idea behind it that a holder understands in a sentence, responds to what the market did since your last change, and differs from what you did recently. You may also hold when changing nothing is the better call; say why.

Everything you write is public. The announcement is what holders read: say exactly what changes and for how long, and nothing about where the price will go.`;

/** Asks Claude. `persona` is how the token talks; it comes before the mechanics. */
export function askClaude(options: { persona: string; model?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" }): Decide {
  const model = options.model ?? "claude-opus-5-5";
  const client = new Anthropic();
  return async (snapshot, book) => {
    const hold = (reasoning: string): Verdict => ({ action: "hold", reasoning, model });
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: JSON.stringify(snapshot, null, 2) }];
    // One second chance if the first answer is outside the limits.
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await client.beta.messages.parse({
          model,
          max_tokens: 16000,
          // If a safety classifier declines the request, the API re-runs it on its recommended fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: options.effort ?? "medium", format: betaZodOutputFormat(Decision) },
          system: `${options.persona.trim()}\n\n${MECHANICS}`,
          messages,
        });
      } catch (error) {
        // A model that cannot be reached is not a reason to stop: the rules stay as they are until the next run.
        if (error instanceof Anthropic.RateLimitError) return hold("rate limited by the model's API; the rules stay as they are");
        if (error instanceof Anthropic.InternalServerError) return hold("the model's API had an error; the rules stay as they are");
        if (error instanceof Anthropic.APIConnectionError) return hold("could not reach the model's API; the rules stay as they are");
        throw error;
      }
      if (response.stop_reason === "refusal") return hold("the model declined to answer; the rules stay as they are");
      const decision = response.parsed_output;
      if (!decision) return hold(`the model's answer could not be read (${response.stop_reason}); the rules stay as they are`);
      if (decision.action === "hold") return { action: "hold", reasoning: decision.reasoning, model: response.model };

      const change = toChange(decision);
      const problem = outsideLimits(change, book.limits, !book.cosigner.equals(PublicKey.default));
      if (!problem) return { action: "rewrite", change, announcement: decision.announcement.slice(0, 240), reasoning: decision.reasoning, model: response.model };
      messages.push({ role: "assistant", content: response.content }, { role: "user", content: `That is outside the limits: ${problem}. Choose again.` });
    }
    return hold("two answers in a row were outside the limits; the rules stay as they are");
  };
}

export function readLog(path: string): LogEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogEntry);
}

/** The sha256 the rulebook stores next to a change, so anyone can match it to the published text. */
export const noteOf = (record: LogEntry["record"]) => createHash("sha256").update(JSON.stringify(record)).digest();

async function chainTime(connection: Connection): Promise<number> {
  const time = await connection.getBlockTime(await connection.getSlot());
  return time ?? Math.floor(Date.now() / 1000);
}

export async function readBook(ctx: Pick<Context, "connection" | "hookProgram" | "mint">): Promise<Rulebook> {
  const account = await ctx.connection.getAccountInfo(rulebookAddress(ctx.hookProgram, ctx.mint));
  if (!account) throw new Error(`no rulebook for ${ctx.mint.toBase58()} under ${ctx.hookProgram.toBase58()}`);
  return decodeRulebook(account.data);
}

async function readPool(ctx: Pick<Context, "dbc" | "pool">) {
  const account = await ctx.dbc.state.getPool(ctx.pool);
  if (!account) throw new Error(`no pool at ${ctx.pool.toBase58()}`);
  const pool = account.poolState;
  return { pool, marketCapSol: getPriceFromSqrtPrice(pool.sqrtPrice, TOKEN_DECIMALS, 9).toNumber() * TOTAL_SUPPLY };
}

export const readMarketCapSol = async (ctx: Pick<Context, "dbc" | "pool">) => (await readPool(ctx)).marketCapSol;

export async function takeSnapshot(ctx: Context, book: Rulebook, now: number, history: LogEntry[]): Promise<Snapshot> {
  const { pool, marketCapSol } = await readPool(ctx);
  const fees = await ctx.dbc.state.getPoolFeeMetrics(ctx.pool);
  const signatures = await ctx.connection.getSignaturesForAddress(ctx.pool, { limit: 1000 });
  const solPrice = ctx.solPriceUsd ? await ctx.solPriceUsd().catch(() => null) : null;
  const round = (n: number, digits = 2) => Number(n.toFixed(digits));

  const snapshot: Snapshot = {
    now: new Date(now * 1000).toISOString(),
    rules: {
      times_rewritten: Number(book.epoch),
      minutes_since_last_change: book.updatedAt ? round((now - book.updatedAt) / 60, 0) : null,
      app_only_window_minutes_left: Math.max(0, round((book.gateUntil - now) / 60, 0)),
      max_buy_pct: book.maxBuyBps / 100,
      max_wallet_pct: book.maxWalletBps / 100,
      fee_split: { holders_pct: book.holdersBps / 100, burn_pct: book.burnBps / 100, treasury_pct: book.treasuryBps / 100 },
    },
    limits: {
      max_app_only_window_minutes: book.cosigner.equals(PublicKey.default) ? 0 : book.limits.maxGateSecs / 60,
      lowest_max_buy_pct: book.limits.minMaxBuyBps / 100,
      lowest_max_wallet_pct: book.limits.minMaxWalletBps / 100,
      max_treasury_pct: book.limits.maxTreasuryBps / 100,
      minutes_between_changes: round(book.limits.minIntervalSecs / 60, 1),
    },
    market: {
      market_cap_sol: round(marketCapSol),
      market_cap_usd: solPrice ? round(marketCapSol * solPrice, 0) : null,
      sol_in_curve: round(Number(pool.quoteReserve.toString()) / 1e9, 3),
      supply_sold_pct: round(100 - (Number(pool.baseReserve.toString()) / 10 ** TOKEN_DECIMALS / TOTAL_SUPPLY) * 100),
      fees_collected_sol: round(Number(fees.total.totalTradingQuoteFee.toString()) / 1e9, 4),
      pool_transactions_since_last_change: signatures.filter((s) => !s.err && (s.blockTime ?? 0) >= book.updatedAt).length,
    },
    history: history.slice(-12).map((entry) => ({
      at: entry.record.at,
      action: entry.record.action,
      rules: entry.record.change,
      announcement: entry.record.announcement,
      market_cap_sol: entry.marketCapSol,
    })),
  };
  return snapshot;
}

/** One look at the token: rewrite the rules, or leave them, and write down which and why. */
export async function runOnce(ctx: Context): Promise<Outcome> {
  // The cheap checks come first: this runs on every poll while the chain's own interval is still closed.
  const book = await readBook(ctx);
  if (!book.agent.equals(ctx.agent.publicKey)) throw new Error(`${ctx.agent.publicKey.toBase58()} is not this token's agent (${book.agent.toBase58()} is)`);
  if (book.paused) return { status: "paused" };
  const now = await chainTime(ctx.connection);
  const wait = book.updatedAt === 0 ? 0 : book.updatedAt + book.limits.minIntervalSecs - now;
  if (wait > 0) return { status: "too-soon", seconds: wait };

  const snapshot = await takeSnapshot(ctx, book, now, readLog(ctx.logPath));
  const verdict = await ctx.decide(snapshot, book);
  const record: LogEntry["record"] = {
    mint: ctx.mint.toBase58(),
    epoch: Number(book.epoch) + (verdict.action === "rewrite" ? 1 : 0),
    at: snapshot.now,
    action: verdict.action,
    ...(verdict.action === "rewrite" ? { change: verdict.change, announcement: verdict.announcement } : {}),
    reasoning: verdict.reasoning,
    model: verdict.model,
  };
  const entry: LogEntry = { record, marketCapSol: snapshot.market.market_cap_sol };
  if (verdict.action === "hold") {
    appendFileSync(ctx.logPath, `${JSON.stringify(entry)}\n`);
    return { status: "held", reasoning: verdict.reasoning };
  }

  // Checked again here so a decision that did not come from `askClaude` gets the same treatment.
  const problem = outsideLimits(verdict.change, book.limits, !book.cosigner.equals(PublicKey.default));
  if (problem) throw new Error(`the decision is outside the limits: ${problem}`);
  const note = noteOf(record);
  let signature: string | null = null;
  if (!ctx.dryRun) {
    const tx = new Transaction().add(setRulesIx({ program: ctx.hookProgram, agent: ctx.agent.publicKey, mint: ctx.mint, change: verdict.change, note }));
    signature = await sendAndConfirmTransaction(ctx.connection, tx, [ctx.agent], { commitment: "confirmed" });
  }
  appendFileSync(ctx.logPath, `${JSON.stringify({ ...entry, note: note.toString("hex"), ...(signature ? { signature } : {}) })}\n`);
  return { status: "rewritten", change: verdict.change, announcement: verdict.announcement, signature };
}

export type WatchOptions = {
  /** How often it checks the market, in seconds. */
  pollSecs: number;
  /** How long it lets pass between two looks when the market is quiet, in seconds. */
  thinkEverySecs: number;
  /** A market-cap move since its last look, in percent, that makes it look again right away. */
  wakeOnMovePct: number;
  signal?: AbortSignal;
  report?: (event: Outcome | { status: "error"; error: unknown }) => void;
};

/**
 * The agent on its own: watches the market for as long as the process lives and looks at the
 * rules whenever enough time has passed or the price has moved. Nobody approves anything; the
 * only brakes are the limits in the rulebook and the guardian's pause.
 */
export async function watch(ctx: Context, options: WatchOptions): Promise<void> {
  let lookedAt = 0;
  let capAtLook: number | null = null;
  while (!options.signal?.aborted) {
    try {
      const cap = await readMarketCapSol(ctx);
      const clock = Date.now() / 1000;
      const due = clock - lookedAt >= options.thinkEverySecs;
      const moved = capAtLook !== null && Math.abs(cap / capAtLook - 1) * 100 >= options.wakeOnMovePct;
      if (due || moved) {
        const outcome = await runOnce(ctx);
        options.report?.(outcome);
        // A look the chain's own interval turned away does not count: it tries again on the next poll.
        if (outcome.status !== "too-soon") {
          lookedAt = clock;
          capAtLook = cap;
        }
      }
    } catch (error) {
      // An RPC hiccup or a failed transaction must not stop the agent.
      options.report?.({ status: "error", error });
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.pollSecs * 1000);
      options.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
