// Reading the pool and the rulebook, saying which edict earned the fees, and the two
// transactions that deal with the curve: the claim, through the hook program, and the buyback
// that burns what it buys.
//
// Everything here is in lamports and in the token's smallest unit, as bigint, so nothing is
// ever rounded twice.
import { deriveDbcTokenVaultAddress, type DynamicBondingCurveClient, getCurrentPoint, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { createBurnCheckedInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, type Connection, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { TOKEN_DECIMALS } from "../curve.js";
import { claimFeesTx } from "../fees.js";
import { decodeRulebook, FACTS, OPS, rulebookAddress, type Condition, type Rulebook } from "../hook.js";
import type { Books, Share } from "./books.js";
import type { Settings } from "./settings.js";

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

const POOL_LEN = 424;
/** The pool account of a token with a transfer hook starts with these eight bytes (TransferHookPool). */
const HOOK_POOL = [237, 219, 184, 23, 42, 189, 169, 35];

/**
 * The fee figures of a pool, in lamports. Byte offsets are PoolState from the curve program's
 * IDL (0.2.1) after Anchor's 8 bytes.
 */
export type FeeCounters = {
  /** Fees waiting in the pool for the config's fee claimer. Claiming lowers it. At 272. */
  waiting: bigint;
  /** Every lamport ever credited to the fee claimer and the pool's creator. It only grows. At 336. */
  total: bigint;
  /** The creator's part of `total`. Zero for good on this token: the config gives the creator 0%. At 360. */
  creatorWaiting: bigint;
  config: PublicKey;
  mint: PublicKey;
  solVault: PublicKey;
};

export function decodeFeeCounters(data: Uint8Array): FeeCounters {
  if (data.length !== POOL_LEN || !HOOK_POOL.every((byte, i) => data[i] === byte)) throw new Error("this account is not the pool of a token with a transfer hook");
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const key = (at: number) => new PublicKey(bytes.subarray(at, at + 32));
  return {
    waiting: bytes.readBigUInt64LE(272),
    total: bytes.readBigUInt64LE(336),
    creatorWaiting: bytes.readBigUInt64LE(360),
    config: key(72),
    mint: key(136),
    solVault: key(200),
  };
}

/** Where the keeper looks. All of it follows from the token's addresses and the keeper's own. */
export type Places = {
  hookProgram: PublicKey;
  mint: PublicKey;
  pool: PublicKey;
  keeper: PublicKey;
  treasury: PublicKey;
  /** The keeper's token account: buybacks land in it and are burned from it in the same transaction. */
  burnAccount: PublicKey;
  /** The pool's wrapped-SOL account: the curve's SOL and the fees not yet claimed. */
  solVault: PublicKey;
};

export const placesOf = (p: { hookProgram: PublicKey; mint: PublicKey; pool: PublicKey; keeper: PublicKey; treasury: PublicKey }): Places => ({
  ...p,
  burnAccount: getAssociatedTokenAddressSync(p.mint, p.keeper, false, TOKEN_2022_PROGRAM_ID),
  solVault: deriveDbcTokenVaultAddress(p.pool, NATIVE_MINT),
});

/** Everything a round decides from, as one node saw it in one slot. */
export type Reading = {
  slot: number;
  /** The chain's own clock in that slot, which is the one the hook reads. */
  now: number;
  fees: FeeCounters;
  book: Rulebook;
  /** The token's supply, in its smallest unit. Burning lowers it. */
  supply: bigint;
  /** What the keeper's token account holds, and whether it exists yet. */
  inBurnAccount: bigint;
  hasBurnAccount: boolean;
  /** Lamports sitting in the curve's SOL vault. */
  inSolVault: bigint;
  /** Lamports in the keeper's wallet. */
  keeperLamports: bigint;
};

/**
 * One call for the pool, the rulebook and the rest, so that the fee counter and the edict in
 * force are from the same slot. `after` is the slot of the last reading: a node that is behind
 * it answers with an error instead of an older picture.
 */
export async function read(connection: Connection, places: Places, after = 0): Promise<Reading> {
  const { context, value } = await connection.getMultipleAccountsInfoAndContext(
    [places.pool, rulebookAddress(places.hookProgram, places.mint), SYSVAR_CLOCK_PUBKEY, places.mint, places.burnAccount, places.keeper, places.solVault],
    { commitment: "confirmed", minContextSlot: after || undefined },
  );
  const [pool, rulebook, clock, mint, burnAccount, keeper, solVault] = value;
  if (!pool || !rulebook || !clock || !mint) throw new Error("the pool, the rulebook or the mint is not where it should be");
  const fees = decodeFeeCounters(pool.data);
  if (!fees.mint.equals(places.mint)) throw new Error("that pool is another token's");
  if (!fees.solVault.equals(places.solVault)) throw new Error("the pool keeps its SOL somewhere I did not expect");
  return {
    slot: context.slot,
    now: Number(clock.data.readBigInt64LE(32)),
    fees,
    book: decodeRulebook(rulebook.data),
    supply: mint.data.readBigUInt64LE(36),
    inBurnAccount: burnAccount ? burnAccount.data.readBigUInt64LE(64) : 0n,
    hasBurnAccount: burnAccount !== null,
    inSolVault: solVault ? solVault.data.readBigUInt64LE(64) : 0n,
    keeperLamports: BigInt(keeper?.lamports ?? 0),
  };
}

// ---------------------------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------------------------

/**
 * Counts the fees that came in since the last reading to the edict in force at this one. The
 * rulebook keeps a split at all times (the opening one before the first edict, the last
 * edict's after its term ran out or while the guardian has paused the agent), and its edict
 * number moves only when the split is rewritten, so the number is all that has to be watched.
 *
 * Counting looks only at the pool's running total, which a claim does not move, so how often
 * the fees are claimed changes nothing about which edict they are counted to.
 *
 * Returns whether the books changed, and a sentence for the ledger if edicts were missed.
 */
export function count(books: Books, reading: Reading): { changed: boolean; note: string | null } {
  if (books.read && reading.slot <= books.read.slot) return { changed: false, note: null };
  const { book, fees } = reading;
  if (books.read && fees.total < BigInt(books.read.total)) throw new Error("the pool's running total of fees went down: this is not the pool the books were kept for");
  // The first reading takes what is still waiting in the pool; what was claimed before it is set aside.
  const came = books.read ? fees.total - BigInt(books.read.total) : fees.waiting;
  if (!books.read) books.before = (fees.total - fees.waiting).toString();
  const epoch = Number(book.epoch);
  const missed = books.edict === null ? 0 : epoch - books.edict - 1;
  const moved = books.edict !== epoch;
  books.edict = epoch;
  if (came > 0n) {
    const newest = books.inPool.at(-1);
    const same = newest && newest.epoch === epoch && newest.holdersBps === book.holdersBps && newest.burnBps === book.burnBps && newest.treasuryBps === book.treasuryBps;
    if (same) newest.lamports = (BigInt(newest.lamports) + came).toString();
    else books.inPool.push({ epoch, lamports: came.toString(), holdersBps: book.holdersBps, burnBps: book.burnBps, treasuryBps: book.treasuryBps });
  }
  // A reading that found nothing new is not worth a write: the next one starts from the same total.
  if (came === 0n && !moved && books.read) return { changed: false, note: null };
  books.read = { slot: reading.slot, total: fees.total.toString() };
  // The rulebook holds only the edict in force, so the splits of edicts that came and went unseen cannot be known.
  const note = missed > 0 ? `I was away while ${missed} edict${missed === 1 ? "" : "s"} came and went. The fees since my last reading are counted to edict ${epoch}.` : null;
  return { changed: true, note };
}

/** Takes `lamports` of the fees counted and still in the pool, oldest first: what a claim of that size took out, edict by edict. */
export function takeFromPool(books: Books, lamports: bigint): Share[] {
  const taken: Share[] = [];
  let left = lamports;
  while (left > 0n) {
    const oldest = books.inPool[0];
    if (!oldest) throw new Error(`a claim took ${left} lamports more out of the pool than I had counted`);
    const have = BigInt(oldest.lamports);
    const part = have <= left ? have : left;
    taken.push({ ...oldest, lamports: part.toString() });
    if (part === have) books.inPool.shift();
    else oldest.lamports = (have - part).toString();
    left -= part;
  }
  return taken;
}

// ---------------------------------------------------------------------------------------------
// Would the hook let the keeper buy?
// ---------------------------------------------------------------------------------------------

const MILLIONTHS = 1_000_000n;
const share = (amount: bigint, supply: bigint) => (supply === 0n ? 0n : (amount * MILLIONTHS) / supply);
const fact = (name: string) => FACTS.findIndex((known) => known.name === name);

function holds(condition: Condition, seen: bigint): boolean {
  switch (OPS[condition.op]) {
    case "<": return seen < condition.value;
    case "<=": return seen <= condition.value;
    case ">": return seen > condition.value;
    case ">=": return seen >= condition.value;
    case "==": return seen === condition.value;
    case "!=": return seen !== condition.value;
    case "mod": return condition.value >> 32n !== 0n && seen % (condition.value >> 32n) === (condition.value & 0xffff_ffffn);
    default: return false;
  }
}

/** A buy as the hook would see it. */
export type Buy = {
  /** Tokens bought, in the smallest unit. */
  tokens: bigint;
  /** What the receiving token account holds before the buy lands. */
  heldBefore: bigint;
  /** The receiving token account: its address is where its luck starts from. */
  account: PublicKey;
  supply: bigint;
  slot: number;
  now: number;
  /** Lamports in the curve's SOL vault when the hook runs. */
  inSolVault: bigint;
  /** The priority fee the transaction sets, in micro-lamports per compute unit. */
  priorityFee: number;
};

/**
 * What execute() in programs/hook/src/processor.rs would answer for this buy: the same facts,
 * worked out the same way. The keeper has no app key, so "via app" is 0. It is only used to
 * size a buyback and to tell a rule that closes for seconds from one that closes for a whole
 * edict: a rehearsal of the real transaction on the node has the last word before anything is sent.
 */
export function admitted(book: Rulebook, keeper: PublicKey, buy: Buy): boolean {
  if (book.paused || (!book.exempt.equals(PublicKey.default) && book.exempt.equals(keeper))) return true;
  if (book.rule.length === 0 || buy.now >= book.ruleUntil) return true;
  const secondOfDay = ((buy.now % 86_400) + 86_400) % 86_400;
  const seen: Record<number, bigint> = {
    [fact("size")]: share(buy.tokens, buy.supply),
    [fact("held_before")]: share(buy.heldBefore, buy.supply),
    [fact("held_after")]: share(buy.heldBefore + buy.tokens, buy.supply),
    [fact("minute")]: BigInt(Math.floor((secondOfDay % 3_600) / 60)),
    [fact("hour")]: BigInt(Math.floor(secondOfDay / 3_600)),
    [fact("weekday")]: BigInt((((Math.floor(buy.now / 86_400) + 4) % 7) + 7) % 7),
    [fact("elapsed")]: BigInt(Math.max(0, buy.now - book.updatedAt)),
    [fact("via_app")]: 0n,
    [fact("priority_fee")]: BigInt(buy.priorityFee),
    [fact("curve_sol")]: buy.inSolVault / 1_000_000n,
    [fact("luck")]: ((BigInt(buy.slot) + buy.account.toBuffer().readBigUInt64LE(0)) & 0xffff_ffff_ffff_ffffn) % 100n,
  };
  return [0, 1, 2, 3].some((group) => {
    const members = book.rule.filter((condition) => condition.group === group);
    return members.length > 0 && members.every((condition) => condition.fact in seen && holds(condition, seen[condition.fact]));
  });
}

/**
 * A transaction lands a few slots after it is built, and before that it is rehearsed on the
 * node, in a slot that can still be the reading's own. A buy is tried only if it would pass in
 * every one of them.
 */
const LANDING_SLOTS = 12;
export const SLOT_SECS = 0.4;

/** Whether a buy of `tokens` into the empty account, built `wait` slots from the reading, would pass in the slot it is rehearsed in and in every slot it might land in. */
function passesAt(reading: Reading, places: Places, priorityFee: number, tokens: bigint, wait = 0): boolean {
  return Array.from({ length: LANDING_SLOTS + 1 }, (_, ahead) => wait + ahead).every((ahead) =>
    admitted(reading.book, places.keeper, {
      tokens, heldBefore: 0n, account: places.burnAccount, supply: reading.supply, priorityFee,
      slot: reading.slot + ahead, now: reading.now + Math.floor(ahead * SLOT_SECS), inSolVault: reading.inSolVault,
    }),
  );
}

/**
 * How many slots from the reading until the smallest buy would pass, looking two minutes ahead:
 * long enough for a turn at the turnstile (it comes round every 100 slots) and for the next
 * minute. Null if it does not open in that time: the rule keeps the buyback out for as long as
 * it stands.
 */
export function opensIn(reading: Reading, places: Places, priorityFee: number): number | null {
  for (let wait = 0; wait <= 300; wait++) if (passesAt(reading, places, priorityFee, 1n, wait)) return wait;
  return null;
}

/**
 * The most tokens the rule in force lets the keeper buy in one go right now: "any" for no cap,
 * 0n when even the smallest buy would be refused. The keeper's account is emptied in the same
 * transaction before the buy, so the hook always sees an account that held nothing.
 */
export function room(reading: Reading, places: Places, priorityFee: number): bigint | "any" {
  const passes = (tokens: bigint) => passesAt(reading, places, priorityFee, tokens);
  if (passes(reading.supply)) return "any";
  if (!passes(1n)) return 0n;
  // Every cap in the catalogue is an upper one, so what passes is everything up to some size.
  let [fits, tooMuch] = [1n, reading.supply];
  while (tooMuch - fits > 1n) {
    const middle = (fits + tooMuch) / 2n;
    if (passes(middle)) fits = middle;
    else tooMuch = middle;
  }
  // The hook rounds shares down to millionths of the supply, and the supply shrinks with every
  // burn: one millionth is left as a margin so the buy is not sitting on the very edge.
  const margin = reading.supply / MILLIONTHS;
  return fits > margin ? fits - margin : fits;
}

/** Why the edict in force keeps a small buy into an empty account out for as long as it stands. */
export function whyClosed(reading: Reading): string {
  const facts = new Set(reading.book.rule.map((condition) => FACTS[condition.fact]?.name));
  if (facts.has("held_before")) return "The edict in force lets only wallets that already hold some buy, and I keep none: I burn what I buy at once.";
  return "The edict in force refuses my buy.";
}

// ---------------------------------------------------------------------------------------------
// The transactions
// ---------------------------------------------------------------------------------------------

/** The compute units each kind of transaction asks for. A priority fee is charged on the units asked for, not on those used, so the limit is always set with it. */
export const UNITS = { claim: 150_000, buyback: 250_000, transfer: 2_000 };
const BASE_FEE = 5_000n;

/** The network fee of a transaction with one signature that asks for `units`. */
export const networkFee = (units: number, settings: Pick<Settings, "microLamportsPerUnit">) => BASE_FEE + BigInt(Math.ceil((units * settings.microLamportsPerUnit) / 1_000_000));

const budget = (units: number, settings: Pick<Settings, "microLamportsPerUnit">) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: settings.microLamportsPerUnit }),
];

/**
 * Takes up to `lamports` of fees out of the pool, as SOL, into the keeper's own wallet. The
 * claim goes through the hook program (src/fees.ts): Meteora knows only the rulebook's address
 * as the fee claimer, and the program claims for the keeper the rulebook names.
 *
 * Asking for the amount read a moment ago, and not for "everything", makes the claim come to a
 * figure known before it is sent: fees that arrive in between stay for the next claim.
 */
export function claimTx(places: Places, config: PublicKey, lamports: bigint, settings: Settings): { tx: Transaction; fee: bigint } {
  const claim = claimFeesTx({ program: places.hookProgram, keeper: places.keeper, mint: places.mint, config, lamports });
  return { tx: new Transaction().add(...budget(UNITS.claim, settings), ...claim.instructions), fee: networkFee(UNITS.claim, settings) };
}

/** The treasury's share, as a plain transfer of SOL. */
export function treasuryTx(places: Places, lamports: bigint, settings: Settings): { tx: Transaction; fee: bigint } {
  const tx = new Transaction().add(...budget(UNITS.transfer, settings), SystemProgram.transfer({ fromPubkey: places.keeper, toPubkey: places.treasury, lamports }));
  return { tx, fee: networkFee(UNITS.transfer, settings) };
}

export type Buyback = {
  tx: Transaction;
  fee: bigint;
  /** The tokens it buys: exactly this many, or the transaction fails. It burns them, and whatever was in the account before. */
  tokens: bigint;
  /** The most SOL the buy can cost, trading fee included. What it did cost is read from the transaction afterwards. */
  atMost: bigint;
};

/**
 * Buys the token from the curve and burns what it bought, in one transaction the keeper signs
 * alone. The buy names the number of tokens (an "exact out" swap), so the burn that follows can
 * name the same number: nothing is left in the account, and nothing but that buy is burned.
 *
 *   1. the priority fee and the compute limit that goes with it
 *   2. burn whatever was already in the keeper's account (somebody may have sent tokens to it),
 *      so the hook sees an account that held nothing
 *   3. open the keeper's wrapped-SOL account, put `atMost` lamports in it     (from the SDK)
 *   4. swap2_with_transfer_hook, exact out: `tokens` for at most `atMost`     (from the SDK)
 *   5. close the wrapped-SOL account: what the buy did not need comes back    (from the SDK)
 *   6. burn `tokens`
 *
 * `lamports` is what there is to spend; `atMostTokens` caps the size, for a rule that does.
 * Returns null when the SOL on offer buys nothing.
 */
export async function buybackTx(dbc: DynamicBondingCurveClient, places: Places, p: { lamports: bigint; atMostTokens: bigint | "any"; burnFirst: bigint }, settings: Settings): Promise<Buyback | null> {
  const virtualPool = await dbc.state.getPool(places.pool);
  if (!virtualPool) throw new Error(`no pool at ${places.pool.toBase58()}`);
  const config = await dbc.state.getPoolConfig(virtualPool.poolState.config);
  if (!config) throw new Error("the pool's config is gone");
  const quote = { virtualPool, config, swapBaseForQuote: false, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint: await getCurrentPoint(dbc.connection, config.activationType) };

  // What the SOL would buy at this moment, less the slippage allowed, and no more than the rule in force lets through.
  const reach = dbc.pool.swapQuote2({ ...quote, swapMode: SwapMode.ExactIn, amountIn: new BN(p.lamports.toString()), slippageBps: settings.slippageBps });
  let tokens = BigInt((reach.minimumAmountOut ?? reach.outputAmount).toString());
  if (p.atMostTokens !== "any" && p.atMostTokens < tokens) tokens = p.atMostTokens;
  if (tokens <= 0n) return null;
  const cost = dbc.pool.swapQuote2({ ...quote, swapMode: SwapMode.ExactOut, amountOut: new BN(tokens.toString()), slippageBps: settings.slippageBps });
  const ceiling = BigInt((cost.maximumAmountIn ?? cost.includedFeeInputAmount).toString());
  const atMost = ceiling < p.lamports ? ceiling : p.lamports;

  const swap = await dbc.pool.swap2WithTransferHook({
    owner: places.keeper,
    pool: places.pool,
    swapBaseForQuote: false,
    referralTokenAccount: null,
    swapMode: SwapMode.ExactOut,
    amountOut: new BN(tokens.toString()),
    maximumAmountIn: new BN(atMost.toString()),
  });
  const burn = (amount: bigint) => createBurnCheckedInstruction(places.burnAccount, places.mint, places.keeper, amount, TOKEN_DECIMALS, [], TOKEN_2022_PROGRAM_ID);
  const tx = new Transaction().add(...budget(UNITS.buyback, settings));
  if (p.burnFirst > 0n) tx.add(burn(p.burnFirst));
  // The SDK may set a compute budget of its own; one transaction can carry only one of each.
  tx.add(...swap.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)), burn(tokens));
  return { tx, fee: networkFee(UNITS.buyback, settings), tokens, atMost };
}
