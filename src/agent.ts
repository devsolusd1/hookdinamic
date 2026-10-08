// The agent: looks at the token's market, asks Claude which of the ready-made hooks to switch
// on, and puts the answer in the rulebook. It holds one key, and that key can do one thing:
// issue edicts inside the limits fixed at launch. Whatever goes wrong here, the program has
// the last word.
//
// The hooks are a fixed catalogue (site/hooks.js). The model picks from it and can add nothing
// to it. It only ever sees numbers read from the chain and its own earlier edicts, never text written by other people, so nobody can talk it into anything through a
// post or a memo.
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, openSync, readFileSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { getPriceFromSqrtPrice, type DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { type Connection, type Keypair, PublicKey, SendTransactionError, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { z } from "zod";
import { BUYING_HOOKS, buyingHooksFor, FEE_HOOKS, IDENTITY_HOOK, recogniseRule, recogniseSplit, ruleOf, worded } from "../site/hooks.js";
import { TOKEN_DECIMALS, TOTAL_SUPPLY } from "./curve.js";
import { BPS, decodeRulebook, describe, FACTS, OPS, rulebookAddress, setNameIx, setRulesIx, span, type Change, type Condition, type Limits, type Name, type Rulebook } from "./hook.js";

const ids = (hooks: { id: string }[]) => hooks.map((hook) => hook.id) as [string, ...string[]];

/** The most an announcement may be, in characters as JavaScript counts them. */
export const ANNOUNCEMENT_MAX = 240;

/** What the model answers with: its picks from the catalogue, and what it has to say about them. */
const Decision = z.object({
  buying: z.enum(["none", ...ids(BUYING_HOOKS)]).describe("The buying hook to switch on, or \"none\" to leave buying unrestricted."),
  setting: z.number().describe("Which of that hook's settings, counted from 1. Use 1 for a hook with one setting, and for \"none\"."),
  minutes: z.number().describe("How long this edict stands, in whole minutes. The next one is written when it is up."),
  fees: z.enum(ids(FEE_HOOKS)).describe("The fee hook to switch on."),
  name: z.number().describe("0 to keep the token's name. Otherwise the number of the name to take, from the list in the message."),
  announcement: z.string().describe(`What holders read, and what goes on chain with the edict. Names the hooks now on, what they mean for a buyer and how long the edict stands. At most ${ANNOUNCEMENT_MAX} characters, in plain letters, digits and everyday punctuation.`),
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
  limits: {
    shortest_edict_minutes: number;
    longest_edict_minutes: number;
    /** The least and the most of the fees the treasury may be given. Every fee hook stays between them. */
    treasury_least_pct: number;
    treasury_most_pct: number;
    app_available: boolean;
  };
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
    /**
     * What the edict's transaction carries as its memo, when that is not the announcement
     * whole: the announcement cut short, or nothing. Left out when the two are the same.
     */
    memo?: string;
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
  /**
   * A JSON-lines file: the agent's memory and the public record of its decisions. Next to it,
   * under the same name with ".pending" added, an edict's line waits from before its
   * transaction is sent until it is in this file (see `mendLog`).
   */
  logPath: string;
  decide: Decide;
  solPriceUsd?: () => Promise<number>;
  /** Decide and report, but send nothing and record nothing. */
  dryRun?: boolean;
};

export type Outcome =
  | { status: "paused" }
  /** The chain's own interval is still closed, or an edict already sent may still land. */
  | { status: "too-soon"; seconds: number }
  | { status: "in-force"; seconds: number }
  /** An edict is due, and the caller asked for the model to be left alone for now (`ask: false`). */
  | { status: "resting" }
  | { status: "held"; reasoning: string; usage?: Usage }
  /** `memo` is what the transaction carries as its memo, when that is not the announcement whole. */
  | { status: "rewritten"; choice: Choice; change: Change; announcement: string; reasoning: string; signature: string | null; memo?: string; usage?: Usage };

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
    ...fees.split(limits.maxTreasuryBps, limits.minTreasuryBps),
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
  if (change.treasuryBps < limits.minTreasuryBps) return `the treasury has to get at least ${limits.minTreasuryBps / 100}% of the fees`;
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

/**
 * The catalogue as the model reads it, for a token that does or does not name an app, and
 * that has or has not another name to change to.
 */
function catalogue(appAvailable: boolean, renamable: boolean): string {
  const buying = buyingHooksFor(appAvailable).map((hook) => {
    const settings = hook.settings.length > 1 ? `Settings: ${hook.settings.map((setting, i) => `${i + 1}) ${setting.label}`).join("  ")}` : "One setting.";
    return `- ${hook.id}: ${worded(hook.name)}. ${worded(hook.about)} ${settings}`;
  });
  const fees = FEE_HOOKS.map((hook) => `- ${hook.id}: ${hook.name}. ${hook.about}`);
  const identity = `\n\n${IDENTITY_HOOK.name}\n${IDENTITY_HOOK.about} The message lists the names, says which is in use and whether a change is allowed right now; the program allows one only every so often. A new name is an occasion, not a habit: most edicts keep the name.`;
  return `Buying hooks\n${buying.join("\n")}\n\nFee hooks\n${fees.join("\n")}${renamable ? identity : ""}`;
}

const MECHANICS = (appAvailable: boolean, renamable: boolean) => `You are in charge of a token on Solana. It trades on one bonding curve, and a program attached to the token checks every buy. You change what the token does by issuing edicts, and you are the only one who can. Nobody approves an edict before it goes out.

You do not invent rules. Every hook you can use was written before launch and is listed below. What you decide is which hooks are on, at which setting, and for how long.

One edict sets ${renamable ? "three" : "two"} things at once:
1. The buying hook: one of the buying hooks below, or "none". Only buying is ever restricted. Selling, and moving tokens between wallets, are never restricted by you or by anyone, so do not describe a hook as locking people in.
2. The fee hook: where the project's part of the trading fees goes. One is always on. The treasury's share is held between a least and a most, both fixed at launch and given in the message. The message also shows what each hook would come to in numbers right now.
${renamable ? "3. The token's name: keep it, or change it to another of the names in the message." : "The token has one name, written at launch, and it cannot change: always answer 0 for the name."}

An edict stands for the number of minutes you give it, between the shortest and the longest the message allows. When that time is up its buying hook stops applying by itself, and you are called to write the next edict.

${catalogue(appAvailable, renamable)}

How to choose. The choice is yours, and there is no right answer to find. Look at the market in the message and at your own earlier edicts, and pick what you judge fits the moment: something tighter when buying is frantic, something looser or nothing at all when it is quiet, and another fee hook when the last one has had its turn. Do not settle into a pattern. Unless you have a reason you can state, do not switch on a buying hook you used in either of your last two edicts.

Everything you write is public. The announcement is what holders read: name the hooks that are now on, say in plain words what they mean for a buyer and how long the edict stands, and say nothing about where the price will go. The page next to it shows the same edict as the chain stores it, so the two must agree.

The announcement also goes on chain: it is written into the edict's own transaction as a memo, where it stays for good and anybody who opens the transaction reads it. It can be at most ${ANNOUNCEMENT_MAX} characters, and a longer one is cut at a word. Write it in plain letters, digits and everyday punctuation, with straight quotes and a hyphen for a dash. The chain charges for a memo by the character, and every other sign is dear there: an accented letter costs what five plain letters do, a curly quote or a long dash thirty, an emoji more than fifty. An announcement of full length can afford about twenty curly quotes and dashes, or a dozen emoji; past that, the copy on chain is cut short at a word.`;

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
          system: `${options.persona.trim()}\n\n${MECHANICS(hasApp(book), book.names.length > 1)}`,
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
      if (!problem) return { action: "rewrite", choice, announcement: announced(decision.announcement), reasoning: decision.reasoning, model: response.model, usage };
      messages.push({ role: "assistant", content: response.content }, { role: "user", content: `That cannot be used: ${problem}. Choose again.` });
    }
    return hold("two answers in a row could not be used; nothing changes");
  };
}

/**
 * The lines of a log. With `mint`, only that token's: a file that was first used for another
 * token, a rehearsal on devnet say, still holds that one's edicts, and they are not this
 * token's past.
 */
export function readLog(path: string, mint?: string): LogEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      const entry = JSON.parse(line) as LogEntry;
      return mint === undefined || entry.record?.mint === mint ? [entry] : [];
    } catch {
      // A line a crash cut short. If it was an edict's, `mendLog` has written it again, whole.
      return [];
    }
  });
}

/** The sha256 the rulebook stores next to a change, so anyone can match it to the published text. */
export const noteOf = (record: LogEntry["record"]) => createHash("sha256").update(JSON.stringify(record)).digest();

const logged = (change: Change): LoggedChange => ({ ...change, rule: change.rule.map((c) => ({ ...c, value: c.value.toString() })) });

// ---------------------------------------------------------------------------------------------
// Never losing an edict's words.
//
// The rulebook keeps only the hash of an edict's text. The text lives in the log, and nowhere
// else. If it were written there only once the transaction is confirmed, a process that dies
// in between, or a confirmation that times out on a transaction that lands anyway, would
// leave the chain holding the hash of words nobody has. So an edict's whole log line, with the
// signature of its transaction, goes to a file of its own before the transaction is sent, and
// stays there until the line is in the log. Whenever the rulebook shows an edict the log does
// not have, the line is taken from that file, if its hash is the one on chain.

/** An edict's log line as it waits, and the last block height its transaction can land at. */
type Waiting = { line: LogEntry & { note: string; signature: string }; lastValidBlockHeight: number };

/** Where an edict's line waits from before its transaction is sent until it is in the log. */
export const waitingPath = (logPath: string) => `${logPath}.pending`;

/** Blocks past a transaction's last valid height before it is taken for one that can no longer land. */
const EXPIRY_MARGIN = 30;

/** A transaction that is in a block as a failure. */
class Refused extends Error {}

/**
 * The key this process holds is not the one the rulebook names as the agent: the guardian has
 * put another in, or the settings point at the wrong token. Trying again changes nothing; a
 * person has to.
 */
export class NotTheAgent extends Error {}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A transaction's signature as explorers and RPC nodes write it. */
function base58(bytes: Uint8Array): string {
  let number = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let text = "";
  for (; number > 0n; number /= 58n) text = ALPHABET[Number(number % 58n)] + text;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) text = `1${text}`;
  return text;
}

/** One whole line at the end of the log, on the disk before this returns. */
function appendLine(path: string, entry: LogEntry) {
  const file = openSync(path, "a+");
  try {
    const { size } = fstatSync(file);
    const last = Buffer.alloc(1);
    // A line a crash cut short is closed off, so that this one starts on a line of its own.
    const torn = size > 0 && readSync(file, last, 0, 1, size - 1) === 1 && last[0] !== 10;
    writeSync(file, `${torn ? "\n" : ""}${JSON.stringify(entry)}\n`);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}

function readWaiting(logPath: string): Waiting | null {
  try {
    return JSON.parse(readFileSync(waitingPath(logPath), "utf8")) as Waiting;
  } catch {
    // Nothing waits. The file is put in place whole, so it is never found half written.
    return null;
  }
}

/** Puts the line where it waits, on the disk before this returns. A reader finds the earlier one or this one, never half of either. */
function writeWaiting(logPath: string, waiting: Waiting) {
  const path = waitingPath(logPath);
  const file = openSync(`${path}.tmp`, "w");
  try {
    writeSync(file, JSON.stringify(waiting));
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(`${path}.tmp`, path);
}

/**
 * What a check of the log against the rulebook found. "whole": the log has the text of the
 * edict in force, or no edict was ever issued. "restored": it had not, the line written before
 * the transaction was sent is the one the chain's hash names, and it is in the log now.
 * "missing": the chain holds an edict whose text is in neither place. It was not written from
 * these files: another copy of the agent is running, the key is in other hands, or the disk
 * was put back from an older copy.
 */
export type LogCheck = "whole" | "restored" | "missing";

/**
 * Makes sure the log has the text of the edict the rulebook holds, taking it from the line
 * that was written before its transaction went out if that is what it takes. It asks the
 * network nothing: `book` is a rulebook the caller has just read. `runOnce` and `watch` call
 * it by themselves; a service calls it too, to learn of an edict that is "missing".
 */
export function mendLog(ctx: Pick<Context, "logPath">, book: Rulebook): LogCheck {
  if (book.epoch === 0n) return "whole";
  const note = book.note.toString("hex");
  const inLog = () => readLog(ctx.logPath).some((entry) => entry.note === note);
  const waiting = readWaiting(ctx.logPath);
  // The hash is worked out again from the record itself: what goes into the log is what the chain vouches for.
  if (waiting && noteOf(waiting.line.record).equals(book.note)) {
    // It may be there already: a process can die after writing the log and before clearing this file.
    const there = inLog();
    if (!there) appendLine(ctx.logPath, { ...waiting.line, note });
    rmSync(waitingPath(ctx.logPath), { force: true });
    return there ? "whole" : "restored";
  }
  return inLog() ? "whole" : "missing";
}

/**
 * Deals with a line that is still waiting when a look starts. If its edict is on chain, the
 * line goes into the log. If its transaction can still land, nothing new is decided yet:
 * `wait` is roughly how many seconds until it no longer can. Otherwise it never landed and
 * never will, and the line is dropped. Returns the rulebook as last read.
 */
async function settleWaiting(ctx: Context, book: Rulebook): Promise<{ book: Rulebook; wait?: number }> {
  mendLog(ctx, book);
  const waiting = readWaiting(ctx.logPath);
  if (!waiting) return { book };
  // A line left by another token that once used these files. Its block heights are another
  // network's, and nothing here should wait on them.
  if (waiting.line.record?.mint !== ctx.mint.toBase58()) {
    rmSync(waitingPath(ctx.logPath), { force: true });
    return { book };
  }
  const left =waiting.lastValidBlockHeight + EXPIRY_MARGIN - (await ctx.connection.getBlockHeight("confirmed"));
  // A block takes about 0.4 seconds.
  if (left >= 0) return { book, wait: Math.max(1, Math.ceil((left + 1) * 0.4)) };
  // It no longer can. The rulebook as it is from here on says whether it did at the last moment.
  const last = await readBook(ctx);
  mendLog(ctx, last);
  rmSync(waitingPath(ctx.logPath), { force: true });
  return { book: last };
}

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
      fees: recogniseSplit(book, book.limits.maxTreasuryBps, book.limits.minTreasuryBps)?.hook.name ?? "shares outside the catalogue",
      fee_shares: sharesInWords(book),
      name: nameInWords(book.names[book.name]),
    },
    fee_hooks: FEE_HOOKS.map((hook) => ({ id: hook.id, shares: sharesInWords(hook.split(book.limits.maxTreasuryBps, book.limits.minTreasuryBps)) })),
    names: book.names.map((name, i) => ({ number: i + 1, name: name.name, ticker: name.symbol, current: i === book.name })),
    name_change: { allowed_now: book.names.length > 1 && renameIn === 0, allowed_in_minutes: Math.ceil(renameIn / 60), at_most_once_every_hours: round(book.limits.minRenameSecs / 3_600, 1) },
    limits: {
      shortest_edict_minutes: Math.max(5, Math.ceil(book.limits.minIntervalSecs / 60)),
      longest_edict_minutes: Math.floor(book.limits.maxRuleSecs / 60),
      treasury_least_pct: book.limits.minTreasuryBps / 100,
      treasury_most_pct: book.limits.maxTreasuryBps / 100,
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

// ---------------------------------------------------------------------------------------------
// An edict's words, on chain.
//
// The announcement goes into the edict's own transaction as a memo that the agent signs, so
// that anybody who opens the transaction in an explorer reads what was said. The words and
// the rule land together or not at all, and that cuts both ways: a memo the chain would not
// take would take the edict down with it. Two things can make a memo too much. A transaction
// is at most 1232 bytes. And the Memo program is paid for by the character: to write its text
// into the log it looks every character up in Unicode's tables, which costs it some 350
// compute units for a plain letter and between nine and twenty thousand for a sign from
// further up, a curly quote, a long dash or an emoji. So the memo is measured against both
// before anything is signed, and one that would not fit is cut at a word. The note still
// commits to the whole announcement, and the record says what the memo was.
//
// The agent only ever writes a memo. It reads nobody's, its own included: what it knows of
// its earlier words comes from its log.

/** The SPL Memo program. It takes text as its data, and fails unless every account it is given has signed. */
export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** The most a transaction may be on the wire, signatures included, in bytes. */
export const TRANSACTION_MAX = 1232;

/**
 * The most compute units a memo may be reckoned to cost. A transaction that asks for nothing
 * else is given 200,000 units for each of its instructions to a program like the hook or the
 * Memo program. An edict has two of those, and three with a change of name; the hook spends
 * under a thousand units on the rule and some thirteen thousand on a name, so this leaves it
 * many times what it needs.
 */
export const MEMO_UNITS = 350_000;

/**
 * At most what the Memo program spends on `text` signed by one key, in compute units: a
 * ceiling for each character by where it sits in Unicode. The ceilings come from running
 * every character below U+20000, and a sample of those above, through the program's own
 * bytecode, which is the same on mainnet and cannot be changed there. Most characters cost
 * less than their ceiling, so a memo comes in under this; scripts/e2e-agent.ts runs the
 * dearest of each band through the program again.
 */
export function memoUnits(text: string): number {
  // An empty memo: nearly all of it goes on the line of the log that says who signed.
  let units = 16_000;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    units +=
      code >= 0x20 && code < 0x7f ? 360 // plain letters, digits and punctuation
      : code < 0x800 || code >= 0x20000 ? 1_800 // accented letters, Greek, Cyrillic, Hebrew and Arabic; and, far up, the rarer Chinese characters
      : code < 0x3000 ? 11_500 // curly quotes, long dashes, arrows and symbols
      : code < 0x10000 ? 16_000 // Chinese, Japanese and Korean
      : 20_500; // emoji
  }
  return units;
}

/**
 * `text` if it `fits`; otherwise as much of it as does, ended after a whole word and closed
 * with an ellipsis. A first word that is too much by itself is cut where it has to be, and
 * where not even one character fits the answer is empty.
 */
function shortened(text: string, fits: (text: string) => boolean): string {
  if (fits(text)) return text;
  const [words, characters]: number[][] = [[], []];
  let end = 0;
  // Character by character and not by UTF-16 unit, so that no surrogate pair is cut in two.
  for (const character of text) {
    end += character.length;
    characters.push(end);
    if (/\S/u.test(character) && /\s/u.test(text[end] ?? "")) words.push(end);
  }
  for (const at of [...words.reverse(), ...characters.reverse()]) {
    // The ellipsis takes the place of whatever closed the last word.
    const kept = text.slice(0, at).replace(/[\s.,;:…–—-]+$/u, "");
    if (kept && fits(`${kept}…`)) return `${kept}…`;
  }
  return "";
}

/**
 * An announcement as it goes into the record: within its limit, cut at a word if it ran over,
 * and holding nothing UTF-8 cannot carry (half of a surrogate pair becomes the replacement
 * character), so that the memo is the record's own words byte for byte.
 */
export const announced = (text: string) => shortened(Buffer.from(text, "utf8").toString("utf8"), (cut) => cut.length <= ANNOUNCEMENT_MAX);

/** `text` as a memo that `signer` signs. Its data is the text and nothing else. */
export function memoIx(signer: PublicKey, text: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(text, "utf8"),
  });
}

/**
 * The transaction that writes an edict, not yet signed, and the record its note is the hash
 * of. It holds the rule, then the change of name if there is one, then the announcement as a
 * memo. `record.memo` is filled in here, when the memo is not the announcement whole.
 */
export function edictTransaction(p: {
  program: PublicKey;
  agent: PublicKey;
  mint: PublicKey;
  change: Change;
  /** The name to take, counted from 0, and the lamports the mint is short of to carry it. */
  rename?: { index: number; lamports: number };
  record: LogEntry["record"];
}): { tx: Transaction; record: LogEntry["record"]; note: Buffer } {
  const edict = (note?: Buffer) => [
    setRulesIx({ program: p.program, agent: p.agent, mint: p.mint, change: p.change, note }),
    // A name changes in the same transaction as its edict, right after it. The mint was given
    // room for its longest name at launch; the transfer covers a mint that was not.
    ...(p.rename && p.rename.lamports > 0 ? [SystemProgram.transfer({ fromPubkey: p.agent, toPubkey: p.mint, lamports: p.rename.lamports })] : []),
    ...(p.rename ? [setNameIx({ program: p.program, agent: p.agent, mint: p.mint, index: p.rename.index })] : []),
  ];
  const paidByAgent = (instructions: TransactionInstruction[]) => {
    const tx = new Transaction().add(...instructions);
    tx.feePayer = p.agent;
    return tx;
  };
  // The bytes left for the memo's text: the most a transaction may be, less what this one
  // comes to with an empty memo in it. The note and the blockhash weigh the same whatever they are.
  const empty = paidByAgent([...edict(), memoIx(p.agent, "")]);
  empty.recentBlockhash = PublicKey.default.toBase58();
  const room = TRANSACTION_MAX - empty.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  const said = p.record.announcement ?? "";
  const memo = shortened(said, (text) => {
    const bytes = Buffer.byteLength(text);
    // A text of 128 bytes or more takes a second byte to say how long it is.
    return bytes + (bytes < 128 ? 0 : 1) <= room && memoUnits(text) <= MEMO_UNITS;
  });
  const record = memo === said ? p.record : { ...p.record, memo };
  const note = noteOf(record);
  return { tx: paidByAgent([...edict(note), ...(memo ? [memoIx(p.agent, memo)] : [])]), record, note };
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
 * stands for as long as it said; without it, the look replaces whatever is in force. With
 * `ask: false` everything short of the model is done, the reading of the rulebook and the
 * settling of an edict still on its way, and where the model would be asked the answer is
 * "resting": that is how `watch` keeps its eyes on the chain while it spaces out its looks.
 */
export async function runOnce(ctx: Context, options: { letRuleRun?: boolean; ask?: boolean } = {}): Promise<Outcome> {
  // The cheap checks come first: this runs on every poll, and most polls end in one of them.
  let book = await readBook(ctx);
  if (!book.agent.equals(ctx.agent.publicKey)) throw new NotTheAgent(`${ctx.agent.publicKey.toBase58()} is not this token's agent (${book.agent.toBase58()} is)`);
  // An edict that was sent and not seen to land comes before anything else: its text goes into
  // the log if it did land, and nothing new is decided while it still can.
  if (!ctx.dryRun && existsSync(waitingPath(ctx.logPath))) {
    const settled = await settleWaiting(ctx, book);
    if (settled.wait) return { status: "too-soon", seconds: settled.wait };
    book = settled.book;
  }
  if (book.paused) return { status: "paused" };
  const now = await chainTime(ctx.connection);
  const left = book.ruleUntil - now;
  if (options.letRuleRun && left > 0) return { status: "in-force", seconds: left };
  const wait = book.updatedAt === 0 ? 0 : book.updatedAt + book.limits.minIntervalSecs - now;
  if (wait > 0) return { status: "too-soon", seconds: wait };
  if (options.ask === false) return { status: "resting" };

  // Its memory is its own token's lines, and no other's.
  const snapshot = await takeSnapshot(ctx, book, now, readLog(ctx.logPath, ctx.mint.toBase58()));
  const verdict = await ctx.decide(snapshot, book);
  const base = { mint: ctx.mint.toBase58(), at: snapshot.now, reasoning: verdict.reasoning, model: verdict.model };
  const entry = { marketCapSol: snapshot.market.market_cap_sol, ...(verdict.usage ? { usage: verdict.usage } : {}) };
  if (verdict.action === "hold") {
    // A dry run leaves no trace: the log is the public record, and it only holds what really happened.
    const record: LogEntry["record"] = { ...base, epoch: Number(book.epoch), action: "hold" };
    if (!ctx.dryRun) appendLine(ctx.logPath, { record, ...entry });
    return { status: "held", reasoning: verdict.reasoning, usage: verdict.usage };
  }

  // Checked again here so a decision that did not come from `askClaude` gets the same treatment.
  const { choice } = verdict;
  const problem = unfit(choice, book, { now, curveSolThousandths: Math.round(snapshot.market.sol_in_curve * 1000) });
  if (problem) throw new Error(`the decision cannot be used: ${problem}`);
  const change = changeOf(choice, book.limits);
  const { minutes: _minutes, ...hooks } = choice;
  // The same goes for what it says: the record, the page and the memo all hold these words.
  const announcement = announced(verdict.announcement);
  const decided = { choice, change, announcement, reasoning: verdict.reasoning, usage: verdict.usage };
  if (ctx.dryRun) return { status: "rewritten", ...decided, signature: null };

  const { tx, record, note } = edictTransaction({
    program: ctx.hookProgram,
    agent: ctx.agent.publicKey,
    mint: ctx.mint,
    change,
    rename: choice.name === null ? undefined : { index: choice.name, lamports: await rentForName(ctx, book, choice.name) },
    record: {
      mint: base.mint,
      epoch: Number(book.epoch) + 1,
      at: base.at,
      action: "rewrite",
      hooks,
      change: logged(change),
      announcement,
      reasoning: base.reasoning,
      model: base.model,
    },
  });
  // Signed here, so that the signature is known before anything is sent.
  const recent = await ctx.connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = recent.blockhash;
  tx.lastValidBlockHeight = recent.lastValidBlockHeight;
  tx.sign(ctx.agent);
  const signature = base58(tx.signature!);
  const line = { record, ...entry, note: note.toString("hex"), signature } satisfies LogEntry;

  // The line is on disk before the transaction leaves. From here on, whatever becomes of this
  // process, the words of an edict that reaches the chain can be put into the log.
  writeWaiting(ctx.logPath, { line, lastValidBlockHeight: recent.lastValidBlockHeight });
  try {
    await ctx.connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    const { value } = await ctx.connection.confirmTransaction({ signature, ...recent }, "confirmed");
    if (value.err) throw new Refused(`the edict's transaction ${signature} failed on chain: ${JSON.stringify(value.err)}`);
  } catch (error) {
    // The node turned it away before sending it on, or a block has it as a failure: it changed
    // nothing and never will, so nothing waits for it.
    if (error instanceof SendTransactionError || error instanceof Refused) {
      rmSync(waitingPath(ctx.logPath), { force: true });
      throw error;
    }
    // Anything else says nothing either way: a confirmation that times out, or a connection
    // that drops, on a transaction that lands all the same. The rulebook knows. If it cannot
    // be read now, the line stays where it waits and the next call settles it.
    const now = await readBook(ctx).catch(() => null);
    if (!now?.note.equals(note)) throw error;
  }
  appendLine(ctx.logPath, line);
  rmSync(waitingPath(ctx.logPath), { force: true });
  return { status: "rewritten", ...decided, signature, ...(record.memo === undefined ? {} : { memo: record.memo }) };
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
  /** How often it reads the rulebook to see whether it is time to write again, in seconds. */
  pollSecs: number;
  /** How long it leaves the model alone after a look that issued nothing, in seconds. */
  thinkEverySecs: number;
  /** How long the model is left alone at the start, in seconds: what was left of such a wait when the process last stopped. */
  firstLookInSecs?: number;
  signal?: AbortSignal;
  report?: (event: Outcome | { status: "error"; error: unknown }) => void;
};

/**
 * The agent on its own, for as long as the process lives: it issues an edict, lets it stand
 * for the time it gave it, and issues the next one when that time is up. Nobody approves
 * anything; the only brakes are the limits in the rulebook and the guardian's pause.
 *
 * The rulebook is read at every poll, which costs up to three calls to the node and nothing
 * else. So a pause, its end, a key that is no longer the agent's and an edict that landed
 * unseen are all noticed within one poll. Only the model, which is paid for by the call, is
 * spaced out.
 */
export async function watch(ctx: Context, options: WatchOptions): Promise<void> {
  const clock = () => Date.now() / 1000;
  /** The model is not asked before this moment. */
  let restUntil = clock() + (options.firstLookInSecs ?? 0);
  /** Whether the look in hand got as far as the model: from there on it has been paid for. */
  let asked = false;
  const looking: Context = { ...ctx, decide: (snapshot, book) => (asked = true, ctx.decide(snapshot, book)) };
  while (!options.signal?.aborted) {
    asked = false;
    try {
      const outcome = await runOnce(looking, { letRuleRun: true, ask: clock() >= restUntil });
      options.report?.(outcome);
      // An edict just issued holds the next look back by itself, for its own term. A look that
      // issued nothing has no such thing, so the model is left alone for a while.
      if (outcome.status === "held") restUntil = clock() + options.thinkEverySecs;
      // Nor has a dry run, which sends nothing: the edict it would have issued is given its
      // term here, so that a rehearsal asks the model as often as the real thing would, and
      // not at every poll.
      if (outcome.status === "rewritten" && outcome.signature === null) restUntil = clock() + Math.max(options.thinkEverySecs, outcome.change.ruleSecs);
    } catch (error) {
      // An RPC hiccup or a failed transaction must not stop the agent.
      options.report?.({ status: "error", error });
      // What failed before the model was asked cost nothing, and is tried again at the next
      // poll. What failed after it is not paid for again so soon.
      if (asked) restUntil = clock() + options.thinkEverySecs;
    }
    // Asked to stop in the middle of a look: the look has been finished, and there is nothing to wait for.
    if (options.signal?.aborted) break;
    await new Promise<void>((resolve) => {
      // The listener goes when the wait is over: one left behind at every poll would add up over months.
      const done = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, options.pollSecs * 1000);
      options.signal?.addEventListener("abort", done, { once: true });
    });
  }
}
