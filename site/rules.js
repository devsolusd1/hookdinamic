// The rule language in one place: what a rule can look at, how a rule written with ordinary
// numbers becomes the whole numbers the chain stores, and how to say a stored rule in words.
// The page reads this in the browser and the agent reads the same file in Node, so what the
// agent writes and what a visitor is told cannot drift apart.

/**
 * A condition as the chain stores it.
 * @typedef {{ group: number, fact: number, op: number, value: bigint }} Condition
 */

/**
 * A condition as a person or the agent writes it: groups run from 1, `value` is in the fact's
 * own unit, and "mod" asks that the fact divided by `modulus` leave `value`.
 * @typedef {{ group: number, fact: string, op: string, value: number, modulus?: number }} Clause
 */

/**
 * What a rule can look at in one buy. `scale` turns the unit people use into the whole number
 * the chain compares; the position in the list is the fact's number on chain.
 */
export const FACTS = [
  { name: "size", scale: 10_000, unit: "percent of supply", about: "the size of this buy" },
  { name: "held_before", scale: 10_000, unit: "percent of supply", about: "what the buying wallet held before this buy" },
  { name: "held_after", scale: 10_000, unit: "percent of supply", about: "what the buying wallet holds once the buy has landed" },
  { name: "minute", scale: 1, unit: "0 to 59, UTC", about: "the minute of the hour" },
  { name: "hour", scale: 1, unit: "0 to 23, UTC", about: "the hour of the day" },
  { name: "weekday", scale: 1, unit: "0 for Sunday to 6 for Saturday, UTC", about: "the day of the week" },
  { name: "elapsed", scale: 1, unit: "seconds", about: "the time since this rule was written" },
  { name: "via_app", scale: 1, unit: "1 or 0", about: "whether the buy came through the app" },
  { name: "priority_fee", scale: 1, unit: "micro-lamports per compute unit", about: "the priority fee the buyer's transaction set" },
  { name: "curve_sol", scale: 1_000, unit: "SOL", about: "the SOL sitting in the curve" },
  { name: "luck", scale: 1, unit: "0 to 99; it goes up by one with every slot and starts from a different number for each wallet, so a wallet comes round to every value about every 40 seconds", about: "the wallet's luck" },
];

/** Comparisons, in the order of their numbers on chain. */
export const OPS = ["<", "<=", ">", ">=", "==", "!=", "mod"];

export const MAX_CONDITIONS = 16;
export const MAX_GROUPS = 4;

/**
 * Turns clauses into the conditions the chain stores. Throws on anything the hook could not
 * evaluate, with a sentence that says what is wrong.
 * @param {Clause[]} clauses
 * @returns {Condition[]}
 */
export function compile(clauses) {
  if (clauses.length > MAX_CONDITIONS) throw new Error(`a rule holds at most ${MAX_CONDITIONS} conditions`);
  return clauses.map((clause) => {
    const fact = FACTS.findIndex((known) => known.name === clause.fact);
    const op = OPS.indexOf(clause.op);
    if (fact < 0) throw new Error(`there is no fact called "${clause.fact}"`);
    if (op < 0) throw new Error(`there is no comparison "${clause.op}"`);
    if (!Number.isInteger(clause.group) || clause.group < 1 || clause.group > MAX_GROUPS) throw new Error(`groups run from 1 to ${MAX_GROUPS}`);
    const whole = Math.round(clause.value * FACTS[fact].scale);
    if (!Number.isFinite(whole) || whole < 0) throw new Error(`"${clause.fact}" cannot be compared with ${clause.value}`);
    if (clause.op !== "mod") return { group: clause.group - 1, fact, op, value: BigInt(whole) };
    // A remainder of a share of supply or of an amount of SOL would mean nothing to a reader.
    if (FACTS[fact].scale !== 1) throw new Error(`"mod" is for facts counted in whole numbers, and "${clause.fact}" is not one`);
    const modulus = clause.modulus ?? 0;
    if (!Number.isInteger(modulus) || modulus < 2 || modulus > 0xffff_ffff || whole >= modulus) throw new Error(`"mod" needs a modulus of 2 or more and a remainder below it`);
    return { group: clause.group - 1, fact, op, value: (BigInt(modulus) << 32n) | BigInt(whole) };
  });
}

const WORDS = { "<": "under", "<=": "at most", ">": "over", ">=": "at least", "==": "exactly", "!=": "anything but" };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const plain = (number) => Number(number.toFixed(4)).toLocaleString("en-US", { maximumFractionDigits: 4 });

/** "10 minutes", "1 hour 30 minutes", "45 seconds". */
export function span(seconds) {
  const parts = [];
  for (const [unit, size] of [["day", 86_400], ["hour", 3_600], ["minute", 60], ["second", 1]]) {
    const count = Math.floor(seconds / size);
    if (count) parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
    seconds -= count * size;
    if (parts.length === 2) break;
  }
  return parts.join(" ") || "0 seconds";
}

/**
 * One condition in words.
 * @param {Condition} condition
 * @param {string} app the name of the app the "via_app" fact is about
 */
function say(condition, app) {
  const fact = FACTS[condition.fact];
  const op = OPS[condition.op];
  if (!fact || !op) return "a condition this page cannot read";
  if (op === "mod") {
    if (fact.scale !== 1) return `a condition on ${fact.about} this page cannot put in words`;
    const modulus = Number(condition.value >> 32n);
    const remainder = Number(condition.value & 0xffff_ffffn);
    if (modulus === 2) return `${fact.about} is ${remainder ? "odd" : "even"}`;
    return `${fact.about}, divided by ${modulus}, leaves ${remainder}`;
  }
  const value = Number(condition.value) / fact.scale;
  const how = WORDS[op];
  switch (fact.name) {
    case "size":
      return `the buy is ${how} ${plain(value)}% of supply`;
    case "held_before":
      if (value === 0 && (op === "==" || op === "<=")) return "the wallet holds none yet";
      if (value === 0 && (op === ">" || op === "!=")) return "the wallet already holds some";
      return `the wallet held ${how} ${plain(value)}% of supply before`;
    case "held_after":
      return `the wallet ends up with ${how} ${plain(value)}% of supply`;
    case "minute":
      return `the minute is ${how} ${value}`;
    case "hour":
      return `the hour is ${how} ${value} UTC`;
    case "weekday": {
      const day = (number) => DAYS[number] ?? `day ${number}`;
      if (op === "==") return `it is ${day(value)}`;
      if (op === "!=") return `it is not ${day(value)}`;
      // The week runs from Sunday, 0, to Saturday, 6.
      const first = op === ">" ? value + 1 : op === ">=" ? value : 0;
      const last = Math.min(op === "<" ? value - 1 : op === "<=" ? value : 6, 6);
      if (first > last) return "it is a day the week does not have";
      return first === last ? `it is ${day(first)}` : `it is a day from ${day(first)} to ${day(last)}`;
    }
    case "elapsed":
      return `${how} ${span(value)} have passed since the edict`;
    case "via_app": {
      const through = (op === "==" && value === 1) || (op === "!=" && value === 0) || (op === ">" && value === 0) || (op === ">=" && value === 1);
      return through ? `it comes through the ${app} app` : `it does not come through the ${app} app`;
    }
    case "priority_fee":
      return `its priority fee is ${how} ${value.toLocaleString("en-US")} micro-lamports`;
    case "curve_sol":
      return `the curve holds ${how} ${plain(value)} SOL`;
    case "luck":
      return `the wallet's luck this slot is ${how} ${value} out of 100`;
    default:
      return `${fact.about} is ${how} ${plain(value)}`;
  }
}

/**
 * A stored rule in words: one entry for each group, each a way for a buy to go through.
 * No entries means the rule has no conditions and every buy goes through.
 * @param {Condition[]} conditions
 * @param {string} [app]
 * @returns {string[]}
 */
export function describe(conditions, app = "FOMO") {
  const ways = [];
  for (let group = 0; group < MAX_GROUPS; group++) {
    const members = conditions.filter((condition) => condition.group === group);
    if (members.length) ways.push(members.map((condition) => say(condition, app)).join(", and "));
  }
  return ways;
}

/**
 * What the hook would say to a buy, as far as it can be told from `facts`: the numbers the
 * hook compares, by the names in FACTS, scaled as the chain holds them (BigInt). A fact that
 * is left out is one nobody outside the transaction can know, and a rule that turns on it gets
 * the third answer. It mirrors Condition::holds and admits in programs/hook/src/state.rs; the
 * hook has the last word.
 * @param {Condition[]} conditions
 * @param {Record<string, bigint>} facts
 * @param {string} [app]
 * @returns {{ admits: boolean | null, ways: { admits: boolean | null, clauses: { words: string, holds: boolean | null, fact: string | undefined }[] }[] }}
 */
export function judge(conditions, facts, app = "FOMO") {
  const holds = ({ fact, op, value }) => {
    const seen = facts[FACTS[fact]?.name];
    if (seen === undefined) return null;
    const modulus = value >> 32n;
    const answers = { "<": seen < value, "<=": seen <= value, ">": seen > value, ">=": seen >= value, "==": seen === value, "!=": seen !== value, mod: modulus !== 0n && seen % modulus === (value & 0xffff_ffffn) };
    return answers[OPS[op]] ?? false;
  };
  const ways = [];
  for (let group = 0; group < MAX_GROUPS; group++) {
    const clauses = conditions.filter((condition) => condition.group === group).map((condition) => ({ words: say(condition, app), holds: holds(condition), fact: FACTS[condition.fact]?.name }));
    // One clause that fails closes this way, whatever is unknown beside it.
    if (clauses.length) ways.push({ clauses, admits: clauses.some((clause) => clause.holds === false) ? false : clauses.every((clause) => clause.holds) ? true : null });
  }
  return { admits: ways.length === 0 || ways.some((way) => way.admits) ? true : ways.every((way) => way.admits === false) ? false : null, ways };
}
