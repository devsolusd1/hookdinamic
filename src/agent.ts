// The agent: looks at the token's market, asks Claude which of the ready-made hooks to switch
// on, and puts the answer in the rulebook. It holds one key, and that key can do one thing:
// issue edicts inside the limits fixed at launch. Whatever goes wrong here, the program has
// the last word.
//
// The hooks are a fixed catalogue (site/hooks.js). The model picks from it and can add nothing
// to it. It only ever sees numbers read from the chain and its own earlier edicts, never text written by other people, so nobody can talk it into anything through a
// post or a memo.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { getPriceFromSqrtPrice, type DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { type Connection, type Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } from "@solana/web3.js";
import { z } from "zod";
import { BUYING_HOOKS, buyingHooksFor, FEE_HOOKS, IDENTITY_HOOK, recogniseRule, recogniseSplit, ruleOf, worded } from "../site/hooks.js";
import { TOKEN_DECIMALS, TOTAL_SUPPLY } from "./curve.js";
import { BPS, decodeRulebook, describe, FACTS, OPS, rulebookAddress, setNameIx, setRulesIx, span, type Change, type Condition, type Limits, type Name, type Rulebook } from "./hook.js";

const ids = (hooks: { id: string }[]) => hooks.map((hook) => hook.id) as [string, ...string[]];

/** What the model answers with: its picks from the catalogue, and what it has to say about them. */
const Decision = z.object({
  buying: z.enum(["none", ...ids(BUYING_HOOKS)]).describe("The buying hook to switch on, or \"none\" to leave buying unrestricted."),
  setting: z.number().describe("Which of that hook's settings, counted from 1. Use 1 for a hook with one setting, and for \"none\"."),
  minutes: z.number().describe("How long this edict stands, in whole minutes. The next one is written when it is up."),
  fees: z.enum(ids(FEE_HOOKS)).describe("The fee hook to switch on."),
  name: z.number().describe("0 to keep the token's name. Otherwise the number of the name to take, from the list in the message."),
  announcement: z.string().describe("What holders read. Names the hooks now on, what they mean for a buyer and how long the edict stands. At most 240 characters."),
  reasoning: z.string().describe("Two or three sentences on why these, given the market and your earlier edicts. Public as well."),
});
type Decision = z.infer<typeof Decision>;

/** What was picked from the catalogue for one edict. */
export type Choice = {
  /** The buying hook and which of its settings, counted from 1. Null: none. */
  buying: { hook: string; setting: number } | null;
  fees: string;
  /** The name to take, counted from 0 in the rulebook's list. Null: keep the name. */
  name: number | null;
  /** How long the edict stands. */
  minutes: number;
};

/** What the model is shown. */
export type Snapshot = {
  now: string;
  in_force: {
    edicts_issued: number;
    minutes_since_last_edict: number | null;
    /** The buying hook that is on, by name and setting; "none"; or, for a rule not in the catalogue, the rule in words. */
    buying: string;
    minutes_left: number;
    fees: string;
    fee_shares: string;
    name: string;
  };
  /** What each fee hook would do to the fees of this token right now. */
  fee_hooks: { id: string; shares: string }[];
  names: { number: number; name: string; ticker: string; current: boolean }[];
  name_change: { allowed_now: boolean; allowed_in_minutes: number; at_most_once_every_hours: number };
  limits: { shortest_edict_minutes: number; longest_edict_minutes: number; app_available: boolean };
  market: {
    market_cap_sol: number;
    market_cap_usd: number | null;
    sol_in_curve: number;
    supply_sold_pct: number;
    fees_collected_sol: number;
    pool_transactions_since_last_edict: number;
  };
  /** Its own earlier decisions, oldest first. */
  history: { at: string; action: string; buying?: string; minutes?: number; fees?: string; name?: string; announcement?: string; market_cap_sol: number }[];
};

/** What one look cost in tokens, as the model's API reports it. */
export type Usage = { inputTokens: number; outputTokens: number };

export type Verdict =
  | { action: "hold"; reasoning: string; model: string; usage?: Usage }
  | { action: "rewrite"; choice: Choice; announcement: string; reasoning: string; model: string; usage?: Usage };

export type Decide = (snapshot: Snapshot, book: Rulebook) => Promise<Verdict>;

/** A change as the log keeps it: the chain's own numbers, with 64-bit values as text. */
type LoggedChange = Omit<Change, "rule"> & { rule: { group: number; fact: number; op: number; value: string }[] };

/** One line of the agent's log. `note` is the sha256 of `record`, and is what the rulebook stores. */
export type LogEntry = {
  record: {
    mint: string;
    epoch: number;
    at: string;
    action: "rewrite" | "hold";
    /** What was picked from the catalogue. */
    hooks?: Omit<Choice, "minutes">;
    /** What that came to on chain. */
    change?: LoggedChange;
    announcement?: string;
    reasoning: string;
    model: string;
  };
  note?: string;
  signature?: string;
  marketCapSol: number;
  usage?: Usage;
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
  /** Decide and report, but send nothing and record nothing. */
  dryRun?: boolean;
};

export type Outcome =
  | { status: "paused" }
  | { status: "too-soon"; seconds: number }
  | { status: "in-force"; seconds: number }
  | { status: "held"; reasoning: string; usage?: Usage }
  | { status: "rewritten"; choice: Choice; change: Change; announcement: string; reasoning: string; signature: string | null; usage?: Usage };

const hasApp = (book: Rulebook) => !book.cosigner.equals(PublicKey.default);

/** A buying pick by its name in the catalogue and its setting: "Max Buy · 1%". */
export function buyingLabel(buying: Choice["buying"]): string {
  if (!buying) return "none";
  const hook = BUYING_HOOKS.find((known) => known.id === buying.hook);
  const label = hook?.settings[buying.setting - 1]?.label;
  return hook ? `${worded(hook.name)}${label ? ` · ${label}` : ""}` : buying.hook;
}

const feeName = (id: string) => FEE_HOOKS.find((hook) => hook.id === id)?.name ?? id;

const sharesInWords = (split: { holdersBps: number; burnBps: number; treasuryBps: number }) =>
  `holders ${split.holdersBps / 100}%, burn ${split.burnBps / 100}%, treasury ${split.treasuryBps / 100}%`;

/** What a pick from the catalogue comes to on chain: the rule, its term and the fee shares. Throws on a hook the catalogue does not have. */
export function changeOf(choice: Choice, limits: Limits): Change {
  const fees = FEE_HOOKS.find((hook) => hook.id === choice.fees);
  if (!fees) throw new Error(`there is no fee hook called "${choice.fees}"`);
  return {
    ruleSecs: Math.round(choice.minutes * 60),
    rule: choice.buying ? ruleOf(choice.buying.hook, choice.buying.setting) : [],
    ...fees.split(limits.maxTreasuryBps),
  };
}

/** Why the program would refuse this change, or null. Mirrors `Limits::admit` in the program. */
export function outsideLimits(change: Change, limits: Limits, appAvailable: boolean): string | null {
  const whole = (n: number) => Number.isInteger(n) && n >= 0;
  if (![change.ruleSecs, change.holdersBps, change.burnBps, change.treasuryBps].every(whole)) return "every number must be whole and not negative";
  if (!appAvailable && change.rule.some((condition) => FACTS[condition.fact]?.name === "via_app")) return "this token names no app, so a hook about one cannot be used";
  if (change.ruleSecs < 1 || change.ruleSecs > limits.maxRuleSecs) return `an edict stands for between 1 and ${Math.floor(limits.maxRuleSecs / 60)} minutes`;
  if (change.holdersBps + change.burnBps + change.treasuryBps !== BPS) return "the three fee shares must add up to exactly 100%";
  if (change.treasuryBps > limits.maxTreasuryBps) return `the treasury can get at most ${limits.maxTreasuryBps / 100}% of the fees`;
  return null;
}

/**
 * Whether anybody could buy at some point while the rule is in force. The program does not
 * ask this: a rule nobody can meet is legal there and simply closes buying until it lapses.
 * The agent asks, and does not send such a rule.
 */
export function somebodyCanBuy(change: Change, facts: { now: number; curveSolThousandths: number; appAvailable: boolean }): boolean {
  if (change.rule.length === 0) return true;
  const during = (period: number, modulo: number) => {
    const values = new Set<number>();
    for (let t = facts.now; t <= facts.now + change.ruleSecs && values.size < modulo; t += period) values.add(Math.floor(t / period) % modulo);
    values.add(Math.floor((facts.now + change.ruleSecs) / period) % modulo);
    return [...values];
  };
  // The values each fact can take while the rule lasts. Sizes and balances are open ranges, so
  // the edges of every condition are tried; the curve holds what it holds.
  const range = (max: number, conditions: Condition[]) => {
    const edges = conditions.flatMap((c) => (OPS[c.op] === "mod" ? [Number(c.value & 0xffff_ffffn)] : [Number(c.value) - 1, Number(c.value), Number(c.value) + 1]));
    return [0, 1, max, ...edges].filter((value) => value >= 0 && value <= max);
  };
  const possible = (fact: string, conditions: Condition[]): number[] => {
    switch (fact) {
      case "minute": return during(60, 60);
      case "hour": return during(3_600, 24);
      case "weekday": return during(86_400, 7).map((day) => (day + 4) % 7);
      case "elapsed": return range(change.ruleSecs, conditions);
      case "via_app": return facts.appAvailable ? [0, 1] : [0];
      case "curve_sol": return [facts.curveSolThousandths];
      case "luck": return Array.from({ length: 100 }, (_, i) => i);
      case "priority_fee": return range(10_000_000, conditions);
      default: return range(1_000_000, conditions).filter((value) => fact !== "size" || value > 0);
    }
  };
  const holds = (c: Condition, seen: number) => {
    const value = BigInt(seen);
    switch (OPS[c.op]) {
      case "<": return value < c.value;
      case "<=": return value <= c.value;
      case ">": return value > c.value;
      case ">=": return value >= c.value;
      case "==": return value === c.value;
      case "!=": return value !== c.value;
      default: return value % (c.value >> 32n) === (c.value & 0xffff_ffffn);
    }
  };
  return [0, 1, 2, 3].some((group) => {
    const members = change.rule.filter((c) => c.group === group);
    if (members.length === 0) return false;
    // Facts are judged one at a time: within a group, each must have some value that meets every condition on it.
    return [...new Set(members.map((c) => c.fact))].every((fact) => {
      const about = members.filter((c) => c.fact === fact);
      return possible(FACTS[fact].name, about).some((seen) => about.every((c) => holds(c, seen)));
    });
  });
}

/**
 * Why this pick cannot become an edict right now, or null. Everything the program would
 * refuse is caught here first, and so is a pick the catalogue does not have.
 */
export function unfit(choice: Choice, book: Rulebook, facts: { now: number; curveSolThousandths: number }): string | null {
  const appAvailable = hasApp(book);
  if (choice.buying) {
    const hook = BUYING_HOOKS.find((known) => known.id === choice.buying!.hook);
    if (!hook) return `there is no buying hook called "${choice.buying.hook}"`;
    if (hook.needsApp && !appAvailable) return `this token names no app, so "${hook.id}" cannot be used`;
    const setting = hook.settings[choice.buying.setting - 1];
    if (!Number.isInteger(choice.buying.setting) || !setting) return `"${hook.id}" has settings 1 to ${hook.settings.length}`;
    if (setting.minMinutes && choice.minutes < setting.minMinutes) return `"${hook.id}" at that setting needs an edict of at least ${setting.minMinutes} minutes`;
  }
  if (!FEE_HOOKS.some((hook) => hook.id === choice.fees)) return `there is no fee hook called "${choice.fees}"`;
  if (!(choice.minutes > 0)) return "an edict has to stand for some time";
  if (choice.name !== null) {
    if (!Number.isInteger(choice.name) || choice.name < 0 || choice.name >= book.names.length) return `the token has names 1 to ${book.names.length}`;
    if (choice.name === book.name) return "that is the name the token already goes by: answer 0 to keep it";
    const wait = book.renamedAt + book.limits.minRenameSecs - facts.now;
    if (wait > 0) return `the name cannot change for another ${Math.ceil(wait / 60)} minutes`;
  }
  const change = changeOf(choice, book.limits);
  const outside = outsideLimits(change, book.limits, appAvailable);
  if (outside) return outside;
  return somebodyCanBuy(change, { ...facts, appAvailable }) ? null : "nobody could buy at any point while that hook is on";
}

/** The catalogue as the model reads it, for a token that does or does not name an app. */
function catalogue(appAvailable: boolean): string {
  const buying = buyingHooksFor(appAvailable).map((hook) => {
    const settings = hook.settings.length > 1 ? `Settings: ${hook.settings.map((setting, i) => `${i + 1}) ${setting.label}`).join("  ")}` : "One setting.";
    return `- ${hook.id}: ${worded(hook.name)}. ${worded(hook.about)} ${settings}`;
  });
  const fees = FEE_HOOKS.map((hook) => `- ${hook.id}: ${hook.name}. ${hook.about}`);
  return `Buying hooks\n${buying.join("\n")}\n\nFee hooks\n${fees.join("\n")}\n\n${IDENTITY_HOOK.name}\n${IDENTITY_HOOK.about}`;
}

const MECHANICS = (appAvailable: boolean) => `You are in charge of a token on Solana. It trades on one bonding curve, and a program attached to the token checks every buy. You change what the token does by issuing edicts, and you are the only one who can. Nobody approves an edict before it goes out.

You do not invent rules. Every hook you can use was written before launch and is listed below. What you decide is which hooks are on, at which setting, and for how long.

One edict sets three things at once:
1. The buying hook: one of the buying hooks below, or "none". Only buying is ever restricted. Selling, and moving tokens between wallets, are never restricted by you or by anyone, so do not describe a hook as locking people in.
2. The fee hook: where the project's part of the trading fees goes. One is always on. The message shows what each would come to in numbers right now.
3. The token's name: keep it, or change it to another of the names in the message.

An edict stands for the number of minutes you give it, between the shortest and the longest the message allows. When that time is up its buying hook stops applying by itself, and you are called to write the next edict.

${catalogue(appAvailable)} The message lists the names, says which is in use and whether a change is allowed right now; the program allows one only every so often. A new name is an occasion, not a habit: most edicts keep the name.

How to choose. The choice is yours, and there is no right answer to find. Look at the market in the message and at your own earlier edicts, and pick what you judge fits the moment: something tighter when buying is frantic, something looser or nothing at all when it is quiet, and another fee hook when the last one has had its turn. Do not settle into a pattern. Unless you have a reason you can state, do not switch on a buying hook you used in either of your last two edicts.

Everything you write is public. The announcement is what holders read: name the hooks that are now on, say in plain words what they mean for a buyer and how long the edict stands, and say nothing about where the price will go. The page next to it shows the same edict as the chain stores it, so the two must agree.`;

function toChoice(decision: Decision): Choice {
  return {
    buying: decision.buying === "none" ? null : { hook: decision.buying, setting: decision.setting },
    fees: decision.fees,
    name: decision.name === 0 ? null : decision.name - 1,
    minutes: decision.minutes,
  };
}

/** Asks Claude. `persona` is how the token talks; it comes before the mechanics. */
export function askClaude(options: { persona: string; model?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" }): Decide {
  const model = options.model ?? "claude-opus-5-5";
  const client = new Anthropic();
  return async (snapshot, book) => {
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const hold = (reasoning: string): Verdict => ({ action: "hold", reasoning, model, usage });
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: JSON.stringify(snapshot, null, 2) }];
    const facts = { now: Math.floor(Date.parse(snapshot.now) / 1000), curveSolThousandths: Math.round(snapshot.market.sol_in_curve * 1000) };
    // One second chance if the first answer cannot be used.
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
          system: `${options.persona.trim()}\n\n${MECHANICS(hasApp(book))}`,
          messages,
        });
      } catch (error) {
        // A model that cannot be reached is not a reason to stop: the edict in force stays until the next try.
        if (error instanceof Anthropic.RateLimitError) return hold("rate limited by the model's API; nothing changes");
        if (error instanceof Anthropic.InternalServerError) return hold("the model's API had an error; nothing changes");
        if (error instanceof Anthropic.APIConnectionError) return hold("could not reach the model's API; nothing changes");
        throw error;
      }
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      if (response.stop_reason === "refusal") return hold("the model declined to answer; nothing changes");
      const decision = response.parsed_output;
      if (!decision) return hold(`the model's answer could not be read (${response.stop_reason}); nothing changes`);

      const choice = toChoice(decision);
      const problem = unfit(choice, book, facts);
      if (!problem) return { action: "rewrite", choice, announcement: decision.announcement.slice(0, 240), reasoning: decision.reasoning, model: response.model, usage };
      messages.push({ role: "assistant", content: response.content }, { role: "user", content: `That cannot be used: ${problem}. Choose again.` });
    }
    return hold("two answers in a row could not be used; nothing changes");
  };
}

export function readLog(path: string): LogEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogEntry);
}

/** The sha256 the rulebook stores next to a change, so anyone can match it to the published text. */
export const noteOf = (record: LogEntry["record"]) => createHash("sha256").update(JSON.stringify(record)).digest();

const logged = (change: Change): LoggedChange => ({ ...change, rule: change.rule.map((c) => ({ ...c, value: c.value.toString() })) });

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

const nameInWords = (name?: { name: string; symbol: string }) => (name ? `${name.name} (${name.symbol})` : "unnamed");

export async function takeSnapshot(ctx: Context, book: Rulebook, now: number, history: LogEntry[]): Promise<Snapshot> {
  const { pool, marketCapSol } = await readPool(ctx);
  const fees = await ctx.dbc.state.getPoolFeeMetrics(ctx.pool);
  const signatures = await ctx.connection.getSignaturesForAddress(ctx.pool, { limit: 1000 });
  const solPrice = ctx.solPriceUsd ? await ctx.solPriceUsd().catch(() => null) : null;
  const round = (n: number, digits = 2) => Number(n.toFixed(digits));
  const standing = now < book.ruleUntil;
  const rule = recogniseRule(book.rule);
  const renameIn = Math.max(0, book.renamedAt + book.limits.minRenameSecs - now);

  return {
    now: new Date(now * 1000).toISOString(),
    in_force: {
      edicts_issued: Number(book.epoch),
      minutes_since_last_edict: book.updatedAt ? round((now - book.updatedAt) / 60, 0) : null,
      buying: !standing || book.rule.length === 0 ? "none" : rule ? buyingLabel({ hook: rule.hook.id, setting: rule.setting }) : describe(book.rule).join("; or if "),
      minutes_left: standing ? round((book.ruleUntil - now) / 60, 0) : 0,
      fees: recogniseSplit(book, book.limits.maxTreasuryBps)?.hook.name ?? "shares outside the catalogue",
      fee_shares: sharesInWords(book),
      name: nameInWords(book.names[book.name]),
    },
    fee_hooks: FEE_HOOKS.map((hook) => ({ id: hook.id, shares: sharesInWords(hook.split(book.limits.maxTreasuryBps)) })),
    names: book.names.map((name, i) => ({ number: i + 1, name: name.name, ticker: name.symbol, current: i === book.name })),
    name_change: { allowed_now: book.names.length > 1 && renameIn === 0, allowed_in_minutes: Math.ceil(renameIn / 60), at_most_once_every_hours: round(book.limits.minRenameSecs / 3_600, 1) },
    limits: {
      shortest_edict_minutes: Math.max(5, Math.ceil(book.limits.minIntervalSecs / 60)),
      longest_edict_minutes: Math.floor(book.limits.maxRuleSecs / 60),
      app_available: hasApp(book),
    },
    market: {
      market_cap_sol: round(marketCapSol),
      market_cap_usd: solPrice ? round(marketCapSol * solPrice, 0) : null,
      sol_in_curve: round(Number(pool.quoteReserve.toString()) / 1e9, 3),
      supply_sold_pct: round(100 - (Number(pool.baseReserve.toString()) / 10 ** TOKEN_DECIMALS / TOTAL_SUPPLY) * 100),
      fees_collected_sol: round(Number(fees.total.totalTradingQuoteFee.toString()) / 1e9, 4),
      pool_transactions_since_last_edict: signatures.filter((s) => !s.err && (s.blockTime ?? 0) >= book.updatedAt).length,
    },
    history: history.slice(-12).map(({ record, marketCapSol }) => ({
      at: record.at,
      action: record.action,
      ...(record.hooks
        ? {
            buying: buyingLabel(record.hooks.buying),
            minutes: record.change ? Math.round(record.change.ruleSecs / 60) : undefined,
            fees: feeName(record.hooks.fees),
            ...(record.hooks.name !== null ? { name: nameInWords(book.names[record.hooks.name]) } : {}),
          }
        : {}),
      announcement: record.announcement,
      market_cap_sol: marketCapSol,
    })),
  };
}

/** The lamports the mint is short of to carry name `index`, which may be longer than the one it has. */
async function rentForName(ctx: Context, book: Rulebook, index: number): Promise<number> {
  const mint = await ctx.connection.getAccountInfo(ctx.mint);
  if (!mint) throw new Error(`no mint at ${ctx.mint.toBase58()}`);
  const bytes = (name: { name: string; symbol: string }) => Buffer.byteLength(name.name) + Buffer.byteLength(name.symbol);
  const longer = Math.max(0, bytes(book.names[index]) - bytes(book.names[book.name]));
  return Math.max(0, (await ctx.connection.getMinimumBalanceForRentExemption(mint.data.length + longer)) - mint.lamports);
}

/**
 * One look at the token: issue an edict, or leave things as they are, and write down which
 * and why. With `letRuleRun`, an edict whose term is still running is left alone, so that it
 * stands for as long as it said; without it, the look replaces whatever is in force.
 */
export async function runOnce(ctx: Context, options: { letRuleRun?: boolean } = {}): Promise<Outcome> {
  // The cheap checks come first: this runs on every poll while an edict is running or the chain's own interval is closed.
  const book = await readBook(ctx);
  if (!book.agent.equals(ctx.agent.publicKey)) throw new Error(`${ctx.agent.publicKey.toBase58()} is not this token's agent (${book.agent.toBase58()} is)`);
  if (book.paused) return { status: "paused" };
  const now = await chainTime(ctx.connection);
  const left = book.ruleUntil - now;
  if (options.letRuleRun && left > 0) return { status: "in-force", seconds: left };
  const wait = book.updatedAt === 0 ? 0 : book.updatedAt + book.limits.minIntervalSecs - now;
  if (wait > 0) return { status: "too-soon", seconds: wait };

  const snapshot = await takeSnapshot(ctx, book, now, readLog(ctx.logPath));
  const verdict = await ctx.decide(snapshot, book);
  const base = { mint: ctx.mint.toBase58(), at: snapshot.now, reasoning: verdict.reasoning, model: verdict.model };
  const entry = { marketCapSol: snapshot.market.market_cap_sol, ...(verdict.usage ? { usage: verdict.usage } : {}) };
  if (verdict.action === "hold") {
    // A dry run leaves no trace: the log is the public record, and it only holds what really happened.
    const record: LogEntry["record"] = { ...base, epoch: Number(book.epoch), action: "hold" };
    if (!ctx.dryRun) appendFileSync(ctx.logPath, `${JSON.stringify({ record, ...entry } satisfies LogEntry)}\n`);
    return { status: "held", reasoning: verdict.reasoning, usage: verdict.usage };
  }

  // Checked again here so a decision that did not come from `askClaude` gets the same treatment.
  const { choice } = verdict;
  const problem = unfit(choice, book, { now, curveSolThousandths: Math.round(snapshot.market.sol_in_curve * 1000) });
  if (problem) throw new Error(`the decision cannot be used: ${problem}`);
  const change = changeOf(choice, book.limits);
  const { minutes: _minutes, ...hooks } = choice;
  const record: LogEntry["record"] = {
    mint: base.mint,
    epoch: Number(book.epoch) + 1,
    at: base.at,
    action: "rewrite",
    hooks,
    change: logged(change),
    announcement: verdict.announcement,
    reasoning: base.reasoning,
    model: base.model,
  };
  const decided = { choice, change, announcement: verdict.announcement, reasoning: verdict.reasoning, usage: verdict.usage };
  if (ctx.dryRun) return { status: "rewritten", ...decided, signature: null };

  const note = noteOf(record);
  const tx = new Transaction().add(setRulesIx({ program: ctx.hookProgram, agent: ctx.agent.publicKey, mint: ctx.mint, change, note }));
  if (choice.name !== null) {
    // A name changes in the same transaction as its edict, right after it. The mint was given
    // room for its longest name at launch; this covers a mint that was not.
    const short = await rentForName(ctx, book, choice.name);
    if (short > 0) tx.add(SystemProgram.transfer({ fromPubkey: ctx.agent.publicKey, toPubkey: ctx.mint, lamports: short }));
    tx.add(setNameIx({ program: ctx.hookProgram, agent: ctx.agent.publicKey, mint: ctx.mint, index: choice.name }));
  }
  const signature = await sendAndConfirmTransaction(ctx.connection, tx, [ctx.agent], { commitment: "confirmed" });
  appendFileSync(ctx.logPath, `${JSON.stringify({ record, ...entry, note: note.toString("hex"), signature } satisfies LogEntry)}\n`);
  return { status: "rewritten", ...decided, signature };
}

/** An edict in a few plain lines, for a terminal. `names` are the token's, to say which one it took. */
export function inWords(choice: Choice, change: Change, names: Name[] = []): string[] {
  const ways = describe(change.rule);
  return [
    `buying: ${buyingLabel(choice.buying)}, for ${span(change.ruleSecs)}${ways.length ? ` (a buy goes through if ${ways.join("; or if ")})` : ""}`,
    `fees: ${feeName(choice.fees)} (${sharesInWords(change)})`,
    ...(choice.name !== null ? [`name: now ${nameInWords(names[choice.name])}`] : []),
  ];
}

export type WatchOptions = {
  /** How often it checks whether it is time to write again, in seconds. */
  pollSecs: number;
  /** How long it waits before trying again after a look that issued nothing, in seconds. */
  thinkEverySecs: number;
  signal?: AbortSignal;
  report?: (event: Outcome | { status: "error"; error: unknown }) => void;
};

/**
 * The agent on its own, for as long as the process lives: it issues an edict, lets it stand
 * for the time it gave it, and issues the next one when that time is up. Nobody approves
 * anything; the only brakes are the limits in the rulebook and the guardian's pause.
 */
export async function watch(ctx: Context, options: WatchOptions): Promise<void> {
  let lookedAt = 0;
  while (!options.signal?.aborted) {
    try {
      const clock = Date.now() / 1000;
      if (clock - lookedAt >= options.thinkEverySecs) {
        const outcome = await runOnce(ctx, { letRuleRun: true });
        options.report?.(outcome);
        // Being turned away by an edict still running, or by the chain's own interval, is not a
        // look: it tries again on the next poll. So does an edict just issued, which has its own term.
        if (outcome.status === "held" || outcome.status === "paused") lookedAt = clock;
      }
    } catch (error) {
      // An RPC hiccup or a failed transaction must not stop the agent.
      options.report?.({ status: "error", error });
      lookedAt = Date.now() / 1000;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.pollSecs * 1000);
      options.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
