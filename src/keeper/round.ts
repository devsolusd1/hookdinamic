// One round of the keeper, start to finish.
//
// A round reads the pool and the rulebook in one call, counts the fees that came in since the
// last reading to the edict in force, and then does whatever is due, one step at a time and
// each step at most once: claim the fees, send the treasury its share, buy back and burn, credit
// the holders, pay the holders. Every step is in the books before it is on the chain, so a
// round that is cut short at any point is picked up by the next one from the files.
//
// A keeper the guardian has replaced can claim nothing more. Its rounds then pay out what its
// books still owe, whatever the thresholds, say in the ledger what could not be paid, and stop.
import type { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { ExtensionType, getAccountLen } from "@solana/spl-token";
import type { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_DECIMALS } from "../curve.js";
import { REFUSAL } from "../hook.js";
import {
  bringLedgerUp, happenedBy, hasBooks, holdLock, inHand, iso, mustAddUp, newBooks, plus, publish, readBooks, recordBuyback, recordClaim, recordTreasury, sharesOf, tidy, writeBooks,
  type Books, type Fault, type Pending, type Store,
} from "./books.js";
import { chainOf, landed, rehearse, stoppedOn, SYSTEM, type Chain, type Landed, type Rehearsal } from "./chain.js";
import { buybackTx, claimTx, count, networkFee, opensIn, placesOf, read, room, SLOT_SECS, takeFromPool, treasuryTx, UNITS, whyClosed, type Places, type Reading } from "./fees.js";
import { base58, closeRound, creditHolders, due, executeRound, fromKept, knownSignatures, lapse, listHolders, minPayment, openRound, openRoundOf, planRound, recover, roundFees, settle, strangers, toKeep, type Fate, type Snapshot } from "./holders.js";
import { DEFAULTS, inSol, inUnits, plain, type Settings } from "./settings.js";

export type KeeperContext = {
  connection: Connection;
  dbc: DynamicBondingCurveClient;
  hookProgram: PublicKey;
  mint: PublicKey;
  pool: PublicKey;
  /** The hot key: it claims the fees through the hook program and pays them out. */
  keeper: Keypair;
  /** Where the treasury's share goes. An address only: its key is not on this machine. */
  treasury: PublicKey;
  /** The keeper's folder: `public/` holds the ledger the site shows, `private/` its books. */
  dir: string;
  /** Work out and report, but send nothing and write nothing. */
  dryRun?: boolean;
  /** Once aborted, the round gives up at the next step. */
  signal?: AbortSignal;
  settings?: Partial<Settings>;
  /** Told each thing the round does, as it does it. */
  report?: (line: string) => void;
};

export type KeeperOutcome =
  /** Nothing was due, or something stands in the way: `reason` says which. */
  | { status: "waiting"; reason: string }
  /** What the round did, a sentence each. */
  | { status: "settled"; did: string[] };

/**
 * Thrown by every round of a keeper the guardian has replaced, once it has paid out what it
 * held and said so in its ledger. It has nothing more to do: whatever runs it can stop.
 */
export class Retired extends Error {}

/** What only a test passes: a point to stop the process at, and a clock to wait by. */
export type Hooks = { fault?: Fault; sleep?: (ms: number) => Promise<void> };

/** A token account of this mint carries two extensions: it is longer than a plain one, and so is its rent. */
const TOKEN_ACCOUNT_LEN = getAccountLen([ExtensionType.ImmutableOwner, ExtensionType.TransferHookAccount]);

/** Folders whose records this process has already compared with the chain, and when a listing last found nobody to credit. */
const compared = new Set<string>();
const nobodyAt = new Map<string, number>();
const LIST_AGAIN_MS = 10 * 60_000;
/** What stood in the way in the last round of each folder, so that the same thing is not reported twenty seconds later. */
const waitedLast = new Map<string, Set<string>>();
/** Treasury addresses this process has looked at and found to be a wallet in use. */
const wallets = new Set<string>();
/** For a keeper that is retiring: how many rounds in a row its buyback has come to nothing, and why the last time. */
const buysFailed = new Map<string, { rounds: number; why: string }>();
const ROUNDS_BEFORE_LEAVING_IT = 3;

/**
 * The treasury's share is a plain transfer of SOL, and nothing can take SOL back out of an
 * address that is not a wallet: a token account, a mint, a program's account. An address
 * nothing has ever been at is refused too: addresses carry no check digit, so one wrong
 * character is still an address, and nobody has its key. A multisig's vault passes once it
 * holds SOL.
 */
async function mustBeWallet(chain: Chain, treasury: PublicKey): Promise<void> {
  const address = treasury.toBase58();
  if (wallets.has(address)) return;
  const [account] = await chain.ownerAccounts([address]);
  if (!account) throw new Error(`there is nothing at the treasury's address ${address}: no wallet has ever been used there, so I cannot tell it from a mistyped one. Compare TREASURY with the wallet, character by character. If it is right, send that wallet a little SOL (0.01 SOL is plenty): I start by myself once it has arrived.`);
  if (account.program !== SYSTEM || account.hasData || account.executable) throw new Error(`the treasury's address ${address} is not a wallet: it is an account of the program ${account.program}, and SOL sent there could never be taken out. I do nothing until TREASURY is a wallet's address.`);
  wallets.add(address);
}

/** Everything the steps of one round share. */
type Run = {
  ctx: KeeperContext;
  settings: Settings;
  hooks: Hooks;
  places: Places;
  store: Store;
  chain: Chain;
  books: Books;
  reading: Reading;
  /** When the reading was taken, by this machine's clock: the chain's clock is carried forward from it. */
  readAt: number;
  /** The least an account with no data may hold. */
  rent: bigint;
  did: string[];
  /** What stood in the way of a step that was due. */
  waits: string[];
  /** The keeper the rulebook names in my place, if it names another: I claim nothing more, and pay out what I hold. */
  retiring: string | null;
  /** In a keeper that is retiring: why this round left the burn share where it is. */
  burnLeft: string | null;
};

const stopped = (run: Run) => run.ctx.signal?.aborted === true;
const dry = (run: Run) => run.ctx.dryRun === true;
/** The chain's clock, in unix seconds: what the last reading said, plus the time gone by since. */
const now = (run: Run) => run.reading.now + Math.floor((Date.now() - run.readAt) / 1000);
/** No reading may be older than the last one, nor than the last thing of mine the books know to have happened. */
const noOlderThan = (run: Run) => Math.max(run.reading.slot, run.books.after ?? 0);

function say(run: Run, line: string) {
  run.did.push(line);
  run.ctx.report?.(line);
}

/** Something stands in the way of a step that was due. The round's outcome says what. */
function wait(run: Run, why: string) {
  run.waits.push(why);
}

function save(run: Run) {
  if (!dry(run)) writeBooks(run.store, run.books, run.hooks.fault);
}

function pause(run: Run, ms: number): Promise<void> {
  if (run.hooks.sleep) return run.hooks.sleep(ms);
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); run.ctx.signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    run.ctx.signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * One round. Safe to call every 20 seconds, and after a crash at any point: whatever was in
 * flight is settled from the files first. Throws when a person has to look: the books and the
 * chain disagree, another keeper holds the folder, or the treasury's address is not a wallet.
 */
export async function turn(ctx: KeeperContext, hooks: Hooks = {}): Promise<KeeperOutcome> {
  if (ctx.treasury.equals(ctx.keeper.publicKey)) throw new Error("the treasury cannot be the keeper's own wallet");
  const store: Store = { dir: ctx.dir };
  const places = placesOf({ hookProgram: ctx.hookProgram, mint: ctx.mint, pool: ctx.pool, keeper: ctx.keeper.publicKey, treasury: ctx.treasury });
  const chain = chainOf(ctx.connection);
  if (!ctx.dryRun) {
    holdLock(store);
    tidy(store);
  }
  await mustBeWallet(chain, ctx.treasury);

  const kept = hasBooks(store) ? readBooks(store) : null;
  if (kept && (kept.mint !== ctx.mint.toBase58() || kept.keeper !== ctx.keeper.publicKey.toBase58())) {
    throw new Error(`the books in ${ctx.dir} are those of keeper ${kept.keeper} for token ${kept.mint}, not mine`);
  }
  const reading = await read(ctx.connection, places, Math.max(kept?.read?.slot ?? 0, kept?.after ?? 0));
  const named = reading.book.keeper.toBase58();
  const replaced = named !== ctx.keeper.publicKey.toBase58();
  const notMe = `the rulebook names ${named} as the keeper, not my key ${ctx.keeper.publicKey.toBase58()}`;
  // A key with no books has claimed nothing, and has nothing to pay out.
  if (replaced && !kept) throw new Error(notMe);
  if (replaced && kept?.retired) throw new Retired(`${notMe}: I have paid out what my books owed and stopped for good. The last line of my ledger says what was left.`);
  const run: Run = {
    ctx, hooks, places, store, chain, reading,
    settings: { ...DEFAULTS, ...ctx.settings },
    books: kept ?? newBooks(ctx.mint, ctx.keeper.publicKey, reading.now),
    readAt: Date.now(),
    rent: await chain.rentExemptMinimum(),
    did: [],
    waits: [],
    retiring: replaced ? named : null,
    burnLeft: null,
  };
  if (!kept) save(run);
  else if (!dry(run)) bringLedgerUp(store, run.books);
  // The guardian has named this key again: it is the keeper as before.
  if (!replaced && run.books.retired) {
    delete run.books.retired;
    save(run);
  }

  if (!(await settleWhatWasOut(run))) return outcome(run);
  if (!dry(run) && !compared.has(store.dir)) {
    await noStrangers(run);
    compared.add(store.dir);
  }

  takeCount(run);
  const steps = run.retiring ? [payTreasury, buyBack, creditAndPay, retire] : [claim, payTreasury, buyBack, creditAndPay];
  for (const step of steps) {
    if (stopped(run)) break;
    await step(run);
  }
  return outcome(run);
}

function outcome(run: Run): KeeperOutcome {
  const before = waitedLast.get(run.store.dir);
  waitedLast.set(run.store.dir, new Set(run.waits));
  if (run.did.length > 0) {
    // A round that did something has no reason to give, so what stood in the way of the rest is reported, when it first comes up.
    for (const why of run.waits) if (!before?.has(why)) run.ctx.report?.(why);
    return { status: "settled", did: run.did };
  }
  if (run.waits.length > 0) return { status: "waiting", reason: run.waits.join(" ") };
  const { books, reading, settings } = run;
  // The round was stopped, or the node could not show the transaction yet: the next round takes it from the books.
  if (books.pending) return { status: "waiting", reason: `transaction ${books.pending.signature} is out and its fate is not in my books yet` };
  return {
    status: "waiting",
    reason: `nothing is due: ${inSol(reading.fees.waiting)} of fees wait in the pool (I claim at ${inSol(settings.claimAtLamports)}), and I hold ${inSol(books.totals.treasury.owed)} for the treasury, ${inSol(books.totals.burn.owed)} to buy back with and ${inSol(BigInt(books.pot) + BigInt(books.credited))} for holders`,
  };
}

// ---------------------------------------------------------------------------------------------
// Reading and counting
// ---------------------------------------------------------------------------------------------

/** A new reading, counted and checked. Taken after anything of mine has landed, so the next step decides from the chain as it now is. */
async function readAgain(run: Run): Promise<void> {
  run.reading = await read(run.ctx.connection, run.places, noOlderThan(run));
  run.readAt = Date.now();
  takeCount(run);
}

function takeCount(run: Run): void {
  // Fees that come in once another keeper is named are that keeper's to count and to claim.
  if (!run.retiring) {
    const { changed, note } = count(run.books, run.reading);
    if (note) publish(run.books, { kind: "note", text: note, about: "away" }, now(run));
    if (changed) save(run);
  }
  check(run);
}

/**
 * What must always hold, or the keeper stops and a person looks: every lamport of fees that
 * left the pool is a claim in the books (nobody else can claim: the program claims only for
 * the keeper), the fees counted and not claimed are the fees waiting in the pool, the books add
 * up, and the wallet holds at least the fee money the books say it does.
 *
 * A keeper that was replaced no longer answers for the pool, which the next keeper claims
 * from: only its own books and its own wallet are checked.
 */
function check(run: Run): void {
  const { books, reading: { fees, keeperLamports } } = run;
  if (!run.retiring) {
    const left = fees.total - fees.waiting - fees.creatorWaiting;
    const known = BigInt(books.before) + BigInt(books.totals.claimed);
    if (left !== known) throw new Error(`${left} lamports of fees have left the pool and my books know of ${known}: somebody else has claimed, or these are not this pool's books. I do nothing until a person has looked.`);
    const counted = sharesOf(books.inPool).lamports;
    if (counted !== fees.waiting + fees.creatorWaiting) throw new Error(`I have counted ${counted} lamports of fees as still in the pool and the pool says ${fees.waiting + fees.creatorWaiting}. I do nothing until a person has looked.`);
  }
  mustAddUp(books);
  if (inHand(books) > keeperLamports) throw new Error(`my books say I hold ${inHand(books)} lamports of fees and my wallet has ${keeperLamports}. I do nothing until a person has looked.`);
}

/**
 * Stops everything if the keeper's key paid for a transaction its own records do not have.
 * Looked for when a process takes its first round, and again before anything is signed.
 */
async function noStrangers(run: Run): Promise<void> {
  const found = await strangers(run.chain, run.ctx.keeper.publicKey, knownSignatures(run.store));
  if (found.length > 0) throw new Error(`my key paid for ${found.length} transaction(s) my records do not have, ${found[0]} for one: my books are older than the chain, or another keeper is running. I pay nothing until a person has looked.`);
}

/** What a step would take of the keeper's own SOL, checked before the step is started. Null if it can be afforded. */
function cannotAfford(run: Run, what: string, need: bigint): string | null {
  const own = run.reading.keeperLamports - inHand(run.books);
  if (own >= need + run.rent) return null;
  return `I cannot afford to ${what}: it takes ${inSol(need)} of my own, and beyond the fees I keep for others my wallet holds ${inSol(own)}, of which ${inSol(run.rent)} must stay in it. My wallet ${run.ctx.keeper.publicKey.toBase58()} needs topping up.`;
}

/** Who holds the token, at a finalized slot, with the pool and the project's own wallets left out. */
function list(run: Run): Promise<Snapshot> {
  const { books, chain, settings, ctx } = run;
  const notWallets = new Set(books.notWallets);
  return listHolders(chain, {
    mint: ctx.mint,
    project: [ctx.keeper.publicKey.toBase58(), ctx.treasury.toBase58(), ...settings.ownWallets],
    alsoPay: settings.alsoPay,
    known: (owner) => (books.owners[owner] ? !books.owners[owner].stuck : notWallets.has(owner) ? false : undefined),
  });
}

// ---------------------------------------------------------------------------------------------
// One transaction at a time: signed, written down, sent, settled
// ---------------------------------------------------------------------------------------------

type Signed = { raw: Buffer; signature: string; blockhash: string; lastValidBlockHeight: number; slot: number };

async function signNow(run: Run, tx: Transaction): Promise<Signed> {
  const recent = await run.chain.latestBlockhash();
  tx.feePayer = run.ctx.keeper.publicKey;
  tx.recentBlockhash = recent.blockhash;
  tx.lastValidBlockHeight = recent.lastValidBlockHeight;
  tx.sign(run.ctx.keeper);
  return { raw: tx.serialize(), signature: base58(tx.signature!), ...recent };
}

/** Why a rehearsal failed, in words where the hook program has them. */
function refusal(run: Run, rehearsal: Rehearsal): string {
  const code = stoppedOn(rehearsal.logs, run.ctx.hookProgram);
  return code !== null && REFUSAL[code] ? REFUSAL[code] : (rehearsal.error ?? "unknown");
}

/**
 * Sends a transaction that has passed its rehearsal. What it is for goes into the books, with
 * its signed bytes and what the wallet held, before it is sent: from that moment the books
 * know something is out, and nothing else is started until its fate is in them too.
 *
 * Returns what became of it, or "out" if that is not known yet (the round was stopped, or the
 * node cannot show the transaction): the next round takes it from there.
 */
async function send(run: Run, kind: Pending["kind"], signed: Signed, what: Pick<Pending, "fee" | "lamports" | "tokens" | "found" | "to" | "listed">): Promise<Fate["outcome"] | "out"> {
  const { raw, ...rest } = signed;
  run.books.pending = { kind, ...rest, raw: raw.toString("base64"), at: iso(now(run)), wallet: run.reading.keeperLamports.toString(), ...what };
  writeBooks(run.store, run.books);
  run.hooks.fault?.("intent recorded");
  return chase(run, true);
}

/** Follows the transaction that is out until a finalized block has it, or none ever can. Its bytes are sent again while it is unseen: the same bytes land at most once. */
async function chase(run: Run, fresh: boolean): Promise<Fate["outcome"] | "out"> {
  const pending = run.books.pending!;
  // What a buyback cost is read from the transaction itself. It is read as soon as a block has
  // it, and kept for when that block is finalized: a node that keeps little history can drop a
  // block soon after.
  let seen: Landed | null = null;
  for (let first = fresh; ; first = false) {
    if (!first) {
      const { fates: [fate], blind } = await settle(run.chain, [{ id: 0, signature: pending.signature, lastValidBlockHeight: pending.lastValidBlockHeight, slot: pending.slot }], run.settings);
      if (fate) return (await conclude(run, fate, seen)) ? fate.outcome : "out";
      // The node has forgotten the blocks it could be in: it stays out, and nothing is signed in its place.
      if (blind) { wait(run, blind); return "out"; }
      if (stopped(run)) return "out";
      if (pending.kind === "buyback") seen ??= await landed(run.ctx.connection, pending.signature, "confirmed", 1);
    }
    await run.chain.send(Buffer.from(pending.raw, "base64")).catch((error: unknown) => run.ctx.report?.(`sending ${pending.signature}: ${plain(error)}`));
    run.hooks.fault?.("sent");
    await pause(run, run.settings.pollMs);
  }
}

/**
 * A node says a transaction of mine never landed and no longer can. A node that has lost the
 * block says the same of one that did land, so the chain's own state is asked as well, which
 * no node forgets: a claim shows in the pool's counters, and a payment or a buyback leaves the
 * wallet holding less than when it was signed. Returns what speaks against the node's word,
 * or null if nothing does.
 *
 * SOL sent to the wallet in the meantime, more than the payment itself, would hide a payment
 * that landed.
 */
async function landedAfterAll(run: Run, pending: Pending, fate: Fate): Promise<string | null> {
  const { books } = run;
  const after = Math.max(noOlderThan(run), fate.past ?? 0);
  if (pending.kind === "claim") {
    const { fees } = await read(run.ctx.connection, run.places, after);
    if (fees.total - fees.waiting - fees.creatorWaiting <= BigInt(books.before) + BigInt(books.totals.claimed)) return null;
    // Once another keeper is named, its claims leave the pool too, and the counters cannot tell them from mine.
    return run.retiring ? "fees have left the pool that my books do not have, which may be my claim or those of the keeper named in my place" : "the chain shows that it did: fees have left the pool that my books do not have";
  }
  if (pending.wallet === undefined) return null;
  const holds = await run.chain.balance(run.ctx.keeper.publicKey, after);
  return holds < BigInt(pending.wallet) ? `the chain shows that it did: my wallet holds ${inSol(holds)}, less than the ${inSol(pending.wallet)} it held when I signed it` : null;
}

/**
 * Writes the fate of the transaction that was out into the books, and its line into the
 * ledger. False if it stays out: a buyback the node cannot show, so that what it cost is not
 * known yet, or a transaction a node calls dead while the chain shows that something moved.
 */
async function conclude(run: Run, fate: Fate, seen: Landed | null): Promise<boolean> {
  const { books, places } = run;
  const pending = books.pending!;
  const what = pending.kind === "claim" ? "claim" : pending.kind === "treasury" ? "payment to the treasury" : "buyback";
  const fee = BigInt(pending.fee);
  if (fate.outcome === "expired") {
    const against = await landedAfterAll(run, pending, fate);
    if (against) {
      wait(run, `A node tells me my ${what} ${pending.signature} never landed, and ${against}. I sign nothing in its place until a node that knows the transaction answers.`);
      return false;
    }
    books.pending = null;
    happenedBy(books, fate.past);
    save(run);
    run.ctx.report?.(`my ${what} ${pending.signature} never landed and no longer can: nothing moved, and I start it again`);
    return true;
  }
  happenedBy(books, fate.slot);
  if (fate.outcome === "failed") {
    // It paid its network fee and moved nothing.
    books.pending = null;
    books.totals.fees = plus(books.totals.fees, fee);
    save(run);
    run.ctx.report?.(`my ${what} ${pending.signature} failed on the chain (${fate.error ?? "no reason given"}): it cost its network fee and moved nothing`);
    return true;
  }
  if (pending.kind === "claim") {
    // What came out is what the pool's own counters say has left it and the books do not have yet. Nobody else can claim.
    const { fees } = await read(run.ctx.connection, places, Math.max(run.reading.slot, fate.slot ?? 0));
    const left = fees.total - fees.waiting - fees.creatorWaiting - BigInt(books.before) - BigInt(books.totals.claimed);
    // Unless another keeper has been named since: then its claims have left the pool as well, and mine took no more than it asked for.
    const claimed = run.retiring && left > BigInt(pending.lamports) ? BigInt(pending.lamports) : left;
    if (claimed <= 0n) throw new Error(`my claim ${pending.signature} is in a finalized block and the pool does not show that anything left it. I do nothing until a person has looked.`);
    const shares = takeFromPool(books, claimed);
    books.pending = null;
    const line = recordClaim(books, { signature: pending.signature, shares, fee }, now(run));
    // The holders' share is credited with the claim, by the list taken before the claim was signed.
    const credit = pending.listed ? creditHolders(books, fromKept(pending.listed), now(run)) : null;
    save(run);
    if (line.kind === "claim") say(run, `claimed ${inSol(claimed)} of fees from the pool, counted to ${shares.length === 1 ? `edict ${shares[0].epoch}` : `edicts ${shares.map((share) => share.epoch).join(", ")}`}: ${inSol(line.treasury)} for the treasury, ${inSol(line.burn)} to buy back with, ${inSol(line.holders)} for holders (${pending.signature})`);
    if (credit?.kind === "credit") say(run, `credited ${inSol(credit.lamports)} to ${credit.holders} holder${credit.holders === 1 ? "" : "s"}, by what each held at slot ${credit.slot}, before my claim`);
    // Nobody but the pool and the project held any: the pot waits, and the list is not asked for again at once.
    else if (pending.listed) nobodyAt.set(run.store.dir, Date.now());
  } else if (pending.kind === "treasury") {
    books.pending = null;
    recordTreasury(books, { signature: pending.signature, lamports: BigInt(pending.lamports), to: pending.to!, fee }, now(run));
    save(run);
    say(run, `sent the treasury ${inSol(pending.lamports)} (${pending.signature})`);
  } else {
    // What the buy cost, trading fee included, is the rise of the pool's SOL account in that transaction.
    const shown = seen && seen.slot === fate.slot ? seen : await landed(run.ctx.connection, pending.signature, "finalized", 20);
    if (!shown) return false;
    const spent = shown.tokenChange(places.solVault);
    const [tokens, found] = [BigInt(pending.tokens ?? "0"), BigInt(pending.found ?? "0")];
    books.pending = null;
    recordBuyback(books, { signature: pending.signature, lamports: spent, tokens: tokens + found, found, fee }, now(run));
    save(run);
    const symbol = run.reading.book.names[run.reading.book.name]?.symbol ?? "tokens";
    say(run, `bought back ${inUnits(tokens, TOKEN_DECIMALS)} ${symbol} for ${inSol(spent)} and burned them${found > 0n ? `, with ${inUnits(found, TOKEN_DECIMALS)} that somebody had sent me` : ""} (${pending.signature})`);
  }
  return true;
}

/**
 * What was in flight when the last round ended: a transaction whose fate the books do not have,
 * or a payout round that is open. False if it is still not settled, and then nothing else is started.
 */
async function settleWhatWasOut(run: Run): Promise<boolean> {
  const { books, store } = run;
  if (books.pending) {
    if (dry(run)) { wait(run, `transaction ${books.pending.signature} is out and its fate is not in my books yet`); return false; }
    const fate = await chase(run, false);
    if (fate === "out") {
      if (run.waits.length === 0) wait(run, `transaction ${books.pending.signature} is still out`);
      return false;
    }
    await readAgain(run);
  }
  const open = openRoundOf(store, books);
  if (dry(run)) {
    if (open) wait(run, `payout round ${open.round} is open and not finished`);
    return !open;
  }
  const recovered = await recover(store, run.chain, run.ctx.keeper, now(run), { settings: run.settings, report: run.ctx.report, sleep: run.hooks.sleep, fault: run.hooks.fault, signal: run.ctx.signal });
  if (recovered.state !== "done") { wait(run, recovered.why ?? `payout round ${open?.round} is not finished`); return false; }
  run.books = recovered.books;
  if (recovered.finished !== null) {
    sayPaid(run, recovered.finished);
    await readAgain(run);
  }
  return true;
}

function sayPaid(run: Run, round: number) {
  const line = run.books.outbox.map((text) => JSON.parse(text) as { kind: string; round?: number; lamports: string; payments: number; transactions: unknown[]; putOff: { payments: number } }).find((some) => some.kind === "payout" && some.round === round);
  if (!line) return;
  say(run, `paid ${line.payments} holder${line.payments === 1 ? "" : "s"} ${inSol(line.lamports)} in ${line.transactions.length} transaction${line.transactions.length === 1 ? "" : "s"} (round ${round})${line.putOff.payments > 0 ? `; ${line.putOff.payments} put off to the next round` : ""}`);
}

// ---------------------------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------------------------

/**
 * Whether the treasury is due `owed`: enough to send, or something worth sending and a long
 * time since the last. A keeper that is retiring sends whatever it owes.
 */
const treasuryDue = (run: Run, owed: bigint) =>
  run.retiring
    ? owed > 0n
    : owed >= run.settings.treasuryAtLamports || (owed >= minPayment(run.settings, run.rent) && now(run) - run.books.treasuryAt >= run.settings.treasuryAtLeastEverySecs);

/** Whether the buyback is being waited out: the edict in force was found to refuse it, and that edict's rule still stands. */
function buybackShut(run: Run): boolean {
  const { books, reading: { book } } = run;
  const ruleStands = !book.paused && book.rule.length > 0 && now(run) < book.ruleUntil;
  return books.buybackWaits !== null && books.buybackWaits.epoch === Number(book.epoch) && ruleStands;
}

/**
 * Why the fees should come out of the pool now, if they should: enough is waiting, or
 * something is due and the SOL for it is still in there. The fees are one sum in the pool,
 * so a claim always takes all of it.
 */
function whyClaim(run: Run): string | null {
  const { books, reading, settings } = run;
  const waiting = reading.fees.waiting;
  if (waiting === 0n) return null;
  if (waiting >= settings.claimAtLamports) return `${inSol(waiting)} of fees are waiting in the pool`;
  const there = sharesOf(books.inPool);
  if (there.treasury > 0n && treasuryDue(run, BigInt(books.totals.treasury.owed) + there.treasury)) return "the treasury is due its share and part of it is still in the pool";
  const [have, most] = [BigInt(books.totals.burn.owed), settings.maxBuyLamports];
  const wanted = have + there.burn < most ? have + there.burn : most;
  if (there.burn > 0n && have < wanted && wanted >= settings.minBuyLamports && !buybackShut(run)) return "a buyback is due and its SOL is still in the pool";
  const pot = BigInt(books.pot) + there.holders;
  if (there.holders > 0n && (pot >= settings.creditWhenLamports || now(run) - books.creditedAt >= settings.creditAtLeastEverySecs)) return "the holders' pot is due and part of it is still in the pool";
  return null;
}

async function claim(run: Run): Promise<void> {
  const why = whyClaim(run);
  if (!why) return;
  const { books, reading, places, settings } = run;
  const waiting = reading.fees.waiting;
  if (dry(run)) {
    const shares = takeFromPool(books, waiting);
    recordClaim(books, { signature: "not sent", shares, fee: 0n }, now(run));
    say(run, `would claim ${inSol(waiting)} of fees from the pool (${why})`);
    return;
  }
  const { tx, fee } = claimTx(places, reading.fees.config, waiting, settings);
  // The first claim opens my token account, which Meteora's claim names. Its rent is paid once and the account stays.
  const rent = reading.hasBurnAccount ? 0n : BigInt(await run.ctx.connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_LEN));
  const short = cannotAfford(run, "claim the fees", fee + rent);
  if (short) return wait(run, short);
  await noStrangers(run);
  // If this claim makes a credit due, the holders are listed now, before it is signed. A claim
  // is public the moment it lands, and after days away it tells everybody how much is about to
  // be shared out: listed afterwards, somebody could buy in on seeing it and be credited fees
  // that came in before they held anything. The list goes into the books with the claim, so a
  // round cut short after the claim still credits by it.
  const pot = BigInt(books.pot) + sharesOf(books.inPool).holders;
  const creditDue = pot > 0n && (pot >= settings.creditWhenLamports || now(run) - books.creditedAt >= settings.creditAtLeastEverySecs);
  const listed = creditDue ? toKeep(await list(run)) : undefined;
  const signed = await signNow(run, tx);
  const rehearsal = await rehearse(run.ctx.connection, signed.raw);
  if (rehearsal.error) return wait(run, `my claim did not pass its rehearsal (${refusal(run, rehearsal)}): nothing was sent`);
  if ((await send(run, "claim", signed, { fee: fee.toString(), lamports: waiting.toString(), ...(listed ? { listed } : {}) })) !== "out") await readAgain(run);
}

async function payTreasury(run: Run): Promise<void> {
  const { books, places, settings } = run;
  if (books.pending) return;
  const owed = BigInt(books.totals.treasury.owed);
  if (!treasuryDue(run, owed)) return;
  if (dry(run)) {
    say(run, `would send the treasury ${inSol(owed)}`);
    return;
  }
  const { tx, fee } = treasuryTx(places, owed, settings);
  const short = cannotAfford(run, "send the treasury its share", fee);
  if (short) return wait(run, short);
  await noStrangers(run);
  const signed = await signNow(run, tx);
  const rehearsal = await rehearse(run.ctx.connection, signed.raw);
  if (rehearsal.error) return wait(run, `my payment to the treasury did not pass its rehearsal (${refusal(run, rehearsal)}): nothing was sent`);
  if ((await send(run, "treasury", signed, { fee: fee.toString(), lamports: owed.toString(), to: places.treasury.toBase58() })) !== "out") await readAgain(run);
}

/**
 * Buys the token back with the burn share and burns it, one buy a round. The hook judges the
 * buy like anyone's. The size is first cut to what my own copy of the hook's arithmetic says
 * the rule in force lets through, and then the real transaction is rehearsed on the node: if
 * the hook refuses it there, it is halved and rehearsed again, down to the least worth sending.
 * What is not spent stays owed to the burn share.
 *
 * A keeper that is retiring buys with whatever it still owes, down to what the buyback's own
 * network fee comes to, and does not wait for another edict: a buy that comes to nothing is
 * tried again for a few rounds, and then the burn share is left where it is.
 */
async function buyBack(run: Run): Promise<void> {
  const { books, places, settings, store } = run;
  if (books.pending) return;
  const owed = BigInt(books.totals.burn.owed);
  const lamports = owed < settings.maxBuyLamports ? owed : settings.maxBuyLamports;
  if (lamports < (run.retiring ? networkFee(UNITS.buyback, settings) : settings.minBuyLamports)) return;
  // The least a buy is cut down to before it is given up.
  const smallest = lamports < settings.minBuyLamports ? lamports : settings.minBuyLamports;
  const failedBefore = run.retiring ? buysFailed.get(store.dir) : undefined;
  if (failedBefore && failedBefore.rounds >= ROUNDS_BEFORE_LEAVING_IT) {
    run.burnLeft = failedBefore.why;
    return;
  }
  if (!run.retiring && buybackShut(run)) return wait(run, "my buyback is waiting for the next edict, and what I owe the burn share stays owed");
  if (dry(run)) {
    const most = room(run.reading, places, settings.microLamportsPerUnit);
    say(run, most === 0n ? `would try to buy back with ${inSol(lamports)}, and by my reckoning the edict in force would refuse it` : `would buy back and burn with up to ${inSol(lamports)}`);
    return;
  }
  /** For a keeper that is retiring: this round's buy came to nothing. `forGood`: trying again would end the same way. */
  const cameToNothing = (why: string, forGood: boolean) => {
    const rounds = forGood ? ROUNDS_BEFORE_LEAVING_IT : (failedBefore?.rounds ?? 0) + 1;
    buysFailed.set(store.dir, { rounds, why });
    if (rounds >= ROUNDS_BEFORE_LEAVING_IT) run.burnLeft = why;
    else wait(run, `${why}: I try again next round`);
  };
  const short = cannotAfford(run, "buy back", networkFee(UNITS.buyback, settings));
  if (short) return wait(run, short);
  await noStrangers(run);

  // A rule that closes for seconds (a turn at the turnstile, the next minute) is waited for, if it opens soon.
  let most = room(run.reading, places, settings.microLamportsPerUnit);
  for (const since = Date.now(); most === 0n; ) {
    const opens = opensIn(run.reading, places, settings.microLamportsPerUnit);
    if (opens === null || Date.now() - since + opens * SLOT_SECS * 1000 > settings.buybackWaitSecs * 1000) break;
    // Slots do not keep exact time: two more are let go by, and then the chain is read again, and waited for again if it is not open yet.
    await pause(run, Math.ceil((opens + 2) * SLOT_SECS * 1000));
    if (stopped(run)) return;
    await readAgain(run);
    most = room(run.reading, places, settings.microLamportsPerUnit);
  }

  // By my reckoning the hook would refuse even the smallest buy: the least one is rehearsed all the same, so the node has the last word.
  let ask: { lamports: bigint; atMostTokens: bigint | "any" } = most === 0n ? { lamports: smallest, atMostTokens: "any" } : { lamports, atMostTokens: most };
  for (let attempt = 0; ; attempt++) {
    const found = run.reading.inBurnAccount;
    const built = await buybackTx(run.ctx.dbc, places, { ...ask, burnFirst: found }, settings);
    if (!built) {
      if (run.retiring) return cameToNothing(`${inSol(ask.lamports)} buys nothing from the curve`, true);
      return wait(run, `${inSol(ask.lamports)} buys nothing from the curve right now: the burn share stays owed`);
    }
    if (attempt > 0 && built.atMost < smallest) break;
    const signed = await signNow(run, built.tx);
    const rehearsal = await rehearse(run.ctx.connection, signed.raw);
    if (!rehearsal.error) {
      if (books.buybackWaits) {
        publish(books, { kind: "note", text: "My buyback resumes.", about: "buyback-resumes" }, now(run));
        books.buybackWaits = null;
      }
      buysFailed.delete(store.dir);
      if ((await send(run, "buyback", signed, { fee: built.fee.toString(), lamports: built.atMost.toString(), tokens: built.tokens.toString(), found: found.toString() })) !== "out") await readAgain(run);
      return;
    }
    // Anything but the hook's own refusal (the price moved, the node is behind) is not a matter of size.
    if (stoppedOn(rehearsal.logs, run.ctx.hookProgram) !== 1) {
      if (run.retiring) return cameToNothing(`my buyback did not pass its rehearsal (${refusal(run, rehearsal)})`, false);
      return wait(run, `my buyback did not pass its rehearsal (${refusal(run, rehearsal)}): the burn share stays owed and I try again next round`);
    }
    ask = { lamports: ask.lamports, atMostTokens: built.tokens / 2n };
    if (ask.atMostTokens === 0n) break;
  }

  // Refused down to the least. If the rule keeps me out for as long as it stands, the ledger says so, once.
  const { book } = run.reading;
  const lasting = opensIn(run.reading, places, settings.microLamportsPerUnit) === null;
  if (run.retiring) return cameToNothing(lasting ? whyClosed(run.reading) : "The edict in force refused my buy.", lasting);
  if (!lasting) return wait(run, `the edict in force refused my buyback just now: ${inSol(owed)} stays owed to the burn share and I try again next round`);
  const why = whyClosed(run.reading);
  if (!books.buybackWaits) {
    publish(books, { kind: "note", text: `My buyback is waiting for the next edict. ${why} What I owe the burn share stays owed.`, about: "buyback-waits" }, now(run));
    say(run, `my buyback is waiting for the next edict: ${inSol(owed)} stays owed to the burn share`);
  }
  books.buybackWaits = { epoch: Number(book.epoch), why };
  save(run);
}

/**
 * The holders: credit the pot if it is time, return what has lapsed, pay if it is time. A
 * keeper that is retiring does not wait for either: it credits whatever the pot holds that is
 * worth a payment, and pays everybody it owes enough to send.
 */
async function creditAndPay(run: Run): Promise<void> {
  const { books, store, chain, settings, ctx } = run;
  if (books.pending) return;
  const least = minPayment(settings, run.rent);

  // The share of a claim that made a credit due was credited with the claim. What is credited
  // here is a pot that has waited out the longest wait, or one whose claim came without a list.
  const toCredit = run.retiring ? BigInt(books.pot) >= least : due(books, now(run), least, settings).credit;
  const listedNobodyAt = nobodyAt.get(store.dir) ?? 0;
  if (toCredit && Date.now() - listedNobodyAt > LIST_AGAIN_MS) {
    const line = creditHolders(books, await list(run), now(run));
    if (line?.kind === "credit") {
      save(run);
      say(run, `${dry(run) ? "would credit" : "credited"} ${inSol(line.lamports)} to ${line.holders} holder${line.holders === 1 ? "" : "s"}, by what each held at slot ${line.slot}`);
    } else {
      // Nobody but the pool and the project holds any: the pot waits, and the list is not asked for again at once.
      nobodyAt.set(store.dir, Date.now());
    }
  }
  if (stopped(run)) return;

  const lapsed = lapse(books, now(run), least, settings.lapseAfterSecs);
  if (lapsed?.kind === "lapse") {
    save(run);
    say(run, `${dry(run) ? "would return" : "returned"} to the pot ${inSol(lapsed.lamports)} owed to ${lapsed.owners} wallet${lapsed.owners === 1 ? "" : "s"} that hold none and were never owed enough to send`);
  }

  if (!run.retiring && !due(books, now(run), least, settings).pay) return;
  const plan = planRound(books, now(run), least, settings.batchSize);
  if (!plan) return;
  const inTransactions = Math.ceil(plan.payments.length / plan.batchSize);
  if (dry(run)) {
    say(run, `would pay ${plan.payments.length} holder${plan.payments.length === 1 ? "" : "s"} ${inSol(plan.total)} in ${inTransactions} transaction${inTransactions === 1 ? "" : "s"}`);
    return;
  }
  run.reading = { ...run.reading, keeperLamports: await chain.balance(ctx.keeper.publicKey, noOlderThan(run)) };
  const short = cannotAfford(run, `pay round ${plan.round}`, roundFees(plan, settings));
  if (short) return wait(run, short);
  await noStrangers(run);
  openRound(store, books, plan, run.reading.keeperLamports, run.hooks.fault);
  const ended = await executeRound(store, chain, ctx.keeper, { settings, report: ctx.report, sleep: run.hooks.sleep, fault: run.hooks.fault, signal: ctx.signal });
  if (ended.state !== "done") return wait(run, ended.why ?? `payout round ${plan.round} is not finished`);
  run.books = closeRound(store, now(run), run.hooks.fault);
  sayPaid(run, plan.round);
}

/**
 * The last step of a keeper the guardian has replaced. Once a round has found nothing more to
 * pay out, with nothing of its own out and nothing waiting for something that will pass, it
 * writes what is left with it into the ledger and marks its books: every later round ends at
 * once, with `Retired`.
 */
async function retire(run: Run): Promise<void> {
  const { books } = run;
  if (dry(run) || run.did.length > 0 || run.waits.length > 0 || books.pending) return;
  const [treasury, burn, pot, credited] = [BigInt(books.totals.treasury.owed), BigInt(books.totals.burn.owed), BigInt(books.pot), BigInt(books.credited)];
  const owedTo = Object.values(books.owners).filter((entry) => BigInt(entry.owed) > 0n).length;
  const left = [
    ...(treasury > 0n ? [`${inSol(treasury)} of the treasury's share`] : []),
    ...(burn > 0n ? [`${inSol(burn)} of the burn share (${run.burnLeft ?? "too little to buy back with"})`] : []),
    ...(credited > 0n ? [`${inSol(credited)} owed to ${owedTo} holder${owedTo === 1 ? "" : "s"} (each less than the least I send, or at an address the chain would not let me pay)`] : []),
    ...(pot > 0n ? [`${inSol(pot)} of the holders' share still in the pot, credited to nobody`] : []),
  ];
  const text = `The guardian has named another keeper, ${run.retiring}. I have claimed nothing since, and I have paid out what my books owed. ${left.length > 0 ? `What is left with me: ${left.join("; ")}.` : "Nothing is left with me."} I stop here.`;
  publish(books, { kind: "note", text, about: "retired" }, now(run));
  books.retired = { keeper: run.retiring!, at: iso(now(run)) };
  save(run);
  say(run, text);
}
