// The keeper's books and its public ledger.
//
// Two sets of files under one folder. `private/` is the keeper's own: the books (what was
// counted, claimed, and is owed to whom), and for a payout round in progress its plan and its
// journal. `public/` is what the site shows: the ledger, one JSON object per line, and a small
// head file with the running totals and the last few lines.
//
// The books are the truth about what is owed. The ledger is derived from them: every public
// line is put in the books' outbox first, the books are written whole, and only then is the
// ledger brought up to them. A crash between the two is mended on the next start.
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, truncateSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PublicKey } from "@solana/web3.js";

// ---------------------------------------------------------------------------------------
// The public ledger
// ---------------------------------------------------------------------------------------

/** Running totals, in lamports as text. Every public line carries them as they stood after it. */
export type Totals = {
  /** Fees taken out of the pool, ever. */
  claimed: string;
  treasury: { paid: string; owed: string };
  /** `spent` is the SOL that bought tokens back, `tokens` what was burned, in base units. */
  burn: { spent: string; tokens: string; owed: string };
  /** `owed` is what waits to be credited plus what is credited to holders and not yet sent. */
  holders: { paid: string; owed: string };
  /** Network fees the keeper paid for its own transactions. */
  fees: string;
};

/** Fees counted to one edict, and how that edict shares them. */
export type Share = { epoch: number; lamports: string; holdersBps: number; burnBps: number; treasuryBps: number };

/** Why an owner is left out of the holders. */
export type LeftOut = "pool" | "project" | "nobody" | "program" | "not-a-wallet";

/** What happened, one kind a line. Every signature can be opened on an explorer. */
export type Happened =
  | { kind: "claim"; signature: string; lamports: string; shares: Share[]; holders: string; burn: string; treasury: string }
  | { kind: "treasury"; signature: string; lamports: string; to: string }
  /** The buy and the burn are one transaction, so the two signatures are the same. `found` is what somebody had sent to my account, burned with it. */
  | { kind: "buyback"; signature: string; lamports: string; tokens: string; burnSignature: string; found?: string }
  /** The holders' pot credited to the holders of one moment. `books` is the sha256 of who is owed what after it. */
  | { kind: "credit"; slot: number; lamports: string; holders: number; tokens: string; leftOut: Record<LeftOut, { owners: number; tokens: string }>; books: string }
  /** One payout round. Each transaction pays up to 20 holders; the addresses are on the chain, not here. */
  | { kind: "payout"; round: number; lamports: string; payments: number; transactions: { signature: string; payments: number; lamports: string }[]; putOff: { payments: number; lamports: string }; fees: string }
  /** Small sums owed to wallets that sold everything long ago, returned to the holders' pot. */
  | { kind: "lapse"; owners: number; lamports: string }
  /** A sentence. `about` says which of my own notes it is; a note a person wrote has none. */
  | { kind: "note"; text: string; about?: "buyback-waits" | "buyback-resumes" | "away" | "retired" };

/** A line of the public ledger. `prev` is the sha256 of the line before, so a line cannot be changed quietly. */
export type Line = { v: 1; seq: number; at: string; prev: string; totals: Totals } & Happened;

/** What the site reads: small, and replaced whole after every line. */
export type Head = { v: 1; mint: string; keeper: string; seq: number; at: string; last: string; totals: Totals; recent: Line[] };

// ---------------------------------------------------------------------------------------
// The books
// ---------------------------------------------------------------------------------------

/** What one owner is owed. `gone` is when they were first seen holding nothing, or left out; `stuck`, that the chain refused a payment to them. */
export type Owed = { owed: string; gone?: number; stuck?: true };

/** A list of the holders at one finalized slot, as a file keeps it: the same as a `Snapshot` in holders.ts, with its amounts as text. */
export type Listed = {
  slot: number;
  supply: string;
  eligible: string;
  holders: { owner: string; amount: string }[];
  leftOut: Record<LeftOut, { owners: number; tokens: string }>;
  learned: Record<string, boolean>;
};

/**
 * A claim, a payment to the treasury or a buyback that was signed and may have been sent, and
 * whose outcome is not in the books yet. It is written here, with its signed bytes, before it
 * is sent: after a crash the same bytes are asked about, and sent again if nobody saw them.
 */
export type Pending = {
  kind: "claim" | "treasury" | "buyback";
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** The slot the node was at when it was signed: it can only be in a block from there on. */
  slot: number;
  /** The signed transaction, base64. */
  raw: string;
  at: string;
  /** The network fee it pays if it gets into a block, whether it goes through there or fails. */
  fee: string;
  /** A claim: the most it asks for. The treasury: what it sends. A buyback: the most it can cost. */
  lamports: string;
  /** A buyback: the tokens it buys and burns, and what it found in the account and burns too. */
  tokens?: string;
  found?: string;
  /** The treasury: where it goes. */
  to?: string;
  /** What the keeper's wallet held when it was signed. A payment or a buyback that landed leaves it holding less. */
  wallet?: string;
  /**
   * A claim whose share for holders will be credited at once: who held the token just before
   * it was signed. A claim is public the moment it lands, so the list it is shared by is taken
   * first and kept with it, and the credit is written with the claim.
   */
  listed?: Listed;
};

export type Books = {
  v: 1;
  mint: string;
  keeper: string;
  /** The number of the last public line, its hash, and the time it carries: a line is never dated before the one it follows. */
  seq: number;
  last: string;
  stampedAt: number;
  /** The last payout round closed. */
  round: number;

  /** The last reading of the pool that was counted: its slot and the pool's running total of fees then. Null before the first. */
  read: { slot: number; total: string } | null;
  /** Lamports somebody had already taken out of the pool when the books were opened. They are not mine to share. */
  before: string;
  /** The edict the last reading found in force. */
  edict: number | null;
  /** Fees counted and still in the pool, oldest first: which edict each part belongs to. A claim takes them from the front. */
  inPool: Share[];
  /** The edict my buyback is waiting out, and why. Kept so that the ledger says it once. */
  buybackWaits: { epoch: number; why: string } | null;
  pending: Pending | null;

  /** Lamports for holders that nobody has been credited with yet. */
  pot: string;
  /** The sum of what the owners below are owed. */
  credited: string;
  owners: Record<string, Owed>;
  /** Owners on the curve whose account turned out to be something other than a wallet. */
  notWallets: string[];

  totals: Totals;
  /** Unix seconds, by the chain's clock, of the last credit, the last payout and the last payment to the treasury. */
  creditedAt: number;
  paidAt: number;
  treasuryAt: number;
  /** The newest public lines as text. The ledger is brought up to these after every write of the books. */
  outbox: string[];
  /**
   * The newest slot in which a transaction of mine is known to have landed, or by which one was
   * known to be dead. Every reading of the chain is asked to be at least this new, so that what
   * the wallet holds is never read from a node that has not yet seen my own last payment.
   */
  after?: number;
  /** Set once a keeper the guardian replaced has paid out what it held and said so in the ledger: it does nothing more. `keeper` is who took its place. */
  retired?: { keeper: string; at: string };
};

const OUTBOX = 50;
const RECENT = 20;

const noTotals = (): Totals => ({ claimed: "0", treasury: { paid: "0", owed: "0" }, burn: { spent: "0", tokens: "0", owed: "0" }, holders: { paid: "0", owed: "0" }, fees: "0" });

export function newBooks(mint: PublicKey, keeper: PublicKey, now: number): Books {
  return {
    v: 1, mint: mint.toBase58(), keeper: keeper.toBase58(), seq: 0, last: "", stampedAt: 0, round: 0,
    read: null, before: "0", edict: null, inPool: [], buybackWaits: null, pending: null,
    pot: "0", credited: "0", owners: {}, notWallets: [],
    totals: noTotals(), creditedAt: now, paidAt: now, treasuryAt: now, outbox: [],
  };
}

export const plus = (text: string, amount: bigint) => (BigInt(text) + amount).toString();
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export const iso = (now: number) => new Date(now * 1000).toISOString();

/** Notes that something of the keeper's own happened by `slot`: no later reading may be older than it. */
export function happenedBy(books: Books, slot: number | undefined): void {
  if (slot !== undefined && slot > (books.after ?? 0)) books.after = slot;
}

/** Fee money in the keeper's wallet: claimed and not yet paid out. The keeper's own SOL, for network fees, is on top of this. */
export const inHand = (books: Books) => BigInt(books.totals.claimed) - BigInt(books.totals.treasury.paid) - BigInt(books.totals.burn.spent) - BigInt(books.totals.holders.paid);

/** Throws unless the three shares the books owe add up to the fee money in hand. */
export function mustAddUp(books: Books): void {
  const owed = BigInt(books.totals.treasury.owed) + BigInt(books.totals.burn.owed) + BigInt(books.pot) + BigInt(books.credited);
  if (owed !== inHand(books)) throw new Error(`my books do not add up: I owe ${owed} lamports and hold ${inHand(books)} of fees`);
  const credited = Object.values(books.owners).reduce((sum, entry) => sum + BigInt(entry.owed), 0n);
  if (credited !== BigInt(books.credited)) throw new Error(`my books do not add up: holders are owed ${credited} lamports one by one and ${books.credited} in all`);
}

/** Adds a line to the books' outbox, with the totals as they now stand. Nothing is public until the books are written and the ledger brought up to them. */
export function publish(books: Books, happened: Happened, now: number): Line {
  books.totals.holders.owed = (BigInt(books.pot) + BigInt(books.credited)).toString();
  // The chain's clock is read afresh after every step, and a fresh reading can be a second behind what the last one was carried forward to.
  books.stampedAt = Math.max(now, books.stampedAt);
  const line = { v: 1, seq: books.seq + 1, at: iso(books.stampedAt), prev: books.last, totals: structuredClone(books.totals), ...happened } satisfies Line;
  const text = JSON.stringify(line);
  books.seq = line.seq;
  books.last = sha256(text);
  books.outbox = [...books.outbox, text].slice(-OUTBOX);
  return line;
}

/** `lamports` shared the way a split says. The three parts add up to it exactly; what rounding leaves, a lamport or two, goes to holders. */
export function shared(lamports: bigint, split: { burnBps: number; treasuryBps: number }): { holders: bigint; burn: bigint; treasury: bigint } {
  const treasury = (lamports * BigInt(split.treasuryBps)) / 10_000n;
  const burn = (lamports * BigInt(split.burnBps)) / 10_000n;
  return { holders: lamports - treasury - burn, burn, treasury };
}

/** What a list of shares comes to for each of the three. */
export function sharesOf(shares: Share[]): { holders: bigint; burn: bigint; treasury: bigint; lamports: bigint } {
  const sum = { holders: 0n, burn: 0n, treasury: 0n, lamports: 0n };
  for (const share of shares) {
    const parts = shared(BigInt(share.lamports), share);
    sum.holders += parts.holders;
    sum.burn += parts.burn;
    sum.treasury += parts.treasury;
    sum.lamports += BigInt(share.lamports);
  }
  return sum;
}

/** A claim that landed: the fees it took out, edict by edict. The holders' share goes into the pot. */
export function recordClaim(books: Books, claim: { signature: string; shares: Share[]; fee: bigint }, now: number): Line {
  const { holders, burn, treasury, lamports } = sharesOf(claim.shares);
  books.pot = plus(books.pot, holders);
  books.totals.claimed = plus(books.totals.claimed, lamports);
  books.totals.burn.owed = plus(books.totals.burn.owed, burn);
  books.totals.treasury.owed = plus(books.totals.treasury.owed, treasury);
  books.totals.fees = plus(books.totals.fees, claim.fee);
  return publish(books, { kind: "claim", signature: claim.signature, lamports: lamports.toString(), shares: claim.shares, holders: holders.toString(), burn: burn.toString(), treasury: treasury.toString() }, now);
}

export function recordTreasury(books: Books, sent: { signature: string; lamports: bigint; to: string; fee: bigint }, now: number): Line {
  books.totals.treasury.owed = plus(books.totals.treasury.owed, -sent.lamports);
  books.totals.treasury.paid = plus(books.totals.treasury.paid, sent.lamports);
  books.totals.fees = plus(books.totals.fees, sent.fee);
  books.treasuryAt = now;
  return publish(books, { kind: "treasury", signature: sent.signature, lamports: sent.lamports.toString(), to: sent.to }, now);
}

/** A buyback that landed. `lamports` is what the buy cost; `tokens` everything the transaction burned, of which `found` was already in the account. */
export function recordBuyback(books: Books, bought: { signature: string; lamports: bigint; tokens: bigint; found: bigint; fee: bigint }, now: number): Line {
  books.totals.burn.owed = plus(books.totals.burn.owed, -bought.lamports);
  books.totals.burn.spent = plus(books.totals.burn.spent, bought.lamports);
  books.totals.burn.tokens = plus(books.totals.burn.tokens, bought.tokens);
  books.totals.fees = plus(books.totals.fees, bought.fee);
  return publish(books, { kind: "buyback", signature: bought.signature, lamports: bought.lamports.toString(), tokens: bought.tokens.toString(), burnSignature: bought.signature, ...(bought.found > 0n ? { found: bought.found.toString() } : {}) }, now);
}

/** The sha256 of who is owed what: "address lamports" a line, by address. Published with every credit, so the books cannot be rewritten later. */
export function booksHash(books: Books): string {
  const hash = createHash("sha256");
  for (const owner of Object.keys(books.owners).sort()) hash.update(`${owner} ${books.owners[owner].owed}\n`);
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------------------
// Files. A file that matters is written whole under another name, flushed, and renamed over
// the old one; a line is appended and flushed before anything is done that depends on it.
// ---------------------------------------------------------------------------------------

/** The keeper's folder. It holds `private/` and `public/`. */
export type Store = { dir: string };

/** A point where a test may stop the process, to see what a restart makes of it. */
export type Fault = (point: "intent recorded" | "plan written" | "attempts recorded" | "sent" | "outcomes recorded" | "books written" | "ledger written") => void;

export const booksPath = (store: Store) => join(store.dir, "private", "books.json");
export const ledgerPath = (store: Store) => join(store.dir, "public", "ledger.jsonl");
export const headPath = (store: Store) => join(store.dir, "public", "ledger-head.json");

function flushFolder(path: string) {
  // Makes a rename or a new file survive a power cut. Windows does not let a folder be opened; there it is skipped.
  try {
    const folder = openSync(path, "r");
    try { fsyncSync(folder); } finally { closeSync(folder); }
  } catch { /* not on this system */ }
}

export function writeWhole(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const file = openSync(`${path}.tmp`, "w");
  try { writeSync(file, text); fsyncSync(file); } finally { closeSync(file); }
  renameSync(`${path}.tmp`, path);
  flushFolder(dirname(path));
}

export function appendLines(path: string, lines: string[]) {
  mkdirSync(dirname(path), { recursive: true });
  const isNew = !existsSync(path);
  const file = openSync(path, "a");
  try { writeSync(file, lines.map((line) => `${line}\n`).join("")); fsyncSync(file); } finally { closeSync(file); }
  if (isNew) flushFolder(dirname(path));
}

/** Cuts off a last line that a crash left half written. Whatever depended on that line had not been done yet. */
export function dropTornLine(path: string) {
  if (!existsSync(path)) return;
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes[bytes.length - 1] === 10) return;
  truncateSync(path, bytes.lastIndexOf(10) + 1);
}

/** The last whole line of a file that may be large, read from its end. Null for an empty or missing file. */
function lastLine(path: string): string | null {
  if (!existsSync(path)) return null;
  const file = openSync(path, "r");
  try {
    const size = fstatSync(file).size;
    for (let span = 65_536; ; span *= 4) {
      const length = Math.min(span, size);
      const bytes = Buffer.alloc(length);
      readSync(file, bytes, 0, length, size - length);
      const lines = bytes.toString("utf8").split("\n").filter(Boolean);
      // The first piece may be the tail of a longer line, unless the read reached the start of the file.
      if (lines.length > 1 || length === size) return lines.at(-1) ?? null;
    }
  } finally { closeSync(file); }
}

/** Removes what a write that never got as far as its rename left behind: the file it was to replace is still whole. */
export function tidy(store: Store): void {
  for (const folder of ["private", "public"]) {
    const path = join(store.dir, folder);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) if (name.endsWith(".tmp")) unlinkSync(join(path, name));
  }
}

export const hasBooks = (store: Store) => existsSync(booksPath(store));

export function readBooks(store: Store): Books {
  return JSON.parse(readFileSync(booksPath(store), "utf8")) as Books;
}

/** Writes the books, then brings the public ledger up to them. */
export function writeBooks(store: Store, books: Books, fault?: Fault): void {
  writeWhole(booksPath(store), JSON.stringify(books));
  fault?.("books written");
  bringLedgerUp(store, books);
  fault?.("ledger written");
}

/** For the head, a payout keeps its first three transactions; the ledger has them all. */
const short = (line: Line): Line => (line.kind === "payout" ? { ...line, transactions: line.transactions.slice(0, 3) } : line);

/** Appends to the ledger the lines the books have and it does not, and replaces the head. Safe to run any number of times. */
export function bringLedgerUp(store: Store, books: Books): void {
  const path = ledgerPath(store);
  dropTornLine(path);
  const last = lastLine(path);
  const have = last ? (JSON.parse(last) as Line).seq : 0;
  const missing = books.outbox.filter((text) => (JSON.parse(text) as Line).seq > have);
  if (have > books.seq) throw new Error(`the ledger is at line ${have} and the books at ${books.seq}: these books are older than what was published`);
  if (have + missing.length !== books.seq) throw new Error(`the ledger stops at line ${have} and the books are at ${books.seq}: more is missing than the books kept`);
  if (missing.length > 0) appendLines(path, missing);
  const recent = books.outbox.slice(-RECENT).map((text) => short(JSON.parse(text) as Line));
  // The head says what the last line says. A network fee paid since then shows with the next line.
  const head: Head = { v: 1, mint: books.mint, keeper: books.keeper, seq: books.seq, at: recent.at(-1)?.at ?? "", last: books.last, totals: recent.at(-1)?.totals ?? noTotals(), recent };
  const text = JSON.stringify(head);
  if (existsSync(headPath(store)) && readFileSync(headPath(store), "utf8") === text) return;
  writeWhole(headPath(store), text);
}

// ---------------------------------------------------------------------------------------
// One keeper to a folder
// ---------------------------------------------------------------------------------------

/** Another keeper holds the folder. Nothing was read or written. */
export class AlreadyRunning extends Error {}

/** How often the process that holds the lock touches it, and how long a lock nobody touched is still believed. */
const BEAT_MS = 5_000;
const STALE_MS = 60_000;

const held = new Map<string, () => void>();

/**
 * Makes sure one keeper process works on a folder at a time. The first call takes the lock,
 * and the process keeps it until it ends; later calls from the same process do nothing.
 *
 * The lock is a file with the process's number in it, touched every few seconds. It is
 * believed while it is fresh and that process exists. A keeper that was killed leaves its file
 * behind: the next one sees the process is gone, or that nobody has touched the file for a
 * minute (the number may since have been given to some other process), and takes over.
 */
export function holdLock(store: Store): void {
  const path = join(store.dir, "private", "keeper.lock");
  if (held.has(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const file = openSync(path, "wx");
      try { writeSync(file, String(process.pid)); } finally { closeSync(file); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 3) throw error;
      const pid = Number(readFileSync(path, "utf8").trim() || NaN);
      const fresh = Date.now() - statSync(path).mtimeMs < STALE_MS;
      // My own number in the file is left from an earlier life of this machine: a process cannot have locked before it started.
      let there = pid !== process.pid;
      // Signal 0 sends nothing: it only asks whether the process is there.
      if (there && Number.isInteger(pid)) try { process.kill(pid, 0); } catch { there = false; }
      if (fresh && there) throw new AlreadyRunning(`a keeper is already running on ${store.dir} (process ${Number.isInteger(pid) ? pid : "unknown"})`);
      rmSync(path, { force: true });
    }
  }
  const beat = setInterval(() => {
    try { const now = new Date(); utimesSync(path, now, now); } catch { /* the next beat tries again */ }
  }, BEAT_MS);
  beat.unref();
  const release = () => {
    clearInterval(beat);
    held.delete(path);
    try { if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path); } catch { /* already gone */ }
  };
  held.set(path, release);
  process.once("exit", release);
}

/** Lets go of the folder before the process ends. Only a test needs this. */
export function releaseLock(store: Store): void {
  held.get(join(store.dir, "private", "keeper.lock"))?.();
}
