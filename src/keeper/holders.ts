// The holders' side of the keeper: who holds the token, what each of them is owed, and paying
// it in SOL.
//
// It is done in two separate moves. A credit lists the holders at one moment and divides the
// holders' pot between them in the books; nothing is sent. A payout round sends each holder
// the whole of what the books owe them, twenty holders to a transaction, once enough is owed
// to be worth sending.
//
// The rule that keeps a holder from being paid twice: a transaction is signed, and its
// signature written to the round's journal and flushed to disk, before it is sent. A payment
// goes into a second transaction only once the first is proven dead: it failed on chain, or
// its blockhash expired, no finalized block holds it, and the wallet still holds what that
// payment would have taken out of it.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { ComputeBudgetProgram, type Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  appendLines, booksHash, bringLedgerUp, dropTornLine, happenedBy, hasBooks, inHand, iso, ledgerPath, plus, publish, readBooks, tidy, writeBooks, writeWhole,
  type Books, type Fault, type LeftOut, type Line, type Listed, type Store,
} from "./books.js";
import { chunks, SYSTEM, type Chain, type TokenAccount } from "./chain.js";
import { networkFee } from "./fees.js";
import { DEFAULTS, plain, type Settings } from "./settings.js";

// ---------------------------------------------------------------------------------------
// Who the holders are
// ---------------------------------------------------------------------------------------

/** The owner of the token vault of every Meteora DBC pool. */
export const POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM";

/** Addresses nobody has the key to. The first is a point on the curve, so it does not look program-derived. */
const NOBODY = new Set(["11111111111111111111111111111111", "1nc1nerator11111111111111111111111111111111"]);

export type Who = {
  mint: PublicKey;
  /** The project's own keys: the keeper, the treasury, and whatever else the settings list. They are never paid as holders. */
  project: string[];
  /** Program-derived owners that can spend SOL after all, a multisig's vault for one. */
  alsoPay?: string[];
  /** What an earlier look found: true for a wallet, false for an account that is something else. Saves asking again. */
  known?: (owner: string) => boolean | undefined;
};

export type Holder = { owner: string; amount: bigint };

export type Snapshot = {
  /** The finalized slot everything was read at. */
  slot: number;
  supply: bigint;
  /** Who gets a share, by address. `amount` adds up all of an owner's token accounts. */
  holders: Holder[];
  /** The sum of their amounts: what a share is a share of. */
  eligible: bigint;
  leftOut: Record<LeftOut, { owners: number; tokens: bigint }>;
  /** Owners whose account was looked up this time: true for a wallet. */
  learned: Record<string, boolean>;
};

const tally = () => ({ owners: 0, tokens: 0n });

/** A snapshot as the books keep it with a claim that is out. */
export const toKeep = (snapshot: Snapshot): Listed => ({
  slot: snapshot.slot,
  supply: snapshot.supply.toString(),
  eligible: snapshot.eligible.toString(),
  holders: snapshot.holders.map((holder) => ({ owner: holder.owner, amount: holder.amount.toString() })),
  leftOut: Object.fromEntries(Object.entries(snapshot.leftOut).map(([why, left]) => [why, { owners: left.owners, tokens: left.tokens.toString() }])) as Listed["leftOut"],
  learned: snapshot.learned,
});

/** And back again. */
export const fromKept = (listed: Listed): Snapshot => ({
  slot: listed.slot,
  supply: BigInt(listed.supply),
  eligible: BigInt(listed.eligible),
  holders: listed.holders.map((holder) => ({ owner: holder.owner, amount: BigInt(holder.amount) })),
  leftOut: Object.fromEntries(Object.entries(listed.leftOut).map(([why, left]) => [why, { owners: left.owners, tokens: BigInt(left.tokens) }])) as Snapshot["leftOut"],
  learned: listed.learned,
});

/**
 * Lists the holders at one finalized slot. The balances listed must add up to the supply read
 * just before and just after, or the list is thrown away and read again: a list cut short by
 * a provider, or stitched from pages read at different moments, does not add up.
 *
 * Left out, in this order: the pool (the unsold tokens are nobody's), the project's own
 * wallets, addresses nobody has the key to, owners a program signs for, and addresses that are
 * on the curve but hold something other than a plain wallet. Those left out are not in the
 * denominator: their share is spread over the holders.
 */
export async function listHolders(chain: Chain, who: Who): Promise<Snapshot> {
  let listed: { slot: number; accounts: TokenAccount[] } | null = null;
  let supply = 0n;
  for (let attempt = 0; !listed; attempt++) {
    const before = await chain.supply(who.mint);
    const now = await chain.tokenAccounts(who.mint, before.slot);
    const after = await chain.supply(who.mint, now.slot);
    const total = now.accounts.reduce((sum, account) => sum + account.amount, 0n);
    if (before.amount === after.amount && total === after.amount) [listed, supply] = [now, after.amount];
    else if (attempt >= 4) throw new Error(`the balances listed add up to ${total}, the supply is ${after.amount}: the list is not whole`);
  }

  const balances = new Map<string, bigint>();
  for (const account of listed.accounts) {
    if (account.amount > 0n) balances.set(account.owner, (balances.get(account.owner) ?? 0n) + account.amount);
  }

  const project = new Set(who.project);
  const alsoPay = new Set(who.alsoPay ?? []);
  const leftOut: Snapshot["leftOut"] = { pool: tally(), project: tally(), nobody: tally(), program: tally(), "not-a-wallet": tally() };
  const leave = (why: LeftOut, amount: bigint) => { leftOut[why].owners += 1; leftOut[why].tokens += amount; };
  const holders: Holder[] = [];
  const toAsk: Holder[] = [];
  for (const [owner, amount] of balances) {
    if (owner === POOL_AUTHORITY) leave("pool", amount);
    else if (project.has(owner)) leave("project", amount);
    else if (NOBODY.has(owner)) leave("nobody", amount);
    // An address off the curve has no private key: a program signs for it. A pool, a vault, a locker.
    else if (!PublicKey.isOnCurve(new PublicKey(owner).toBytes()) && !alsoPay.has(owner)) leave("program", amount);
    else if (who.known?.(owner) === true) holders.push({ owner, amount });
    else if (who.known?.(owner) === false) leave("not-a-wallet", amount);
    else toAsk.push({ owner, amount });
  }

  // A wallet is an address with nothing at it yet, or an account of the System Program with no data.
  const learned: Snapshot["learned"] = {};
  const accounts = await chain.ownerAccounts(toAsk.map((holder) => holder.owner));
  toAsk.forEach((holder, i) => {
    const account = accounts[i];
    const wallet = account === null || (account.program === SYSTEM && !account.hasData && !account.executable);
    learned[holder.owner] = wallet;
    if (wallet) holders.push(holder);
    else leave("not-a-wallet", holder.amount);
  });

  holders.sort((a, b) => (a.owner < b.owner ? -1 : 1));
  return { slot: listed.slot, supply, holders, eligible: holders.reduce((sum, holder) => sum + holder.amount, 0n), leftOut, learned };
}

// ---------------------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------------------

/**
 * Credits the pot to the holders of a snapshot, each in proportion to their balance. Nothing
 * is sent: this only moves lamports from the pot to the holders' names.
 */
export function creditHolders(books: Books, snapshot: Snapshot, now: number): Line | null {
  for (const [owner, wallet] of Object.entries(snapshot.learned)) {
    if (!wallet && !books.notWallets.includes(owner)) books.notWallets.push(owner);
  }
  const pot = BigInt(books.pot);
  if (pot <= 0n || snapshot.eligible === 0n) return null;

  let credited = 0n;
  const holding = new Set<string>();
  for (const holder of snapshot.holders) {
    holding.add(holder.owner);
    // Rounded down. What rounding leaves, less than a lamport a holder, stays in the pot.
    const share = (pot * holder.amount) / snapshot.eligible;
    const entry = books.owners[holder.owner] ?? { owed: "0" };
    entry.owed = plus(entry.owed, share);
    delete entry.gone;
    books.owners[holder.owner] = entry;
    credited += share;
  }
  for (const [owner, entry] of Object.entries(books.owners)) {
    if (!holding.has(owner)) entry.gone ??= now;
  }
  books.pot = (pot - credited).toString();
  books.credited = plus(books.credited, credited);
  books.creditedAt = now;
  const leftOut = Object.fromEntries(Object.entries(snapshot.leftOut).map(([why, left]) => [why, { owners: left.owners, tokens: left.tokens.toString() }])) as Record<LeftOut, { owners: number; tokens: string }>;
  return publish(books, { kind: "credit", slot: snapshot.slot, lamports: credited.toString(), holders: snapshot.holders.length, tokens: snapshot.eligible.toString(), leftOut, books: booksHash(books) }, now);
}

/**
 * Returns to the pot what is owed to owners who have held nothing for `afterSecs` and whose
 * sum never reached a payment, and to owners a payment could not reach. Not while a round is open.
 */
export function lapse(books: Books, now: number, least: bigint, afterSecs: number): Line | null {
  let [owners, lamports] = [0, 0n];
  for (const [owner, entry] of Object.entries(books.owners)) {
    if (entry.gone === undefined || now - entry.gone < afterSecs) continue;
    const owed = BigInt(entry.owed);
    if (owed >= least && !entry.stuck) continue;
    delete books.owners[owner];
    if (owed > 0n) [owners, lamports] = [owners + 1, lamports + owed];
  }
  if (lamports === 0n) return null;
  books.pot = plus(books.pot, lamports);
  books.credited = plus(books.credited, -lamports);
  return publish(books, { kind: "lapse", owners, lamports: lamports.toString() }, now);
}

// ---------------------------------------------------------------------------------------
// A payout round
// ---------------------------------------------------------------------------------------

const planPath = (store: Store, round: number) => join(store.dir, "private", `round-${String(round).padStart(6, "0")}.plan.json`);
const journalPath = (store: Store, round: number) => join(store.dir, "private", `round-${String(round).padStart(6, "0")}.journal.jsonl`);

/** The least a holder is sent: what the settings say, and never less than an empty account must hold. */
export const minPayment = (settings: Pick<Settings, "minPaymentLamports">, rentExemptMinimum: bigint) => (settings.minPaymentLamports > rentExemptMinimum ? settings.minPaymentLamports : rentExemptMinimum);

export type Payment = { owner: string; lamports: string };

/**
 * What a round will pay, fixed before anything is sent. A round is open from the moment this is
 * on disk. `wallet` is what the keeper's wallet held then: until the round is closed nothing
 * leaves the wallet but what the round's journal shows.
 */
export type RoundPlan = { v: 1; round: number; at: string; minPayment: string; batchSize: number; payments: Payment[]; total: string; wallet?: string };

/** Who would be paid now: every owner owed at least the minimum, the whole of what they are owed. */
export function planRound(books: Books, now: number, least: bigint, batchSize = DEFAULTS.batchSize): RoundPlan | null {
  const payments = Object.entries(books.owners)
    .filter(([, entry]) => !entry.stuck && BigInt(entry.owed) >= least)
    .map(([owner, entry]) => ({ owner, lamports: entry.owed }))
    .sort((a, b) => (a.owner < b.owner ? -1 : 1));
  if (payments.length === 0) return null;
  const total = payments.reduce((sum, payment) => sum + BigInt(payment.lamports), 0n);
  return { v: 1, round: books.round + 1, at: iso(now), minPayment: least.toString(), batchSize, payments, total: total.toString() };
}

/** Whether it is time to credit the pot, and whether it is time to pay. */
export function due(books: Books, now: number, least: bigint, settings: Settings = DEFAULTS): { credit: boolean; pay: boolean } {
  const pot = BigInt(books.pot);
  const ready = planRound(books, now, least);
  return {
    credit: pot > 0n && (pot >= settings.creditWhenLamports || now - books.creditedAt >= settings.creditAtLeastEverySecs),
    pay: ready !== null && (BigInt(ready.total) >= settings.payWhenLamports || now - books.paidAt >= settings.payAtLeastEverySecs),
  };
}

/** A transaction signed for some of the plan's payments. Written to the journal before it is sent. */
type Attempt = { t: "attempt"; id: number; payments: number[]; signature: string; blockhash: string; lastValidBlockHeight: number; slot: number; fee: number; raw: string; at: string };
/** What became of it. `expired` means no finalized block holds it and none ever can. `slot` and `past` are a `Fate`'s. */
type Outcome = { t: "outcome"; id: number; signature: string; outcome: "landed" | "failed" | "expired"; slot?: number; past?: number; error?: string; at: string };
type JournalEntry = Attempt | Outcome;

/** Payments that travel together: at first a batch of the plan, after a failure one payment alone. */
type Group = { payments: number[]; live?: Attempt; expired: number };

type Progress = {
  groups: Group[];
  landed: { signature: string; payments: number[] }[];
  /** Payments this round gave up on. `failed`: the chain refused a transaction that paid this owner alone. */
  putOff: { payment: number; failed: boolean }[];
  fees: bigint;
  attempts: number;
  /** The newest slot any outcome in the journal names. */
  after: number;
};

const EXPIRIES_BEFORE_GIVING_UP = 3;

function start(plan: RoundPlan): Progress {
  const all = plan.payments.map((_, index) => index);
  return { groups: chunks(all, plan.batchSize).map((payments) => ({ payments, expired: 0 })), landed: [], putOff: [], fees: 0n, attempts: 0, after: 0 };
}

/**
 * Moves the round on by one journal entry. Replaying the journal after a crash and running the
 * round live go through this same function, so both arrive at the same state.
 */
function apply(progress: Progress, entry: JournalEntry): void {
  if (entry.t === "attempt") {
    const group = progress.groups.find((some) => some.payments.join() === entry.payments.join());
    // This is the rule against paying twice, checked on every entry: no second transaction for payments that have one alive.
    if (!group || group.live) throw new Error(`the journal has transaction ${entry.signature} for payments that ${group ? "already have one out" : "are settled"}`);
    group.live = entry;
    progress.attempts = Math.max(progress.attempts, entry.id + 1);
    return;
  }
  const at = progress.groups.findIndex((some) => some.live?.id === entry.id);
  if (at < 0) throw new Error(`the journal settles transaction ${entry.signature}, which is not out`);
  const group = progress.groups[at];
  progress.after = Math.max(progress.after, entry.slot ?? 0, entry.past ?? 0);
  if (entry.outcome === "landed") {
    progress.groups.splice(at, 1);
    progress.landed.push({ signature: entry.signature, payments: group.payments });
    progress.fees += BigInt(group.live!.fee);
  } else if (entry.outcome === "failed") {
    // A transaction that fails pays its fee and moves nothing. A batch the chain refuses is tried
    // again one payment at a time, to find the one it refuses; that one is put off.
    progress.fees += BigInt(group.live!.fee);
    if (group.payments.length > 1) progress.groups.splice(at, 1, ...group.payments.map((payment) => ({ payments: [payment], expired: 0 })));
    else { progress.groups.splice(at, 1); progress.putOff.push({ payment: group.payments[0], failed: true }); }
  } else {
    group.live = undefined;
    group.expired += 1;
    // The network would not take it, which says nothing about who was in it: they wait for the next round.
    if (group.expired >= EXPIRIES_BEFORE_GIVING_UP) {
      progress.groups.splice(at, 1);
      progress.putOff.push(...group.payments.map((payment) => ({ payment, failed: false })));
    }
  }
}

function readPlan(store: Store, round: number): RoundPlan | null {
  return existsSync(planPath(store, round)) ? (JSON.parse(readFileSync(planPath(store, round), "utf8")) as RoundPlan) : null;
}

/** The round that is open, if one is: planned, and not yet closed in the books. */
export const openRoundOf = (store: Store, books: Books) => readPlan(store, books.round + 1);

function replay(store: Store, plan: RoundPlan): Progress {
  const path = journalPath(store, plan.round);
  dropTornLine(path);
  const progress = start(plan);
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) apply(progress, JSON.parse(line) as JournalEntry);
  }
  return progress;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A signature as explorers and RPC nodes write it. The same code as the site's. */
export function base58(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let text = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    text += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) text += ALPHABET[digits[i]];
  return text;
}

/** The compute units a payout transaction asks for. A transfer and each of the two fee instructions cost 150; the limit leaves room to spare. */
const unitsFor = (payments: number) => 200 * (payments + 2) + 1_000;

/** The network fees of a round in which every transaction lands the first time it is sent. */
export const roundFees = (plan: RoundPlan, settings: Settings) => chunks(plan.payments, plan.batchSize).reduce((sum, batch) => sum + networkFee(unitsFor(batch.length), settings), 0n);

function sign(plan: RoundPlan, payments: number[], keeper: Keypair, recent: { blockhash: string; lastValidBlockHeight: number; slot: number }, id: number, settings: Settings): Attempt {
  const units = unitsFor(payments.length);
  const tx = new Transaction({ feePayer: keeper.publicKey, blockhash: recent.blockhash, lastValidBlockHeight: recent.lastValidBlockHeight });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: settings.microLamportsPerUnit }));
  for (const index of payments) {
    const { owner, lamports } = plan.payments[index];
    tx.add(SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: new PublicKey(owner), lamports: BigInt(lamports) }));
  }
  tx.sign(keeper);
  return {
    t: "attempt", id, payments,
    signature: base58(tx.signature!),
    ...recent,
    fee: Number(networkFee(units, settings)),
    raw: tx.serialize().toString("base64"),
    at: new Date().toISOString(),
  };
}

/** A transaction that is out: enough to ask the chain what became of it. `slot` is where the node was when it was signed. */
export type Out = { id: number; signature: string; lastValidBlockHeight: number; slot: number };
/** `slot` is the block a landed or failed one is in. `past`, of a dead one, is a finalized slot by which it could no longer land. */
export type Fate = { id: number; signature: string; outcome: "landed" | "failed" | "expired"; slot?: number; past?: number; error?: string };

/** What a look at the chain found: the fates that are now certain, and a sentence if the node could not have known one. */
export type Look = { fates: Fate[]; blind: string | null };

/**
 * Finds out what became of transactions that are out. Landed or failed is believed only of a
 * finalized block. Dead is believed only when all of this holds: a finalized block is past the
 * blockhash's last valid height, with a margin; a node that has seen at least that far does
 * not know the signature; and that node still has every block since the transaction was
 * signed. A node that has dropped those blocks would say "never seen" of a transaction that
 * landed in one of them, so its word is not taken: `blind` says so, and nothing is signed again.
 * Anything else is left for the next look.
 *
 * Those answers can come from different nodes behind one address, so "dead" here is still only
 * a node's word. Whoever acts on it asks the wallet as well: see `executeRound` below and
 * `conclude` in round.ts.
 */
export async function settle(chain: Chain, out: Out[], settings: Pick<Settings, "expiryMargin">): Promise<Look> {
  const fates: Fate[] = [];
  const unseen: Out[] = [];
  const first = await chain.statuses(out.map((one) => one.signature));
  out.forEach((one, i) => {
    const status = first.statuses[i];
    if (!status) unseen.push(one);
    else if (status.finalized) fates.push({ id: one.id, signature: one.signature, outcome: status.failed ? "failed" : "landed", slot: status.slot, ...(status.error ? { error: status.error } : {}) });
  });
  if (unseen.length === 0) return { fates, blind: null };

  const tip = await chain.finalized();
  const overdue = unseen.filter((one) => tip.blockHeight > one.lastValidBlockHeight + settings.expiryMargin);
  if (overdue.length === 0) return { fates, blind: null };
  // Asked again after the tip was read. An answer from a node that lags behind that tip proves nothing.
  const second = await chain.statuses(overdue.map((one) => one.signature));
  if (second.slot < tip.slot) return { fates, blind: null };
  const oldest = await chain.firstAvailableSlot();
  let blind: string | null = null;
  overdue.forEach((one, i) => {
    if (second.statuses[i]) return;
    if (oldest <= one.slot) fates.push({ id: one.id, signature: one.signature, outcome: "expired", past: tip.slot });
    else blind ??= `I cannot tell what became of transaction ${one.signature}: it was signed at slot ${one.slot}, and the node I ask keeps no block older than slot ${oldest}. I sign nothing in its place until a node that has those blocks answers.`;
  });
  return { fates, blind };
}

export type RunOptions = {
  settings?: Partial<Settings>;
  report?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  fault?: Fault;
  /** Once aborted, the round is left where it is at the next step. It stays open, and is picked up from its journal. */
  signal?: AbortSignal;
};

/**
 * How a turn at an open round ended: every payment settled; stopped by the signal; the
 * keeper's own SOL ran short; or the node asked could not say what became of a transaction.
 */
export type RoundState = "done" | "stopped" | "short" | "blind";
/** `why` says what a round that is short or blind is waiting for. */
export type Ended = { state: RoundState; why?: string };

/**
 * Opens a round: puts its plan on disk, with what the keeper's wallet holds at that moment.
 * Refuses if the books have moved on or a round is already open.
 */
export function openRound(store: Store, books: Books, plan: RoundPlan, wallet: bigint, fault?: Fault): void {
  if (plan.round !== books.round + 1) throw new Error(`round ${plan.round} was planned from other books: the next round is ${books.round + 1}`);
  if (readPlan(store, plan.round)) throw new Error(`round ${plan.round} is already open`);
  writeWhole(planPath(store, plan.round), JSON.stringify({ ...plan, wallet: wallet.toString() } satisfies RoundPlan));
  fault?.("plan written");
}

/**
 * Sends the open round's payments until each has landed in a finalized block or been put
 * off. It can be stopped at any point and run again: it picks up from the journal.
 *
 * The payments are fee money the wallet already holds. The network fees are the keeper's own:
 * a transaction is signed only if the wallet holds its fee on top of all the fee money the
 * books say it keeps for others, and still stays above the least a wallet may hold.
 */
export async function executeRound(store: Store, chain: Chain, keeper: Keypair, options: RunOptions = {}): Promise<Ended> {
  const settings = { ...DEFAULTS, ...options.settings };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const books = readBooks(store);
  const plan = readPlan(store, books.round + 1);
  if (!plan) throw new Error("no round is open");
  const path = journalPath(store, plan.round);
  const progress = replay(store, plan);
  const record = (entries: JournalEntry[]) => {
    appendLines(path, entries.map((entry) => JSON.stringify(entry)));
    for (const entry of entries) apply(progress, entry);
  };
  const lamportsOf = (payments: number[]) => payments.reduce((sum, index) => sum + BigInt(plan.payments[index].lamports), 0n);
  const reserve = await chain.rentExemptMinimum();
  /** No older than the last thing of mine the books or the journal know of. */
  const holds = (after = 0) => chain.balance(keeper.publicKey, Math.max(books.after ?? 0, progress.after, after));

  while (progress.groups.length > 0) {
    if (options.signal?.aborted) return { state: "stopped" };
    const wave = progress.groups.slice(0, settings.inFlight);
    const fresh = wave.filter((group) => !group.live);
    if (fresh.length > 0) {
      const wallet = await holds();
      // What the wallet still keeps for others: the books' figure, less what this round has already sent.
      const kept = inHand(books) - progress.landed.reduce((sum, tx) => sum + lamportsOf(tx.payments), 0n);
      const fees = fresh.reduce((sum, group) => sum + networkFee(unitsFor(group.payments.length), settings), 0n);
      if (wallet >= kept + fees + reserve) {
        const recent = await chain.latestBlockhash();
        // Signed, written down and flushed. Only then sent.
        record(fresh.map((group, i) => sign(plan, group.payments, keeper, recent, progress.attempts + i, settings)));
        options.fault?.("attempts recorded");
      } else if (!progress.groups.some((group) => group.live)) {
        return { state: "short", why: `I cannot afford the next payments of round ${plan.round}: their network fees are ${fees} lamports, and my wallet holds ${wallet} lamports, of which ${kept} are fees I keep for others and ${reserve} must stay in it. The round waits until my wallet ${keeper.publicKey.toBase58()} is topped up.` };
      }
      // Otherwise something is still out, and its landing may be why the wallet looks short: it is settled first.
    }
    // Everything that is out, wherever it stands in the list: a batch split after a failure
    // puts its pieces ahead of transactions sent before it, and those still have to be settled.
    const out = progress.groups.filter((group) => group.live);
    // Sent, or sent again: the same bytes carry the same signature, and a signature lands at most once.
    await Promise.all(out.map((group) => chain.send(Buffer.from(group.live!.raw, "base64")).catch((error: unknown) => options.report?.(`sending ${group.live!.signature}: ${plain(error)}`))));
    options.fault?.("sent");
    await sleep(settings.pollMs);
    const at = new Date().toISOString();
    const { fates, blind } = await settle(chain, out.map((group) => group.live!), settings);
    const write = (some: Fate[]) => {
      if (some.length === 0) return false;
      record(some.map((fate) => ({ t: "outcome", ...fate, at })));
      for (const fate of some) if (fate.outcome !== "landed") options.report?.(`transaction ${fate.signature} ${fate.outcome}${fate.error ? `: ${fate.error}` : ""}`);
      return true;
    };
    // Landed and failed are a block's word, and are written down at once. Dead is a node saying
    // "never seen", and a node that has lost the block says that of a transaction that landed.
    // So the wallet is asked as well, once nothing else of the round is out: if every one called
    // dead is dead, it holds at least what it held when the round opened, less what the journal
    // shows was sent. SOL sent to the wallet in the meantime, more than the payments in doubt,
    // would hide one that landed.
    const dead = fates.filter((fate) => fate.outcome === "expired");
    let wrote = write(fates.filter((fate) => fate.outcome !== "expired"));
    let missing: string | null = null;
    if (dead.length > 0 && fates.length === out.length) {
      if (plan.wallet !== undefined) {
        const least = BigInt(plan.wallet) - progress.landed.reduce((sum, tx) => sum + lamportsOf(tx.payments), 0n) - progress.fees;
        const wallet = await holds(Math.max(...dead.map((fate) => fate.past ?? 0)));
        if (wallet < least) missing = `A node tells me ${dead.length} transaction${dead.length === 1 ? "" : "s"} of round ${plan.round} never landed (${dead[0].signature} for one), and my wallet holds less than my journal accounts for: ${wallet} lamports where it should hold at least ${least}. I sign nothing in their place until a node that knows those transactions answers.`;
      }
      if (!missing) wrote = write(dead) || wrote;
    }
    if (wrote) options.fault?.("outcomes recorded");
    if (missing) return { state: "blind", why: missing };
    if (blind) return { state: "blind", why: blind };
  }
  return { state: "done" };
}

/**
 * Closes a finished round: takes what was sent off what is owed, publishes the round, and puts
 * its plan and journal away. Run again after a crash, it does whatever part is left.
 */
export function closeRound(store: Store, now: number, fault?: Fault): Books {
  const books = readBooks(store);
  const plan = readPlan(store, books.round + 1);
  if (!plan) {
    // The books may have been written just before a crash: the ledger and the round's files catch up here.
    bringLedgerUp(store, books);
    putAway(store, books.round);
    return books;
  }
  const progress = replay(store, plan);
  if (progress.groups.length > 0) throw new Error(`round ${plan.round} still has payments out`);

  let paid = 0n;
  const transactions = progress.landed.map(({ signature, payments }) => {
    let lamports = 0n;
    for (const index of payments) {
      const payment = plan.payments[index];
      const entry = books.owners[payment.owner];
      if (!entry || BigInt(entry.owed) < BigInt(payment.lamports)) throw new Error(`round ${plan.round} paid ${payment.owner} more than the books owe`);
      entry.owed = plus(entry.owed, -BigInt(payment.lamports));
      // Somebody who holds nothing and is owed nothing has no more business in the books.
      if (entry.owed === "0" && entry.gone !== undefined) delete books.owners[payment.owner];
      lamports += BigInt(payment.lamports);
    }
    paid += lamports;
    return { signature, payments: payments.length, lamports: lamports.toString() };
  });
  let putOff = 0n;
  for (const { payment, failed } of progress.putOff) {
    const entry = books.owners[plan.payments[payment].owner];
    // An owner the chain would not let me pay stops being credited. What they are owed returns to the pot when it lapses.
    if (entry && failed) { entry.stuck = true; entry.gone ??= now; }
    putOff += BigInt(plan.payments[payment].lamports);
  }
  books.round = plan.round;
  books.paidAt = now;
  happenedBy(books, progress.after);
  books.credited = plus(books.credited, -paid);
  books.totals.holders.paid = plus(books.totals.holders.paid, paid);
  books.totals.fees = plus(books.totals.fees, progress.fees);
  publish(books, { kind: "payout", round: plan.round, lamports: paid.toString(), payments: plan.payments.length - progress.putOff.length, transactions, putOff: { payments: progress.putOff.length, lamports: putOff.toString() }, fees: progress.fees.toString() }, now);
  writeBooks(store, books, fault);
  putAway(store, plan.round);
  return books;
}

/** Moves a closed round's plan and journal to `private/done/`. They are the proof of who was paid what. */
function putAway(store: Store, round: number) {
  for (const path of [planPath(store, round), journalPath(store, round)]) {
    if (!existsSync(path)) continue;
    const done = join(dirname(path), "done");
    mkdirSync(done, { recursive: true });
    renameSync(path, join(done, path.slice(dirname(path).length + 1)));
  }
}

/**
 * A whole round: plan, send, close. `state` is null if nobody was owed enough to plan one, and
 * otherwise how the sending ended; the round is closed only when it is "done".
 */
export async function payHolders(store: Store, chain: Chain, keeper: Keypair, now: number, options: RunOptions = {}): Promise<{ state: RoundState | null; why?: string; books: Books }> {
  const settings = { ...DEFAULTS, ...options.settings };
  const books = readBooks(store);
  const plan = planRound(books, now, minPayment(settings, await chain.rentExemptMinimum()), settings.batchSize);
  if (!plan) return { state: null, books };
  openRound(store, books, plan, await chain.balance(keeper.publicKey, books.after), options.fault);
  const ended = await executeRound(store, chain, keeper, options);
  return { ...ended, books: ended.state === "done" ? closeRound(store, now, options.fault) : books };
}

/**
 * What the keeper does first, every time it starts and before every round: clears away half
 * written files, brings the ledger up to the books, and finishes a round that was left open.
 * After it, with `state` "done", the books, the ledger and the chain agree.
 */
export async function recover(store: Store, chain: Chain, keeper: Keypair, now: number, options: RunOptions = {}): Promise<{ state: RoundState; why?: string; books: Books; finished: number | null }> {
  tidy(store);
  const books = readBooks(store);
  if (books.keeper !== keeper.publicKey.toBase58()) throw new Error(`these are the books of ${books.keeper}, not of ${keeper.publicKey.toBase58()}`);
  bringLedgerUp(store, books);
  let finished: number | null = null;
  if (readPlan(store, books.round + 1)) {
    options.report?.(`round ${books.round + 1} was left open: finishing it`);
    const ended = await executeRound(store, chain, keeper, options);
    if (ended.state !== "done") return { ...ended, books, finished };
    finished = books.round + 1;
  }
  return { state: "done", books: closeRound(store, now, options.fault), finished };
}

// ---------------------------------------------------------------------------------------
// Books older than the chain
// ---------------------------------------------------------------------------------------

/** Signatures already looked up and found to be somebody else's doing, so they are not fetched again. */
const notMine = new Set<string>();

/**
 * Transactions the keeper's key paid for that the keeper's own records do not have. There
 * should be none. One means the books are older than the chain (a backup put back, a second
 * copy of the keeper running) and nothing more may be paid until a person has looked.
 */
export async function strangers(chain: Chain, keeper: PublicKey, known: Set<string>, limit = 200): Promise<string[]> {
  const found: string[] = [];
  for (const { signature, failed } of await chain.history(keeper, limit)) {
    if (failed || known.has(signature) || notMine.has(signature)) continue;
    // Somebody sending SOL to the keeper shows up here too. Only what the keeper paid for is its own doing.
    const payer = await chain.feePayer(signature);
    if (payer === keeper.toBase58()) found.push(signature);
    // A node can list a signature a moment before it can show the transaction, and a node that
    // keeps little history lists some it can no longer show. Neither is written off as somebody
    // else's: it is asked about again at the next look.
    else if (payer !== null) notMine.add(signature);
  }
  return found;
}

/** Every signature in the ledger, in the rounds' journals and in the books: what `strangers` compares the chain to. */
export function knownSignatures(store: Store): Set<string> {
  const known = new Set<string>();
  const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
  for (const text of lines(ledgerPath(store))) {
    const line = JSON.parse(text) as Line;
    if (line.kind === "payout") for (const { signature } of line.transactions) known.add(signature);
    else if (line.kind === "claim" || line.kind === "treasury" || line.kind === "buyback") known.add(line.signature);
  }
  for (const folder of [join(store.dir, "private"), join(store.dir, "private", "done")]) {
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder)) {
      if (!name.endsWith(".journal.jsonl")) continue;
      for (const text of lines(join(folder, name))) known.add((JSON.parse(text) as JournalEntry).signature);
    }
  }
  if (hasBooks(store)) {
    const { pending } = readBooks(store);
    if (pending) known.add(pending.signature);
  }
  return known;
}
