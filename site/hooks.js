// The catalogue: every hook the agent can switch on. The ideas are all here, written down
// before launch. What the agent decides is which one, at which setting, and for how long.
// The page reads this file in the browser and the agent reads the same file in Node, so the
// hook a visitor is shown is the hook the agent was offered.

import { compile } from "./rules.js";

/**
 * A buying hook: a rule the token's program enforces on every buy while it is on. At most one
 * is on at a time. Each has a few ready-made settings; `clauses` is the rule in the terms of
 * rules.js.
 * @typedef {{ label: string, clauses: import("./rules.js").Clause[], minMinutes?: number }} Setting
 * @typedef {{ id: string, name: string, about: string, needsApp?: boolean, settings: Setting[] }} BuyingHook
 */

const percent = (value) => `${value}%`;

/** A name or a description from the catalogue with the app’s own name in it. */
export const worded = (text, app = "FOMO") => text.replaceAll("{app}", app);

/** @type {BuyingHook[]} */
export const BUYING_HOOKS = [
  {
    id: "app-fast-lane",
    name: "{app} Fast Lane",
    about: "Through the {app} app, any size. From anywhere else, small buys only.",
    needsApp: true,
    settings: [0.1, 0.25, 0.5].map((cap) => ({
      label: `${percent(cap)} elsewhere`,
      clauses: [{ group: 1, fact: "via_app", op: "==", value: 1 }, { group: 2, fact: "size", op: "<=", value: cap }],
    })),
  },
  {
    id: "max-buy",
    name: "Max Buy",
    about: "No single buy above a set share of the supply.",
    settings: [0.25, 0.5, 1, 2].map((cap) => ({ label: percent(cap), clauses: [{ group: 1, fact: "size", op: "<=", value: cap }] })),
  },
  {
    id: "max-wallet",
    name: "Max Wallet",
    about: "No wallet may buy its way above a set share of the supply.",
    settings: [0.5, 1, 2, 3].map((cap) => ({ label: percent(cap), clauses: [{ group: 1, fact: "held_after", op: "<=", value: cap }] })),
  },
  {
    id: "newcomers",
    name: "Newcomers",
    about: "Only wallets that hold none yet can buy, one modest buy each.",
    settings: [0.25, 0.5, 1].map((cap) => ({
      label: `up to ${percent(cap)}`,
      clauses: [{ group: 1, fact: "held_before", op: "==", value: 0 }, { group: 1, fact: "size", op: "<=", value: cap }],
    })),
  },
  {
    id: "regulars",
    name: "Regulars",
    about: "Only wallets that already hold some can buy more.",
    settings: [{ label: "", clauses: [{ group: 1, fact: "held_before", op: ">", value: 0 }] }],
  },
  {
    id: "slow-open",
    name: "Slow Opening",
    about: "A cap on every wallet at first, lifted partway through.",
    settings: [10, 20, 30].map((minutes) => ({
      label: `2% for ${minutes} min`,
      // The edict has to outlast the opening, or the cap would never lift.
      minMinutes: minutes + 5,
      clauses: [{ group: 1, fact: "held_after", op: "<=", value: 2 }, { group: 2, fact: "elapsed", op: ">=", value: minutes * 60 }],
    })),
  },
  {
    id: "turnstile",
    name: "Turnstile",
    about: "Each wallet's turn comes round every forty seconds or so, and only buys made during it go through.",
    settings: [75, 50, 25].map((share) => ({ label: `open ${share}% of the time`, clauses: [{ group: 1, fact: "luck", op: "<", value: share }] })),
  },
  {
    id: "odd-even",
    name: "Odds and Evens",
    about: "Buys go through only in every other minute.",
    settings: [
      { label: "even minutes", clauses: [{ group: 1, fact: "minute", op: "mod", value: 0, modulus: 2 }] },
      { label: "odd minutes", clauses: [{ group: 1, fact: "minute", op: "mod", value: 1, modulus: 2 }] },
    ],
  },
];

/**
 * A fee hook: where the project's part of the trading fees goes while it is on. Exactly one
 * is on at a time. `split` gives the shares in bps for a token whose treasury is capped at
 * `cap`.
 * @typedef {{ holdersBps: number, burnBps: number, treasuryBps: number }} Split
 * @typedef {{ id: string, name: string, about: string, split: (cap: number) => Split }} FeeHook
 */

/** The treasury takes `treasury` (never more than its cap), and `toBurn` of the rest is burned. */
function shares(cap, treasury, toBurn) {
  const treasuryBps = Math.min(cap, treasury);
  const burnBps = Math.round(((10_000 - treasuryBps) * toBurn) / 100) * 100;
  return { holdersBps: 10_000 - treasuryBps - burnBps, burnBps, treasuryBps };
}

/** @type {FeeHook[]} */
export const FEE_HOOKS = [
  {
    id: "even-split",
    name: "Even Split",
    about: "The same share for holders and for burning. A fifth for the treasury.",
    split: (cap) => shares(cap, 2_000, 0.5),
  },
  {
    id: "buyback-burn",
    name: "Buyback & Burn",
    about: "Marks most of the fees for buying the token back from the curve and burning it.",
    split: (cap) => shares(cap, 1_000, 0.7),
  },
  {
    id: "holders-payday",
    name: "Holders’ Payday",
    about: "Marks most of the fees for holders.",
    split: (cap) => shares(cap, 1_000, 0.3),
  },
  {
    id: "project-funding",
    name: "Project Funding",
    about: "The most the treasury is allowed. The rest shared evenly between holders and burning.",
    split: (cap) => shares(cap, 10_000, 0.5),
  },
];

/** The hook that changes what the token is called. The names themselves are in the rulebook. */
export const IDENTITY_HOOK = {
  id: "token-identity",
  name: "Token Identity",
  about: "The token’s name and ticker can change to another of the names written at launch. Its address and every balance stay the same.",
};

/** The buying hooks a token can use: all of them, minus the ones about the app if it names none. */
export const buyingHooksFor = (appAvailable) => BUYING_HOOKS.filter((hook) => appAvailable || !hook.needsApp);

const sameRule = (a, b) => a.length === b.length && a.every((c, i) => c.group === b[i].group && c.fact === b[i].fact && c.op === b[i].op && c.value === b[i].value);

/**
 * The rule a buying hook stands for at one of its settings, as the chain stores it.
 * `setting` counts from 1. Throws if the catalogue has no such hook or setting.
 */
export function ruleOf(id, setting) {
  const hook = BUYING_HOOKS.find((known) => known.id === id);
  if (!hook) throw new Error(`there is no buying hook called "${id}"`);
  const chosen = hook.settings[setting - 1];
  if (!Number.isInteger(setting) || !chosen) throw new Error(`"${id}" has settings 1 to ${hook.settings.length}`);
  return compile(chosen.clauses);
}

/**
 * Which buying hook a rule read from the chain is, if it is one from the catalogue. The page
 * names a hook from this and not from what the agent says it switched on.
 * @param {import("./rules.js").Condition[]} conditions
 * @returns {{ hook: BuyingHook, setting: number, label: string } | null}
 */
export function recogniseRule(conditions) {
  for (const hook of BUYING_HOOKS) {
    const at = hook.settings.findIndex((setting) => sameRule(compile(setting.clauses), conditions));
    if (at >= 0) return { hook, setting: at + 1, label: hook.settings[at].label };
  }
  return null;
}

/**
 * Which fee hook a split read from the chain is, if it is one from the catalogue.
 * @param {Split} split
 * @param {number} cap the treasury's cap in bps
 * @returns {{ hook: FeeHook } | null}
 */
export function recogniseSplit(split, cap) {
  const same = (other) => other.holdersBps === split.holdersBps && other.burnBps === split.burnBps && other.treasuryBps === split.treasuryBps;
  const hook = FEE_HOOKS.find((known) => same(known.split(cap)));
  return hook ? { hook } : null;
}
