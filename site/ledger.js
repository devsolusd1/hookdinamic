// Reading what the keeper has done with the fees: ledger-head.json, the one file of its
// public ledger this page fetches. The keeper replaces it whole after every line it writes.
// It holds the running totals and the last lines. Amounts are lamports, and tokens in their
// smallest unit, written as text so that nothing rounds them on the way; they stay text here
// and are only turned into figures at the moment they are shown.

import { isAddress, isSignature } from "./chain.js";

/** Fixed at launch (src/curve.ts): the token's decimals. SOL has nine. */
const TOKEN_DECIMALS = 6n;
const LAMPORTS_PER_SOL = 1_000_000_000n;

const isAmount = (text) => typeof text === "string" && /^\d{1,24}$/.test(text);
const isCount = (number) => Number.isSafeInteger(number) && number >= 0;

const isTotals = (totals) =>
  isAmount(totals?.claimed) &&
  [totals.treasury?.paid, totals.treasury?.owed, totals.burn?.spent, totals.burn?.tokens, totals.burn?.owed, totals.holders?.paid, totals.holders?.owed].every(isAmount);

/** What each kind of line must carry for this page to say it. A line of a kind it does not know is left out. */
const KINDS = {
  claim: (line) => isSignature(line.signature) && isAmount(line.lamports),
  treasury: (line) => isSignature(line.signature) && isAmount(line.lamports),
  buyback: (line) => isSignature(line.signature) && isAmount(line.lamports) && isAmount(line.tokens),
  credit: (line) => isAmount(line.lamports) && isCount(line.holders),
  payout: (line) => isAmount(line.lamports) && isCount(line.payments) && Array.isArray(line.transactions) && line.transactions.every((sent) => isSignature(sent?.signature)),
  lapse: (line) => isAmount(line.lamports) && isCount(line.owners),
  note: (line) => typeof line.text === "string" && line.text.trim() !== "",
};

const isLine = (line) =>
  typeof line === "object" &&
  line !== null &&
  isCount(line.seq) &&
  typeof line.at === "string" &&
  // A date the page could not print would stop the whole list.
  Number.isFinite(Date.parse(line.at)) &&
  Object.hasOwn(KINDS, line.kind) &&
  KINDS[line.kind](line);

const isHead = (head) => head?.v === 1 && isAddress(head.mint) && isCount(head.seq) && isTotals(head.totals) && Array.isArray(head.recent);

/**
 * The keeper's head file: `{ mint, seq, totals, recent }`, with `recent` oldest first and only
 * the lines this page can read. False if nothing is published, which is a keeper that has
 * not run yet: no file, or an empty one. Null if the file could not be fetched or read.
 */
export async function readLedger(url) {
  let text;
  try {
    // Kept, but asked about every time: an unchanged file costs a few hundred bytes.
    const response = await fetch(url, { cache: "no-cache", signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) return false;
    if (!response.ok) return null;
    text = await response.text();
  } catch {
    return null;
  }
  if (!text.trim()) return false;
  try {
    const head = JSON.parse(text);
    if (!isHead(head)) return null;
    return { mint: head.mint, seq: head.seq, totals: head.totals, recent: head.recent.filter(isLine) };
  } catch {
    return null;
  }
}

/** A whole number with commas at the thousands. */
const grouped = (whole) => whole.toString().replace(/\B(?=(\d{3})+$)/g, ",");

/**
 * Lamports as SOL: four decimals, or the first two figures of a sum under a thousandth of a
 * SOL, so that something owed never reads as nothing. Worked in whole numbers.
 */
export function inSol(lamports) {
  const sum = BigInt(lamports);
  // The place it is rounded at: the fourth decimal, or the second figure of something smaller.
  let place = 100_000n;
  while (place > 1n && sum < place * 10n) place /= 10n;
  const rounded = ((sum + place / 2n) / place) * place;
  const decimals = (rounded % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return `${grouped(rounded / LAMPORTS_PER_SOL)}${decimals ? `.${decimals}` : ""}`;
}

/** Tokens in their smallest unit as whole tokens. A part of a token is not counted. */
export const inTokens = (units) => grouped(BigInt(units) / 10n ** TOKEN_DECIMALS);

/** "87 holders", "1 holder". The count may be too large for an ordinary number. */
const counted = (count, word) => `${grouped(count)} ${word}${Number(count) === 1 ? "" : "s"}`;

/** Which edicts a claim was shared by: "by edict No. 41", "by edicts No. 41 and No. 42", "by edicts No. 36 to No. 42". */
function byEdicts(shares) {
  if (!Array.isArray(shares) || !shares.every((share) => isCount(share?.epoch))) return "";
  const epochs = [...new Set(shares.map((share) => share.epoch))].sort((a, b) => a - b);
  // Before my first edict the fees follow the split written at launch.
  const numbered = epochs.filter((epoch) => epoch > 0);
  const edicts =
    numbered.length === 0
      ? ""
      : numbered.length === 1
        ? `edict No. ${numbered[0]}`
        : `edicts No. ${numbered[0]} ${numbered.length === 2 ? "and" : "to"} No. ${numbered.at(-1)}`;
  const named = [epochs[0] === 0 ? "the opening split" : "", edicts].filter(Boolean);
  return named.length ? `by ${named.join(" and ")}` : "";
}

/**
 * One line of the ledger as the page says it.
 *   kind    a word for what happened
 *   share   which share it concerns, "holders", "burn" or "treasury", if it is one of them
 *   what    a short sentence
 *   more    a second, smaller one, or ""
 *   proofs  [words, signature] for each transaction that can be opened on an explorer
 *   rest    what to say after the proofs when the head does not list them all, or ""
 * @param {{ kind: string }} line a line `readLedger` returned
 * @param {string} [treasury] the treasury's address as the page names it, if it names one
 */
export function told(line, treasury) {
  const sol = (lamports) => `${inSol(lamports)} SOL`;
  const said = { share: "", more: "", proofs: [], rest: "" };
  switch (line.kind) {
    case "claim": {
      const shared = [line.holders, line.burn, line.treasury].every(isAmount) ? [`holders ${inSol(line.holders)}`, `burn ${inSol(line.burn)}`, `treasury ${inSol(line.treasury)}`] : [];
      return { ...said, kind: "Claimed", what: `${sol(line.lamports)} of fees out of the pool`, more: [...shared, byEdicts(line.shares)].filter(Boolean).join(" · "), proofs: [["transaction", line.signature]] };
    }
    case "treasury": {
      // The ledger says where each payment went, and the page names one address as the
      // treasury's. A payment that went anywhere else is not passed off as one to that address.
      const elsewhere = isAddress(treasury) && isAddress(line.to) && line.to !== treasury;
      return {
        ...said,
        kind: "Treasury",
        share: "treasury",
        what: elsewhere ? `${sol(line.lamports)} sent as the treasury’s share` : `${sol(line.lamports)} to the treasury`,
        more: elsewhere ? `to ${line.to.slice(0, 4)}…${line.to.slice(-4)}, which is not the treasury address this page lists` : "",
        proofs: [["transaction", line.signature]],
      };
    }
    case "buyback": {
      // Bought and burned in one transaction, or in two.
      const burn = isSignature(line.burnSignature) && line.burnSignature !== line.signature ? line.burnSignature : null;
      // What was burned is what the SOL bought and, now and then, tokens somebody had sent my
      // keeper, which it burns with them. Only the first were bought back.
      const all = BigInt(line.tokens);
      const found = isAmount(line.found) && BigInt(line.found) <= all ? BigInt(line.found) : 0n;
      const whole = (units) => counted(units / 10n ** TOKEN_DECIMALS, "token");
      return {
        ...said,
        kind: "Burned",
        share: "burn",
        what: `${whole(all - found)}, bought back for ${sol(line.lamports)}`,
        more: found ? `and ${found < 10n ** TOKEN_DECIMALS ? "less than one token" : whole(found)} that somebody had sent my keeper` : "",
        proofs: burn ? [["the buy", line.signature], ["the burn", burn]] : [["transaction", line.signature]],
      };
    }
    case "credit":
      return { ...said, kind: "Shared", share: "holders", what: `${sol(line.lamports)} ${line.holders === 1 ? "to" : "among"} ${counted(line.holders, "holder")}`, more: "counted to their names, not sent yet" };
    case "payout": {
      const sent = line.transactions;
      const listed = sent.every((each) => isCount(each.payments)) ? sent.reduce((sum, each) => sum + each.payments, 0) : line.payments;
      const putOff = isCount(line.putOff?.payments) ? line.putOff.payments : 0;
      return {
        ...said,
        kind: "Paid",
        share: "holders",
        what: `${sol(line.lamports)} to ${counted(line.payments, "holder")}`,
        more: putOff ? `${counted(putOff, "payment")} put off to the next round` : "",
        proofs: sent.map((each, i) => [sent.length === 1 ? "transaction" : `transaction ${i + 1}`, each.signature]),
        // The head keeps the first few transactions of a round. The ledger itself has them all.
        rest: listed < line.payments ? "more in the ledger" : "",
      };
    }
    case "lapse":
      // Two things end here, and the line does not say which: a sum too small to send, owed to
      // a wallet that sold everything, and a sum the chain would not let my keeper send.
      return { ...said, kind: "Returned", share: "holders", what: `${sol(line.lamports)} back to the holders’ share`, more: `owed to ${counted(line.owners, "wallet")} and never sent: too small for a wallet that sold everything, or refused by the chain` };
    default: {
      // A sentence the keeper or a person wrote. It is only ever set as text, and a long one is cut.
      const text = line.text.trim();
      return { ...said, kind: "Note", what: text.length > 280 ? `${text.slice(0, 279).trimEnd()}…` : text };
    }
  }
}
