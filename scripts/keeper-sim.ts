// A rehearsal of the keeper against a made-up chain, with the process stopped at every point
// of a payout round a crash could come at.
//
//   npm run test:keeper
//
// It opens no connection. The chain here is a few maps in memory, so this checks the logic of
// the books, the journal and the recovery, not how a real node behaves: scripts/e2e-keeper.ts
// does that, against a validator.
//
// There are two made-up chains. The first, `MadeUpChain`, stands in for the handful of reads
// and the one write a payout round needs, and is what the crash sweeps run on. The second,
// `Net`, answers every call a whole round makes, the pool and the rulebook and the curve
// included, so that the keeper's own `turn` can be run from claim to payout.
import "../src/quiet.js";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveDbcPoolAddress, deriveDbcTokenVaultAddress, type DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetInstruction, ComputeBudgetProgram, type Connection, Keypair, PublicKey, SystemInstruction, SystemProgram, SYSVAR_CLOCK_PUBKEY, Transaction, TransactionInstruction, type VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { ruleOf } from "../site/hooks.js";
import { decodeRulebook, RULEBOOK_LEN, rulebookAddress, type Condition, type Rulebook, type Split } from "../src/hook.js";
import {
  AlreadyRunning, headPath, holdLock, inHand, ledgerPath, mustAddUp, newBooks, readBooks, recordBuyback, recordClaim, recordTreasury, releaseLock, shared, sharesOf, writeBooks,
  type Books, type Fault, type Head, type Line, type Store,
} from "../src/keeper/books.js";
import type { Chain, OwnerAccount, Status, TokenAccount } from "../src/keeper/chain.js";
import { admitted, count, opensIn, placesOf, room, takeFromPool, type Reading } from "../src/keeper/fees.js";
import { base58, creditHolders, due, knownSignatures, lapse, listHolders, minPayment, openRoundOf, payHolders, POOL_AUTHORITY, recover, strangers, type RunOptions, type Snapshot } from "../src/keeper/holders.js";
import { Retired, turn, type Hooks, type KeeperContext } from "../src/keeper/round.js";
import { DEFAULTS, plain, settingsFrom, type Settings } from "../src/keeper/settings.js";

const ROOT = join(tmpdir(), `keeper-sim-${process.pid}`);
const RENT = 650_240n;
const MIN = minPayment(DEFAULTS, RENT);
/** The keeper's own SOL in every scene, on top of the fees it keeps for others. */
const FLOAT = 1_000_000_000n;

class Crash extends Error {}

/** How the made-up network treats a transaction each time it is sent. */
type Network = {
  name: string;
  /** Whether this send reaches a block. `nth` counts the sends of this signature from 0; `generation` is which blockhash it carries, from 0. */
  takes: (nth: number, generation: number) => boolean;
  /** `send` throws even though the transaction went through. */
  sendThrows?: boolean;
  /** Six answers in ten about signatures come from a node far behind, which knows nothing recent. */
  laggingNode?: boolean;
  /** Blocks between a send and the block it lands in: one figure for all, or by how many payments the transaction carries. Without it, the next block. */
  delay?: number | ((payments: number) => number);
};

class MadeUpChain implements Chain {
  height = 10_000;
  slot = 20_000;
  funds = 0n;
  feesCharged = 0n;
  received = new Map<string, bigint>();
  landed = new Map<string, { height: number; slot: number; failed: boolean; payer: string }>();
  refused = new Set<string>();
  private blockhashes = new Map<string, { lastValid: number; generation: number }>();
  private waiting = new Map<string, { tx: Transaction; due: number }>();
  private sends = new Map<string, number>();
  private asked = 11;
  tokens: TokenAccount[] = [];
  owners = new Map<string, OwnerAccount>();
  /** How many of the next reads of the token accounts come back one account short. */
  shortReads = 0;
  /** The oldest slot the node still has a block for. Raised, the node has forgotten everything that landed before it. */
  forgotBefore = 0;
  /** Set, it is what the node asked for its oldest block answers: behind one address, that need not be the node that forgot. */
  oldestSaid: number | null = null;

  constructor(public network: Network) {}

  /** Time passes: blocks are made, and what was waiting for one of them lands in it if its blockhash is still good. */
  tick(blocks = 20) {
    for (const [signature, { tx, due }] of this.waiting) {
      if (due > this.height + blocks) continue;
      this.waiting.delete(signature);
      const { lastValid } = this.blockhashes.get(tx.recentBlockhash!)!;
      if (due > lastValid) continue;
      let [fee, total, refused] = [5_000n, 0n, false];
      const transfers: { to: string; lamports: bigint }[] = [];
      for (const ix of tx.instructions) {
        if (ix.programId.equals(ComputeBudgetProgram.programId)) {
          if (ComputeBudgetInstruction.decodeInstructionType(ix) === "SetComputeUnitLimit") fee += BigInt(Math.ceil((ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix).units * DEFAULTS.microLamportsPerUnit) / 1_000_000));
        } else if (ix.programId.equals(SystemProgram.programId)) {
          const { toPubkey, lamports } = SystemInstruction.decodeTransfer(ix);
          transfers.push({ to: toPubkey.toBase58(), lamports });
          total += lamports;
          if (this.refused.has(toPubkey.toBase58())) refused = true;
        }
      }
      if (this.funds < total + fee) refused = true;
      this.funds -= fee;
      this.feesCharged += fee;
      if (!refused) {
        this.funds -= total;
        for (const { to, lamports } of transfers) this.received.set(to, (this.received.get(to) ?? 0n) + lamports);
      }
      this.landed.set(signature, { height: due, slot: this.slot + due - this.height, failed: refused, payer: tx.feePayer!.toBase58() });
    }
    this.height += blocks;
    this.slot += blocks;
  }

  // Finality trails the newest block by a few.
  private get finalHeight() { return this.height - 5; }

  async tokenAccounts() {
    const accounts = this.shortReads-- > 0 ? this.tokens.slice(1) : this.tokens;
    return { slot: this.slot - 5, accounts };
  }
  async supply() { return { slot: this.slot - 5, amount: this.tokens.reduce((sum, account) => sum + account.amount, 0n) }; }
  async ownerAccounts(owners: string[]) { return owners.map((owner) => this.owners.get(owner) ?? null); }
  async rentExemptMinimum() { return RENT; }
  async balance() { return this.funds; }
  async latestBlockhash() {
    const blockhash = Keypair.generate().publicKey.toBase58();
    this.blockhashes.set(blockhash, { lastValid: this.height + 150, generation: this.blockhashes.size });
    return { blockhash, lastValidBlockHeight: this.height + 150, slot: this.slot };
  }
  async send(raw: Uint8Array) {
    const tx = Transaction.from(raw);
    if (!tx.verifySignatures()) throw new Error("bad signature");
    const signature = createHash("sha256").update(tx.signature!).digest("hex");
    const nth = this.sends.get(signature) ?? 0;
    this.sends.set(signature, nth + 1);
    const { generation } = this.blockhashes.get(tx.recentBlockhash!)!;
    const payments = tx.instructions.filter((ix) => ix.programId.equals(SystemProgram.programId)).length;
    const delay = typeof this.network.delay === "function" ? this.network.delay(payments) : (this.network.delay ?? 0);
    if (!this.landed.has(signature) && !this.waiting.has(signature) && this.network.takes(nth, generation)) this.waiting.set(signature, { tx, due: this.height + 1 + delay });
    if (this.network.sendThrows) throw new Error("the connection dropped");
  }
  async statuses(signatures: string[]) {
    // The keeper names a signature in base58; here it is looked up by its bytes.
    this.asked = (this.asked * 1_103_515_245 + 12_345) % 2_147_483_648;
    const lagging = this.network.laggingNode === true && this.asked % 100 < 60;
    const statuses = signatures.map((text): Status | null => {
      const found = this.landed.get(createHash("sha256").update(unbase58(text)).digest("hex"));
      if (!found || lagging || found.slot < this.forgotBefore) return null;
      return { slot: found.slot, failed: found.failed, finalized: found.height <= this.finalHeight };
    });
    return { slot: lagging ? this.slot - 1_000 : this.slot, statuses };
  }
  async finalized() { return { slot: this.slot - 5, blockHeight: this.finalHeight }; }
  async firstAvailableSlot() { return this.oldestSaid ?? this.forgotBefore; }
  async history() { return [...this.landed].map(([signature, found]) => ({ signature, failed: found.failed })); }
  async feePayer(signature: string) { return this.landed.get(signature)?.payer ?? null; }
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function unbase58(text: string): Buffer {
  let value = 0n;
  for (const character of text) value = value * 58n + BigInt(ALPHABET.indexOf(character));
  const bytes: number[] = [];
  for (; value > 0n; value >>= 8n) bytes.unshift(Number(value & 0xffn));
  for (const character of text) { if (character !== "1") break; bytes.unshift(0); }
  return Buffer.from(bytes);
}

let failures = 0;
let checks = 0;
function check(ok: boolean, what: string) {
  checks += 1;
  if (!ok) { failures += 1; console.log(`  FAILED: ${what}`); }
}

const NOBODY_LEFT_OUT = () => ({ pool: { owners: 0, tokens: 0n }, project: { owners: 0, tokens: 0n }, nobody: { owners: 0, tokens: 0n }, program: { owners: 0, tokens: 0n }, "not-a-wallet": { owners: 0, tokens: 0n } });

/** Books with a pot already credited: `count` holders owed enough to be paid, and three owed too little. */
function scene(name: string, network: Network, count: number) {
  const dir = join(ROOT, name.replace(/[^a-z0-9]+/gi, "-"));
  rmSync(dir, { recursive: true, force: true });
  const store: Store = { dir };
  const keeper = Keypair.generate();
  const chain = new MadeUpChain(network);
  const now = 1_800_000_000;
  const books = newBooks(Keypair.generate().publicKey, keeper.publicKey, now);
  const owners = Array.from({ length: count + 3 }, () => Keypair.generate().publicKey.toBase58());
  // The last three hold a millionth of what the others hold.
  const snapshot: Snapshot = {
    slot: 1, supply: 0n, eligible: 0n, learned: {}, leftOut: NOBODY_LEFT_OUT(),
    holders: owners.map((owner, i) => ({ owner, amount: i < count ? BigInt(1_000_000 + i * 37_000) : 1n })).sort((a, b) => (a.owner < b.owner ? -1 : 1)),
  };
  snapshot.eligible = snapshot.holders.reduce((sum, holder) => sum + holder.amount, 0n);
  const claimed = BigInt(count) * 5_000_000n;
  recordClaim(books, { signature: "claim-1", shares: [{ epoch: 1, lamports: (claimed * 2n).toString(), holdersBps: 5_000, burnBps: 1_000, treasuryBps: 4_000 }], fee: 5_000n }, now);
  creditHolders(books, snapshot, now);
  writeBooks(store, books);
  // The wallet holds the fees it claimed and SOL of its own for the network.
  chain.funds = claimed * 2n + FLOAT;
  const planned = new Map(Object.entries(books.owners).filter(([, entry]) => BigInt(entry.owed) >= MIN).map(([owner, entry]) => [owner, BigInt(entry.owed)]));
  return { store, keeper, chain, now, planned, owedBefore: structuredClone(books.owners), claimed: claimed * 2n, float: FLOAT };
}

type Scene = ReturnType<typeof scene>;

const options = (chain: MadeUpChain, fault?: Fault): RunOptions => ({ sleep: async () => chain.tick(), fault, settings: { inFlight: 2 } });

/** After everything: each holder was sent what was planned exactly once, and the books and the ledger say the same. */
function verify(s: Scene, label: string, expectUnpaid: string[] = []): number {
  const books = readBooks(s.store);
  let paid = 0n;
  let waiting = 0;
  for (const [owner, lamports] of s.planned) {
    const got = s.chain.received.get(owner) ?? 0n;
    const owed = BigInt(books.owners[owner]?.owed ?? "0");
    // Sent in full once, or not sent and still owed in full. Never anything else.
    check(got === lamports || got === 0n, `${label}: a holder owed ${lamports} was sent ${got}`);
    check(got + owed === lamports, `${label}: a holder was sent ${got} and is still owed ${owed}, of ${lamports}`);
    if (expectUnpaid.includes(owner)) check(got === 0n, `${label}: ${owner} was to be left unpaid and got ${got}`);
    else if (got === 0n) waiting += 1;
    paid += got;
  }
  for (const [owner, got] of s.chain.received) check(s.planned.has(owner), `${label}: ${got} went to somebody who was not in the plan`);
  for (const [owner, entry] of Object.entries(s.owedBefore)) {
    if (!s.planned.has(owner)) check(books.owners[owner]?.owed === entry.owed, `${label}: a holder owed too little to send is still owed it`);
  }
  check(books.totals.holders.paid === paid.toString(), `${label}: the books say ${books.totals.holders.paid} was paid and the chain says ${paid}`);
  let addsUp = true;
  try { mustAddUp(books); } catch { addsUp = false; }
  check(addsUp, `${label}: what the books owe adds up to the fees in hand, one by one and in all`);
  // The first line is the claim, whose fee the made-up chain never saw.
  check(BigInt(books.totals.fees) - 5_000n === s.chain.feesCharged, `${label}: the books count ${books.totals.fees} of fees, the chain charged ${s.chain.feesCharged}`);
  // The network fees came out of the keeper's own SOL, and the wallet still holds every lamport of fees it keeps for others.
  check(s.chain.funds === inHand(books) + s.float - s.chain.feesCharged, `${label}: the wallet holds the fees still owed and the keeper's own SOL, less the network fees`);

  const lines = readFileSync(ledgerPath(s.store), "utf8").split("\n").filter(Boolean);
  let prev = "";
  lines.forEach((text, i) => {
    const line = JSON.parse(text) as Line;
    check(line.seq === i + 1 && line.prev === prev, `${label}: line ${i + 1} of the ledger follows the one before`);
    prev = createHash("sha256").update(text).digest("hex");
  });
  const payouts = lines.map((text) => JSON.parse(text) as Line).filter((line) => line.kind === "payout");
  check(payouts.length === books.round, `${label}: the ledger has ${payouts.length} payout lines for ${books.round} rounds`);
  const transactions = payouts.flatMap((payout) => payout.transactions);
  check(payouts.reduce((sum, payout) => sum + BigInt(payout.lamports), 0n) === paid, `${label}: the payout lines add up to what was sent`);
  check(transactions.reduce((sum, tx) => sum + BigInt(tx.lamports), 0n) === paid, `${label}: their transactions add up to it too`);
  const good = [...s.chain.landed].filter(([, found]) => !found.failed).length;
  check(transactions.length === good && new Set(transactions.map((tx) => tx.signature)).size === good, `${label}: they list ${transactions.length} transactions and ${good} landed`);
  const head = JSON.parse(readFileSync(headPath(s.store), "utf8")) as Head;
  check(head.seq === books.seq && head.last === prev && head.totals.holders.paid === paid.toString() && JSON.stringify(head.totals) === JSON.stringify((JSON.parse(lines.at(-1)!) as Line).totals), `${label}: the head file is at the last line`);
  check(!readdirSync(join(s.store.dir, "private")).some((name) => name.startsWith("round-")), `${label}: no round is left open`);
  return waiting;
}

let putOffRounds = 0;

/** Checks a finished round. Holders it put off are paid by the next round, on a network that works, and checked again. */
async function verifyToTheEnd(s: Scene, label: string): Promise<void> {
  if (verify(s, label) === 0) return;
  putOffRounds += 1;
  const network = s.chain.network;
  s.chain.network = NETWORKS[0];
  await payHolders(s.store, s.chain, s.keeper, s.now, options(s.chain));
  s.chain.network = network;
  check(verify(s, `${label}, next round`) === 0, `${label}: the next round pays whoever was put off`);
}

const NETWORKS: Network[] = [
  { name: "a network that takes everything", takes: () => true },
  { name: "a network that loses the first send of everything", takes: (nth) => nth > 0 },
  { name: "a network that loses everything signed with the first two blockhashes", takes: (_, generation) => generation > 1 },
  { name: "a node whose send fails although the transaction went through", takes: () => true, sendThrows: true },
  { name: "a pool of nodes where most are far behind", takes: () => true, laggingNode: true },
  { name: "a lagging pool that also loses first sends", takes: (nth) => nth > 0, laggingNode: true },
  { name: "a slow network, where a transaction lands fifty blocks after it is sent", takes: () => true, delay: 50 },
  { name: "a slow network with a lagging pool that loses first sends", takes: (nth) => nth > 0, laggingNode: true, delay: 70 },
];
const POINTS: Parameters<Fault>[0][] = ["plan written", "attempts recorded", "sent", "outcomes recorded", "books written", "ledger written"];

// ---------------------------------------------------------------------------------------------
// The fee side: a rulebook and a reading, made up
// ---------------------------------------------------------------------------------------------

const NOW = 1_800_000_030; // 30 seconds into an even minute
const SUPPLY = 1_000_000_000n * 1_000_000n;
const TOKEN = 1_000_000n;
const EVEN: Split = { holdersBps: 3_000, burnBps: 3_000, treasuryBps: 4_000 };
const FUNDING: Split = { holdersBps: 2_500, burnBps: 2_500, treasuryBps: 5_000 };

/** A rulebook as the chain would hold it, written by the offsets in programs/hook/src/state.rs. */
function book(p: { rule?: Condition[]; until?: number; epoch?: number; split?: Split; paused?: boolean; exempt?: PublicKey }): Rulebook {
  const data = Buffer.alloc(RULEBOOK_LEN);
  data[0] = 4;
  data[2] = p.paused ? 1 : 0;
  (p.exempt ?? PublicKey.default).toBuffer().copy(data, 136);
  data.writeBigInt64LE(BigInt(p.until ?? 0), 216);
  const split = p.split ?? EVEN;
  data.writeUInt16LE(split.holdersBps, 224);
  data.writeUInt16LE(split.burnBps, 226);
  data.writeUInt16LE(split.treasuryBps, 228);
  data.writeBigUInt64LE(BigInt(p.epoch ?? 1), 232);
  data.writeBigInt64LE(BigInt(NOW - 60), 240);
  const rule = p.rule ?? [];
  data[280] = rule.length;
  rule.forEach((condition, i) => {
    const at = 288 + i * 12;
    data[at] = condition.group;
    data[at + 1] = condition.fact;
    data[at + 2] = condition.op;
    data.writeBigUInt64LE(condition.value, at + 4);
  });
  return decodeRulebook(data);
}

const places = placesOf({ hookProgram: Keypair.generate().publicKey, mint: Keypair.generate().publicKey, pool: Keypair.generate().publicKey, keeper: Keypair.generate().publicKey, treasury: Keypair.generate().publicKey });
const reading = (p: { slot?: number; total?: bigint; waiting?: bigint; book: Rulebook }): Reading => ({
  slot: p.slot ?? 1_000, now: NOW, book: p.book, supply: SUPPLY, inBurnAccount: 0n, hasBurnAccount: true, inSolVault: 50_000_000_000n, keeperLamports: 10_000_000_000n,
  fees: { waiting: p.waiting ?? p.total ?? 0n, total: p.total ?? 0n, creatorWaiting: 0n, config: places.mint, mint: places.mint, solVault: places.solVault },
});

// ---------------------------------------------------------------------------------------------
// A made-up network for whole rounds
// ---------------------------------------------------------------------------------------------

const SOL = 1_000_000_000n;
/** Blocks between a block and its being final. */
const FINAL_AFTER = 32;
/** What a token account's rent comes to here, and the least an account with no data may hold. */
const TOKEN_RENT = 2_108_880n;
const WALLET_RENT = 890_880n;
/** The made-up curve: a buy is the one instruction it has. */
const CURVE = Keypair.generate().publicKey;

/** Who holds what of the token from one slot on. */
type TokenState = { slot: number; holders: Map<string, bigint>; poolTokens: bigint; burn: bigint; hasBurn: boolean };
/** A transaction in a block, as a node shows it. */
type InBlock = { signature: string; slot: number; height: number; err: unknown; keys: PublicKey[]; vaultBefore: bigint; vaultAfter: bigint };

/**
 * One object that answers every RPC call `turn` makes, as a web3.js Connection would, and
 * stands in for the Meteora client. It keeps blocks and their finality, a pool with its fee
 * counters, a rulebook, token balances by slot and every wallet's lamports.
 *
 * It is a model, not a validator: it shows what the keeper's own logic does with the answers
 * it is given, not how a node behaves.
 */
class Net {
  slot = 5_000;
  height = 4_000;
  private clock = 1_800_000_000;
  /** Lamports by address. An address with none has no account. */
  lamports = new Map<string, bigint>();
  /** Accounts that are not wallets: the program that owns each, and how many bytes it holds. */
  others = new Map<string, { owner: PublicKey; data: number }>();

  hookProgram = Keypair.generate().publicKey;
  mint = Keypair.generate().publicKey;
  config = Keypair.generate().publicKey;
  pool = deriveDbcPoolAddress(NATIVE_MINT, this.mint, this.config);
  solVault = deriveDbcTokenVaultAddress(this.pool, NATIVE_MINT);
  burnAccount: PublicKey;

  /** The pool's two fee counters, and the SOL in its vault. */
  total = 0n;
  waiting = 0n;
  vault = 10n * SOL;
  /** Lamports per base unit of the token, as a fraction. */
  private price = { num: 30_000n, den: 1_000_000_000n };
  private tokenLog: TokenState[] = [];

  /** The keeper the rulebook names. The guardian can put another in. */
  named: PublicKey;
  /** When set, the hook refuses every buy by the keeper. */
  hookRefuses = false;

  inBlocks = new Map<string, InBlock>();
  private queue = new Map<string, { tx: Transaction; due: number }>();
  private blockhashes = new Map<string, number>();
  feesCharged = 0n;
  rentPaid = 0n;

  /** Signatures and transactions from blocks before this slot are "never seen". */
  forgotBefore = 0;
  /** What the node asked for its oldest block answers. Behind one address it need not be the node that forgot. */
  oldestSaid = 0;
  /** Called when a transaction has gone through, with what it did: a scene acts the moment something shows. */
  onLanded: ((did: string[]) => void) | null = null;

  constructor(private keeper: PublicKey, holders: Map<string, bigint>, supply = SUPPLY) {
    this.named = keeper;
    this.burnAccount = getAssociatedTokenAddressSync(this.mint, keeper, false, TOKEN_2022_PROGRAM_ID);
    const held = [...holders.values()].reduce((sum, amount) => sum + amount, 0n);
    this.tokenLog.push({ slot: 0, holders: new Map(holders), poolTokens: supply - held, burn: 0n, hasBurn: false });
  }

  // ---- what there is --------------------------------------------------------------------------

  get tokens(): TokenState { return this.tokenLog.at(-1)!; }
  private tokensAt(slot: number): TokenState { return [...this.tokenLog].reverse().find((state) => state.slot <= slot) ?? this.tokenLog[0]; }
  /** The token balances, ready to be changed in this slot. */
  private change(): TokenState {
    const last = this.tokens;
    if (last.slot === this.slot) return last;
    const next = { ...last, slot: this.slot, holders: new Map(last.holders) };
    this.tokenLog.push(next);
    return next;
  }
  supplyOf = (state: TokenState) => state.poolTokens + state.burn + [...state.holders.values()].reduce((sum, amount) => sum + amount, 0n);
  balance = (address: PublicKey | string) => this.lamports.get(typeof address === "string" ? address : address.toBase58()) ?? 0n;
  private move(address: string, by: bigint) { this.lamports.set(address, this.balance(address) + by); }
  get now() { return Math.floor(this.clock); }
  /** Time passes with nobody watching. */
  wait(seconds: number) { this.clock += seconds; }

  /** Fees worth `lamports` to the project come in, from trades that leave everybody holding what they held. */
  fees(lamports: bigint) { this.total += lamports; this.waiting += lamports; this.vault += lamports; }
  /** The project's part of the 3% a trade of `gross` lamports pays. */
  private takeFee(gross: bigint) {
    this.vault += gross;
    const ours = (gross * 3n * 80n) / 10_000n;
    this.total += ours;
    this.waiting += ours;
  }
  /** Somebody buys from the curve with `gross` lamports. Returns the tokens they got. */
  buy(owner: string, gross: bigint): bigint {
    const tokens = (gross * 97n * this.price.den) / (100n * this.price.num);
    const state = this.change();
    state.holders.set(owner, (state.holders.get(owner) ?? 0n) + tokens);
    state.poolTokens -= tokens;
    this.takeFee(gross);
    return tokens;
  }
  /** What `tokens` cost at the price of this moment, the 3% fee included. */
  private costOf(tokens: bigint): bigint {
    return (tokens * this.price.num * 100n + this.price.den * 97n - 1n) / (this.price.den * 97n);
  }
  /** The keeper named in the first one's place claims `lamports` of the fees that are waiting. */
  claimedByAnother(lamports: bigint) { this.waiting -= lamports; this.vault -= lamports; }

  // ---- blocks ---------------------------------------------------------------------------------

  tick(blocks = 1) {
    for (let i = 0; i < blocks; i++) {
      this.height += 1;
      this.slot += 1;
      this.clock += 0.4;
      for (const [signature, { tx, due }] of this.queue) {
        if (due > this.height) continue;
        this.queue.delete(signature);
        if (this.height <= this.blockhashes.get(tx.recentBlockhash!)!) this.land(signature, tx);
      }
    }
  }
  private isFinal = (tx: InBlock) => this.height - tx.height >= FINAL_AFTER;

  private feeOf(tx: Transaction): bigint {
    let [units, price] = [200_000 * tx.instructions.length, 0];
    for (const ix of tx.instructions) {
      if (!ix.programId.equals(ComputeBudgetProgram.programId)) continue;
      const kind = ComputeBudgetInstruction.decodeInstructionType(ix);
      if (kind === "SetComputeUnitLimit") units = ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix).units;
      if (kind === "SetComputeUnitPrice") price = Number(ComputeBudgetInstruction.decodeSetComputeUnitPrice(ix).microLamports);
    }
    return 5_000n + BigInt(Math.ceil((units * price) / 1_000_000));
  }

  /** Runs a transaction's instructions. With `keep` false, or if one fails, everything is put back: that is a rehearsal, or a transaction that failed. */
  private run(tx: Transaction, keep: boolean): { err: unknown; logs: string[]; did: string[]; vaultBefore: bigint; vaultAfter: bigint } {
    const before = { lamports: new Map(this.lamports), total: this.total, waiting: this.waiting, vault: this.vault, rentPaid: this.rentPaid, log: this.tokenLog.map((state) => ({ ...state, holders: new Map(state.holders) })) };
    const payer = tx.feePayer!.toBase58();
    const [logs, did]: [string[], string[]] = [[], []];
    let err: unknown = null;
    tx.instructions.some((ix, at) => {
      const fail = (reason: unknown) => { err = { InstructionError: [at, reason] }; return true; };
      const refuse = (code: number) => { logs.push(`Program ${this.hookProgram.toBase58()} failed: custom program error: 0x${code.toString(16)}`); return fail({ Custom: code }); };
      if (ix.programId.equals(ComputeBudgetProgram.programId) || ix.programId.equals(TOKEN_PROGRAM_ID)) return false;
      if (ix.programId.equals(SystemProgram.programId)) {
        const { fromPubkey, toPubkey, lamports } = SystemInstruction.decodeTransfer(ix);
        did.push("transfer");
        // A transfer to an account that is not a wallet goes through all the same: that is the danger.
        if (this.balance(fromPubkey) < lamports) return fail({ Custom: 1 });
        this.move(fromPubkey.toBase58(), -lamports);
        this.move(toPubkey.toBase58(), lamports);
        return false;
      }
      if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
        // Only the keeper's token account costs rent that stays. Its wrapped-SOL account is opened and closed in one transaction.
        if (ix.keys[1].pubkey.equals(this.burnAccount) && !this.tokens.hasBurn) {
          if (this.balance(payer) < TOKEN_RENT) return fail({ Custom: 1 });
          this.move(payer, -TOKEN_RENT);
          this.rentPaid += TOKEN_RENT;
          this.change().hasBurn = true;
        }
        return false;
      }
      if (ix.programId.equals(TOKEN_2022_PROGRAM_ID)) {
        // 15 is BurnChecked.
        if (ix.data[0] !== 15) return false;
        const amount = ix.data.readBigUInt64LE(1);
        did.push("burn");
        if (this.tokens.burn < amount) return fail({ Custom: 1 });
        this.change().burn -= amount;
        return false;
      }
      if (ix.programId.equals(this.hookProgram) && ix.data[0] === 8) {
        // claim_fees: the keeper signs first, and the most to claim in SOL is the second amount.
        if (!ix.keys[0].pubkey.equals(this.named)) return refuse(19);
        const most = ix.data.readBigUInt64LE(9);
        const claimed = this.waiting < most ? this.waiting : most;
        did.push("claim");
        this.waiting -= claimed;
        this.vault -= claimed;
        this.move(ix.keys[0].pubkey.toBase58(), claimed);
        return false;
      }
      if (ix.programId.equals(CURVE)) {
        const [tokens, atMost] = [ix.data.readBigUInt64LE(0), ix.data.readBigUInt64LE(8)];
        if (this.hookRefuses) return refuse(1);
        const gross = this.costOf(tokens);
        if (gross > atMost) return fail({ Custom: 6002 });
        if (this.balance(payer) < gross) return fail({ Custom: 1 });
        did.push("buy");
        this.move(payer, -gross);
        const state = this.change();
        state.poolTokens -= tokens;
        state.burn += tokens;
        this.takeFee(gross);
        return false;
      }
      return fail("UnsupportedProgramId");
    });
    const vaultAfter = err === null ? this.vault : before.vault;
    if (err !== null || !keep) {
      this.lamports = before.lamports;
      [this.total, this.waiting, this.vault, this.rentPaid, this.tokenLog] = [before.total, before.waiting, before.vault, before.rentPaid, before.log];
    }
    return { err, logs, did, vaultBefore: before.vault, vaultAfter };
  }

  private land(signature: string, tx: Transaction) {
    const fee = this.feeOf(tx);
    const payer = tx.feePayer!.toBase58();
    // A payer that cannot pay the fee never gets into a block.
    if (this.balance(payer) < fee) return;
    this.move(payer, -fee);
    this.feesCharged += fee;
    const { err, did, vaultBefore, vaultAfter } = this.run(tx, true);
    const keys = [tx.feePayer!, ...tx.instructions.flatMap((ix) => [...ix.keys.map((key) => key.pubkey), ix.programId])].filter((key, i, all) => all.findIndex((other) => other.equals(key)) === i);
    this.inBlocks.set(signature, { signature, slot: this.slot, height: this.height, err, keys, vaultBefore, vaultAfter });
    if (err === null) this.onLanded?.(did);
  }

  /** A transaction the keeper's key pays for and the keeper's records do not have: what a second copy of the keeper would leave. */
  async byAnotherCopy(keeper: Keypair): Promise<void> {
    const { value } = await this.connection.getLatestBlockhashAndContext();
    const tx = new Transaction({ feePayer: keeper.publicKey, ...value }).add(SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: keeper.publicKey, lamports: 1 }));
    tx.sign(keeper);
    await this.connection.sendRawTransaction(tx.serialize());
    this.tick(1);
  }

  // ---- the Connection, as far as the keeper uses it --------------------------------------------

  private notYet(config?: { minContextSlot?: number }) {
    if (config?.minContextSlot && config.minContextSlot > this.slot) throw new Error("Minimum context slot has not been reached");
  }

  private poolData(): Buffer {
    const data = Buffer.alloc(424);
    Buffer.from([237, 219, 184, 23, 42, 189, 169, 35]).copy(data, 0);
    this.config.toBuffer().copy(data, 72);
    this.mint.toBuffer().copy(data, 136);
    this.solVault.toBuffer().copy(data, 200);
    data.writeBigUInt64LE(this.waiting, 272);
    data.writeBigUInt64LE(this.total, 336);
    return data;
  }
  /** A rulebook with no rule and a 30 / 30 / 40 split, by the offsets in programs/hook/src/state.rs. */
  private bookData(): Buffer {
    const data = Buffer.alloc(RULEBOOK_LEN);
    data[0] = 4;
    this.mint.toBuffer().copy(data, 8);
    data.writeUInt16LE(EVEN.holdersBps, 224);
    data.writeUInt16LE(EVEN.burnBps, 226);
    data.writeUInt16LE(EVEN.treasuryBps, 228);
    data[481] = 1;
    data.write("Veluno", 512);
    data.write("VELUNO", 544);
    this.named.toBuffer().copy(data, 864);
    return data;
  }

  connection = {
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[], config?: { minContextSlot?: number }) => {
      this.notYet(config);
      const state = this.tokens;
      const account = (data: Buffer, lamports = 1_000_000) => ({ data, lamports, owner: SystemProgram.programId, executable: false });
      const value = keys.map((key) => {
        if (key.equals(this.pool)) return account(this.poolData());
        if (key.equals(rulebookAddress(this.hookProgram, this.mint))) return account(this.bookData());
        if (key.equals(SYSVAR_CLOCK_PUBKEY)) { const data = Buffer.alloc(40); data.writeBigInt64LE(BigInt(this.now), 32); return account(data); }
        if (key.equals(this.mint)) { const data = Buffer.alloc(82); data.writeBigUInt64LE(this.supplyOf(state), 36); return account(data); }
        if (key.equals(this.burnAccount)) { if (!state.hasBurn) return null; const data = Buffer.alloc(175); data.writeBigUInt64LE(state.burn, 64); return account(data); }
        if (key.equals(this.solVault)) { const data = Buffer.alloc(165); data.writeBigUInt64LE(this.vault, 64); return account(data); }
        if (key.equals(this.keeper)) return this.balance(key) > 0n ? account(Buffer.alloc(0), Number(this.balance(key))) : null;
        return null;
      });
      return { context: { slot: this.slot }, value };
    },
    // The token accounts and the supply are read from finalized blocks: as they stood a while ago.
    getProgramAccounts: async () => {
      const slot = this.slot - FINAL_AFTER;
      const state = this.tokensAt(slot);
      const entry = (owner: string, amount: bigint) => {
        const data = Buffer.alloc(40);
        new PublicKey(owner).toBuffer().copy(data, 0);
        data.writeBigUInt64LE(amount, 32);
        return { pubkey: Keypair.generate().publicKey, account: { data } };
      };
      const value = [entry(POOL_AUTHORITY, state.poolTokens), ...[...state.holders].map(([owner, amount]) => entry(owner, amount))];
      if (state.hasBurn) value.push(entry(this.keeper.toBase58(), state.burn));
      return { context: { slot }, value };
    },
    getAccountInfoAndContext: async (key: PublicKey) => {
      const slot = this.slot - FINAL_AFTER;
      const data = Buffer.alloc(8);
      data.writeBigUInt64LE(this.supplyOf(this.tokensAt(slot)));
      return { context: { slot }, value: key.equals(this.mint) ? { owner: TOKEN_2022_PROGRAM_ID, data } : null };
    },
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((key) => {
        const other = this.others.get(key.toBase58());
        if (other) return { owner: other.owner, data: Buffer.alloc(Math.min(other.data, 1)), executable: false };
        return this.balance(key) > 0n ? { owner: SystemProgram.programId, data: Buffer.alloc(0), executable: false } : null;
      }),
    getMinimumBalanceForRentExemption: async (length: number) => Number(length === 0 ? WALLET_RENT : TOKEN_RENT),
    getBalance: async (key: PublicKey, config?: { minContextSlot?: number }) => { this.notYet(config); return Number(this.balance(key)); },
    getSlot: async () => this.slot,
    getBlockTime: async () => this.now,
    getLatestBlockhashAndContext: async () => {
      const blockhash = Keypair.generate().publicKey.toBase58();
      this.blockhashes.set(blockhash, this.height + 150);
      return { context: { slot: this.slot }, value: { blockhash, lastValidBlockHeight: this.height + 150 } };
    },
    sendRawTransaction: async (raw: Uint8Array) => {
      const tx = Transaction.from(raw);
      const signature = base58(tx.signature!);
      if (!this.inBlocks.has(signature) && !this.queue.has(signature) && this.blockhashes.has(tx.recentBlockhash!)) this.queue.set(signature, { tx, due: this.height + 1 });
      return signature;
    },
    simulateTransaction: async (given: VersionedTransaction) => {
      const tx = Transaction.from(Buffer.from(given.serialize()));
      if (this.balance(tx.feePayer!) < this.feeOf(tx)) return { value: { err: "InsufficientFundsForFee", logs: [] } };
      const { err, logs } = this.run(tx, false);
      return { value: { err, logs } };
    },
    getSignatureStatuses: async (signatures: string[]) => ({
      context: { slot: this.slot },
      value: signatures.map((signature) => {
        const tx = this.inBlocks.get(signature);
        if (!tx || tx.slot < this.forgotBefore) return null;
        return { slot: tx.slot, err: tx.err, confirmationStatus: this.isFinal(tx) ? "finalized" : "confirmed" };
      }),
    }),
    getEpochInfo: async () => ({ absoluteSlot: this.slot - FINAL_AFTER, blockHeight: this.height - FINAL_AFTER }),
    getFirstAvailableBlock: async () => this.oldestSaid,
    // What was asked for at "confirmed" shows as soon as a block has it, and at "finalized" some thirty blocks later.
    getSignaturesForAddress: async (address: PublicKey, options: { limit?: number }, commitment?: string) =>
      [...this.inBlocks.values()]
        .filter((tx) => tx.keys.some((key) => key.equals(address)) && (commitment === "confirmed" || this.isFinal(tx)) && tx.slot >= this.forgotBefore)
        .reverse()
        .slice(0, options.limit ?? 1_000)
        .map((tx) => ({ signature: tx.signature, err: tx.err, slot: tx.slot })),
    getTransaction: async (signature: string, options: { commitment?: string }) => {
      const tx = this.inBlocks.get(signature);
      if (!tx || tx.slot < this.forgotBefore || (options.commitment === "finalized" && !this.isFinal(tx))) return null;
      const at = tx.keys.findIndex((key) => key.equals(this.solVault));
      const held = (amount: bigint) => (at < 0 ? [] : [{ accountIndex: at, uiTokenAmount: { amount: amount.toString() } }]);
      return { slot: tx.slot, meta: { err: tx.err, preTokenBalances: held(tx.vaultBefore), postTokenBalances: held(tx.vaultAfter) }, transaction: { message: { staticAccountKeys: tx.keys } } };
    },
  };

  /** The Meteora client, as far as the buyback uses it: a quote at the price of this moment, and a buy this network understands. */
  dbc = {
    connection: this.connection,
    state: {
      getPool: async () => ({ poolState: { config: this.config } }),
      getPoolConfig: async () => ({ activationType: 0 }),
    },
    pool: {
      swapQuote2: (p: { swapMode: SwapMode; amountIn?: BN; amountOut?: BN; slippageBps: number }) => {
        const slip = BigInt(p.slippageBps);
        if (p.swapMode === SwapMode.ExactIn) {
          const out = (BigInt(p.amountIn!.toString()) * 97n * this.price.den) / (100n * this.price.num);
          return { outputAmount: new BN(out.toString()), minimumAmountOut: new BN(((out * (10_000n - slip)) / 10_000n).toString()) };
        }
        const cost = this.costOf(BigInt(p.amountOut!.toString()));
        return { includedFeeInputAmount: new BN(cost.toString()), maximumAmountIn: new BN(((cost * (10_000n + slip)) / 10_000n).toString()) };
      },
      swap2WithTransferHook: async (p: { owner: PublicKey; amountOut: BN; maximumAmountIn: BN }) => {
        const data = Buffer.alloc(16);
        data.writeBigUInt64LE(BigInt(p.amountOut.toString()), 0);
        data.writeBigUInt64LE(BigInt(p.maximumAmountIn.toString()), 8);
        const keys = [{ pubkey: p.owner, isSigner: true, isWritable: true }, { pubkey: this.solVault, isSigner: false, isWritable: true }, { pubkey: this.burnAccount, isSigner: false, isWritable: true }];
        return new Transaction().add(new TransactionInstruction({ programId: CURVE, data, keys }));
      },
    },
  };
}

/** A token on the made-up network with a keeper's folder beside it. */
type World = {
  net: Net;
  ctx: KeeperContext;
  hooks: Hooks;
  store: Store;
  keeper: Keypair;
  treasury: PublicKey;
  holders: string[];
  /** What the keeper had of its own at the start, what the treasury's wallet held, and the supply. */
  own: bigint;
  treasuryHad: bigint;
  supply: bigint;
};

/**
 * A token with a dozen holders, a treasury that is somebody's wallet with a little SOL in it,
 * and a keeper with 0.2 SOL of its own. Holders are paid at 0.05 SOL, so that a short life
 * sees every step.
 */
function world(name: string, options: { holders?: number; settings?: Partial<Settings> } = {}): World {
  const dir = join(ROOT, `world ${name}`.replace(/[^a-z0-9]+/gi, "-"));
  rmSync(dir, { recursive: true, force: true });
  const [keeper, treasury] = [Keypair.generate(), Keypair.generate().publicKey];
  const balances = new Map<string, bigint>();
  for (let i = 0; i < (options.holders ?? 12); i++) balances.set(Keypair.generate().publicKey.toBase58(), BigInt(1_000_000 + i * 70_000) * TOKEN);
  const net = new Net(keeper.publicKey, balances);
  const [own, treasuryHad] = [SOL / 5n, SOL / 100n];
  net.lamports.set(keeper.publicKey.toBase58(), own);
  net.lamports.set(treasury.toBase58(), treasuryHad);
  const ctx: KeeperContext = {
    connection: net.connection as unknown as Connection, dbc: net.dbc as unknown as DynamicBondingCurveClient,
    hookProgram: net.hookProgram, mint: net.mint, pool: net.pool, keeper, treasury, dir,
    settings: { payWhenLamports: SOL / 20n, ...options.settings },
  };
  return { net, ctx, hooks: { sleep: async () => net.tick(4) }, store: { dir }, keeper, treasury, holders: [...balances.keys()], own, treasuryHad, supply: net.supplyOf(net.tokens) };
}

/** A second keeper with the same key, on a copy of the first one's folder: what a machine started from a copy of the first one's disk has. */
function twin(w: World, name: string): World {
  const dir = join(ROOT, `world ${name}`.replace(/[^a-z0-9]+/gi, "-"));
  rmSync(dir, { recursive: true, force: true });
  cpSync(w.store.dir, dir, { recursive: true });
  rmSync(join(dir, "private", "keeper.lock"), { force: true });
  return { ...w, ctx: { ...w.ctx, dir }, hooks: { sleep: w.hooks.sleep }, store: { dir } };
}

/** One round, the way the keeper's loop takes it: an error is said and the loop goes on. Returns what the round said. */
async function once(w: World): Promise<string> {
  let said: string;
  try {
    const outcome = await turn(w.ctx, w.hooks);
    said = outcome.status === "waiting" ? `waiting: ${outcome.reason}` : `settled: ${outcome.did.join(" | ")}`;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    said = `${error instanceof Retired ? "retired" : error instanceof Crash ? "crashed" : "error"}: ${error.message}`;
  }
  w.net.tick(2);
  return said;
}

/** `count` rounds, and what each said. */
async function rounds(w: World, count: number): Promise<string[]> {
  const said: string[] = [];
  for (let i = 0; i < count; i++) said.push(await once(w));
  return said;
}

/** Rounds until one finds nothing due. A check fails if that does not come. */
async function rest(w: World, label: string, most = 60): Promise<void> {
  let last = "";
  for (let i = 0; i < most; i++) {
    last = await once(w);
    if (last.startsWith("waiting: nothing is due")) return;
  }
  check(false, `${label}: the keeper comes to rest (its last round said: ${last.slice(0, 300)})`);
}

const ledgerOf = (w: World): Line[] => (existsSync(ledgerPath(w.store)) ? readFileSync(ledgerPath(w.store), "utf8").split("\n").filter(Boolean).map((text) => JSON.parse(text) as Line) : []);
/** What every address but the keeper's and the treasury's has been sent. */
const sentToHolders = (w: World) => [...w.net.lamports].filter(([address]) => address !== w.keeper.publicKey.toBase58() && address !== w.treasury.toBase58()).reduce((sum, [, lamports]) => sum + lamports, 0n);

/**
 * The books, the ledger and the made-up chain say the same, to the lamport. `byAnother` is
 * what a keeper named in this one's place has claimed.
 */
function agree(w: World, label: string, byAnother = 0n): void {
  const { net, store } = w;
  const books = readBooks(store);
  const t = books.totals;
  check(net.total - net.waiting - byAnother === BigInt(t.claimed) + BigInt(books.before), `${label}: what left the pool for this keeper (${net.total - net.waiting - byAnother}) is what its books claimed (${t.claimed})`);
  check(net.balance(w.treasury) - w.treasuryHad === BigInt(t.treasury.paid), `${label}: the treasury received ${net.balance(w.treasury) - w.treasuryHad} and the books say it was paid ${t.treasury.paid}`);
  check(sentToHolders(w) === BigInt(t.holders.paid), `${label}: holders received ${sentToHolders(w)} and the books say ${t.holders.paid}`);
  check(w.supply - net.supplyOf(net.tokens) === BigInt(t.burn.tokens), `${label}: the supply fell by ${w.supply - net.supplyOf(net.tokens)} and the books say ${t.burn.tokens} were burned`);
  const shouldHold = w.own + BigInt(t.claimed) - BigInt(t.treasury.paid) - BigInt(t.burn.spent) - BigInt(t.holders.paid) - net.feesCharged - net.rentPaid;
  check(net.balance(w.keeper.publicKey) === shouldHold, `${label}: the keeper's wallet holds ${net.balance(w.keeper.publicKey)}, and by the books it should hold ${shouldHold}`);
  check(BigInt(t.fees) === net.feesCharged, `${label}: the books count ${t.fees} of network fees and the chain charged ${net.feesCharged}`);
  let addsUp = true;
  try { mustAddUp(books); } catch { addsUp = false; }
  check(addsUp, `${label}: the books add up`);
  check(books.pending === null && !openRoundOf(store, books), `${label}: nothing is left out or open`);
  const texts = existsSync(ledgerPath(store)) ? readFileSync(ledgerPath(store), "utf8").split("\n").filter(Boolean) : [];
  let [prev, chained] = ["", true];
  texts.forEach((text, i) => {
    const line = JSON.parse(text) as Line;
    if (line.seq !== i + 1 || line.prev !== prev) chained = false;
    prev = createHash("sha256").update(text).digest("hex");
  });
  check(chained && texts.length === books.seq && prev === books.last, `${label}: the ledger has every line once, each carrying the hash of the one before`);
  const forHolders = ledgerOf(w).reduce((sum, line) => sum + (line.kind === "claim" ? BigInt(line.holders) : 0n), 0n);
  check(forHolders === BigInt(t.holders.paid) + BigInt(books.pot) + BigInt(books.credited), `${label}: the holders' share of every claim is paid, credited or in the pot`);
}

/** A scene on the made-up network. Whatever it throws is one failed check, and the rest of the rehearsal goes on. */
async function withWorlds(name: string, play: () => Promise<void>): Promise<void> {
  console.log(name);
  try {
    await play();
  } catch (error) {
    check(false, `${name}: the scene could not be played to its end (${error instanceof Error ? error.message.slice(0, 300) : String(error)})`);
  }
}

async function main() {
  mkdirSync(ROOT, { recursive: true });
  // Every folder a keeper takes leaves a listener for the end of the process.
  process.setMaxListeners(0);

  console.log("counting fees to edicts");
  {
    const books = newBooks(places.mint, places.keeper, NOW);
    // The pool already holds 0.2 SOL of fees, and 0.05 SOL was claimed by somebody before the books were opened.
    count(books, reading({ slot: 100, total: 250_000_000n, waiting: 200_000_000n, book: book({ epoch: 7 }) }));
    check(books.before === "50000000" && books.inPool.length === 1 && books.inPool[0].lamports === "200000000", "the first reading takes what is waiting in the pool and sets aside what was claimed before it");
    count(books, reading({ slot: 150, total: 650_000_000n, waiting: 600_000_000n, book: book({ epoch: 7 }) }));
    check(books.inPool.length === 1 && books.inPool[0].lamports === "600000000", "more fees under the same edict are added to it");
    const same = structuredClone(books);
    check(!count(books, reading({ slot: 150, total: 650_000_000n, waiting: 600_000_000n, book: book({ epoch: 7 }) })).changed && JSON.stringify(books) === JSON.stringify(same), "a reading from a slot already counted changes nothing");
    check(!count(books, reading({ slot: 160, total: 650_000_000n, waiting: 600_000_000n, book: book({ epoch: 7 }) })).changed, "nor does a later one that found nothing new");
    // Edict 8 is written, with another split; 0.3 SOL comes in before the next reading.
    count(books, reading({ slot: 200, total: 950_000_001n, waiting: 900_000_001n, book: book({ epoch: 8, split: FUNDING }) }));
    check(books.inPool.length === 2 && books.inPool[1].epoch === 8 && books.inPool[1].lamports === "300000001" && books.inPool[1].treasuryBps === 5_000, "a new edict opens a part of its own, with its own split");
    check(count(books, reading({ slot: 300, total: 950_000_101n, waiting: 900_000_101n, book: book({ epoch: 11 }) })).note?.includes("2 edicts") === true && books.inPool.length === 3, "edicts that came and went unseen are said, and the fees go to the one found in force");
    let stopped = false;
    try { count(books, reading({ slot: 400, total: 1n, book: book({ epoch: 11 }) })); } catch { stopped = true; }
    check(stopped, "a running total that went down stops the keeper");

    // A claim of 0.7 SOL takes the oldest fees first: all of edict 7's and a third of edict 8's.
    const taken = takeFromPool(books, 700_000_000n);
    check(taken.length === 2 && taken[0].epoch === 7 && taken[0].lamports === "600000000" && taken[1].epoch === 8 && taken[1].lamports === "100000000" && books.inPool[0].lamports === "200000001", "a claim takes the oldest fees first, and what it leaves stays counted to its edict");
    const line = recordClaim(books, { signature: "claim", shares: taken, fee: 5_000n }, NOW);
    check(line.kind === "claim" && line.treasury === "290000000" && line.burn === "205000000" && line.holders === "205000000" && line.lamports === "700000000", "its line shares each edict's part by that edict's split: 40% of one and 50% of the other to the treasury");
    const odd = shared(1_000_003n, { burnBps: 1_800, treasuryBps: 4_000 });
    check(odd.treasury === 400_001n && odd.burn === 180_000n && odd.holders === 420_002n && odd.treasury + odd.burn + odd.holders === 1_000_003n, "the treasury's share is its bps rounded down, and what rounding leaves goes to holders");
    check(sharesOf(books.inPool).lamports === 200_000_101n, "what is left in the pool is still counted");
    let whole = false;
    try { takeFromPool(books, 300_000_000n); } catch { whole = true; }
    check(whole, "a claim of more than was counted stops the keeper");

    recordTreasury(books, { signature: "treasury", lamports: 290_000_000n, to: "treasury", fee: 5_000n }, NOW + 20);
    recordBuyback(books, { signature: "buyback", lamports: 200_000_000n, tokens: 9_000n, found: 500n, fee: 5_250n }, NOW + 40);
    check(books.totals.treasury.owed === "0" && books.totals.burn.owed === "5000000" && books.totals.burn.tokens === "9000" && books.totals.fees === "15250" && inHand(books) === 210_000_000n, "paying the treasury and buying back come off what is owed, and the fees in hand follow");
    let addsUp = true;
    try { mustAddUp(books); } catch { addsUp = false; }
    check(addsUp && books.treasuryAt === NOW + 20, "and the books add up");
    const lines = books.outbox.map((text) => JSON.parse(text) as Line);
    check(lines.length === 3 && lines[2].kind === "buyback" && lines[2].burnSignature === lines[2].signature && lines[2].found === "500" && lines.every((one, i) => one.prev === (i === 0 ? "" : createHash("sha256").update(books.outbox[i - 1]).digest("hex"))), "every line carries the hash of the line before");
  }

  console.log("what the hook would answer the keeper");
  {
    const buyOf = (tokens: bigint, heldBefore = 0n) => ({ tokens, heldBefore, account: places.burnAccount, supply: SUPPLY, slot: 0, now: NOW, inSolVault: 0n, priorityFee: 0 });
    const regulars = book({ rule: ruleOf("regulars", 1), until: NOW + 600 });
    const newcomers = book({ rule: ruleOf("newcomers", 1), until: NOW + 600 });
    check(!admitted(regulars, places.keeper, buyOf(1_000n * TOKEN)), "Regulars refuses an account that holds nothing");
    check(!admitted(regulars, places.keeper, buyOf(1_000n * TOKEN, 999_999_999n)) && admitted(regulars, places.keeper, buyOf(1_000n * TOKEN, 1_000n * TOKEN)), "under a millionth of the supply counts as none, and a millionth as some");
    check(admitted(newcomers, places.keeper, buyOf(1_000n * TOKEN)) && !admitted(newcomers, places.keeper, buyOf(1_000n * TOKEN, 1_000n * TOKEN)), "Newcomers lets an empty account in and refuses one that holds a millionth of the supply");
    check(admitted(book({ rule: ruleOf("regulars", 1), until: NOW }), places.keeper, buyOf(TOKEN)), "a rule whose term is up refuses nothing");
    check(admitted(book({ rule: ruleOf("regulars", 1), until: NOW + 600, paused: true }), places.keeper, buyOf(TOKEN)), "nor does anything while the guardian has paused the agent");
    check(room(reading({ book: regulars }), places, 0) === 0n && opensIn(reading({ book: regulars }), places, 0) === null, "under Regulars there is no room for a buyback, and none opens for as long as the rule stands");
    const cap = room(reading({ book: book({ rule: ruleOf("max-buy", 1), until: NOW + 600 }) }), places, 0);
    check(cap !== "any" && cap > 2_499_000n * TOKEN && cap <= 2_500_000n * TOKEN, "under Max Buy at 0.25% the room is just under 2,500,000 tokens");
    check(room(reading({ book: book({}) }), places, 0) === "any", "with no rule there is room for any size");
    // Turnstile at 25%: open a quarter of the time, and a buyback is tried only if it would pass in the slot it is rehearsed in and in each of the twelve after it.
    const turnstile = book({ rule: ruleOf("turnstile", 3), until: NOW + 600 });
    let [open, longest] = [0, 0];
    for (let slot = 0; slot < 100; slot++) {
      if (room(reading({ slot, book: turnstile }), places, 0) === "any") open += 1;
      longest = Math.max(longest, opensIn(reading({ slot, book: turnstile }), places, 0) ?? Infinity);
    }
    check(open === 13 && longest === 87, "at the turnstile a buyback finds 13 slots in every 100 to start in, and never waits more than 87");
    const oddEven = book({ rule: ruleOf("odd-even", 2), until: NOW + 600 });
    const opens = opensIn(reading({ book: oddEven }), places, 0);
    check(room(reading({ book: oddEven }), places, 0) === 0n && opens !== null && opens >= 70 && opens <= 76, "in an even minute, with odd minutes open, it opens when the minute turns, 30 seconds on");
  }

  console.log("the settings, and one keeper to a folder");
  {
    const given = settingsFrom({ claimAtLamports: "70000000", pollMs: 500, ownWallets: ["a"] });
    check(given.claimAtLamports === 70_000_000n && given.pollMs === 500 && given.ownWallets?.[0] === "a" && DEFAULTS.claimAtLamports === 50_000_000n && DEFAULTS.minBuyLamports === 5_000_000n && DEFAULTS.maxBuyLamports === 1_000_000_000n && DEFAULTS.minPaymentLamports === 1_000_000n && DEFAULTS.payWhenLamports === 1_000_000_000n && DEFAULTS.lapseAfterSecs === 30 * 86_400, "settings are read from JSON over the defaults decided");
    let refused = false;
    try { settingsFrom({ claimAt: 1 }); } catch { refused = true; }
    check(refused, "a setting that does not exist is refused, not ignored");

    const store: Store = { dir: join(ROOT, "lock") };
    const lock = join(store.dir, "private", "keeper.lock");
    holdLock(store);
    holdLock(store);
    check(readFileSync(lock, "utf8") === String(process.pid), "the first round takes the folder, and later rounds of the same process keep it");
    releaseLock(store);
    // Another process that is alive (this one's parent) and has touched the lock just now.
    writeFileSync(lock, String(process.ppid));
    let held = false;
    try { holdLock(store); } catch (error) { held = error instanceof AlreadyRunning; }
    check(held, "a folder another live keeper holds is refused");
    // The same file, not touched for two minutes: that process number belongs to something else by now.
    utimesSync(lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    holdLock(store);
    check(readFileSync(lock, "utf8") === String(process.pid), "a lock nobody has touched for a minute is taken over");
    releaseLock(store);
    // A keeper that was killed: its process is gone. No process has this number.
    writeFileSync(lock, "4194000");
    holdLock(store);
    check(readFileSync(lock, "utf8") === String(process.pid), "and so is the lock of a keeper that was killed");
    releaseLock(store);
  }

  console.log("who the holders are");
  {
    const keeper = Keypair.generate();
    const chain = new MadeUpChain(NETWORKS[0]);
    const mint = Keypair.generate().publicKey;
    const [alice, bob, treasury, contract] = [0, 1, 2, 3].map(() => Keypair.generate().publicKey.toBase58());
    const vault = PublicKey.findProgramAddressSync([Buffer.from("vault")], SystemProgram.programId)[0].toBase58();
    const account = (owner: string, amount: bigint): TokenAccount => ({ address: Keypair.generate().publicKey.toBase58(), owner, amount });
    chain.tokens = [account(POOL_AUTHORITY, 700n), account(alice, 100n), account(alice, 50n), account(bob, 60n), account(treasury, 40n), account(keeper.publicKey.toBase58(), 5n), account(vault, 30n), account(contract, 10n), account("11111111111111111111111111111111", 5n), account(bob, 0n)];
    chain.owners.set(alice, { program: SystemProgram.programId.toBase58(), hasData: false, executable: false });
    chain.owners.set(contract, { program: Keypair.generate().publicKey.toBase58(), hasData: true, executable: false });
    chain.shortReads = 2;
    const snapshot = await listHolders(chain, { mint, project: [keeper.publicKey.toBase58(), treasury] });
    check(snapshot.supply === 1_000n, "the supply is the sum of every account");
    check(snapshot.holders.length === 2 && snapshot.eligible === 210n, "alice (two accounts, one with SOL) and bob (no SOL account yet) are the holders");
    check(snapshot.holders.find((holder) => holder.owner === alice)?.amount === 150n, "alice's two accounts are added up");
    check(snapshot.leftOut.pool.tokens === 700n && snapshot.leftOut.project.tokens === 45n && snapshot.leftOut.program.tokens === 30n && snapshot.leftOut["not-a-wallet"].tokens === 10n && snapshot.leftOut.nobody.tokens === 5n, "the pool, the project, a program's vault, a contract and the zero address are left out");
    check((await listHolders(chain, { mint, project: [], alsoPay: [vault] })).holders.some((holder) => holder.owner === vault), "a program's vault the settings say to pay is a holder");
    chain.shortReads = 9;
    check(await listHolders(chain, { mint, project: [] }).then(() => false, () => true), "a list that never adds up to the supply is refused");
  }

  console.log("credits, lapses and when things are due");
  {
    const s = scene("books", NETWORKS[0], 4);
    const books = readBooks(s.store);
    check(BigInt(books.pot) < 7n && BigInt(books.pot) + BigInt(books.credited) === 20_000_000n, "a credit hands out the pot to the lamport, less what rounding leaves");
    check(BigInt(books.totals.holders.owed) === 20_000_000n && books.totals.treasury.owed === "16000000" && books.totals.burn.owed === "4000000", "the claim is shared 50 / 10 / 40");
    check(due(books, s.now, MIN).pay === false && due(books, s.now + 86_400, MIN).pay === true, "a small sum waits a day and is then paid");
    check(due({ ...books, pot: "49999999" }, s.now, MIN).credit === false && due({ ...books, pot: "50000000" }, s.now, MIN).credit === true && due({ ...books, pot: "1" }, s.now + 86_400, MIN).credit === true, "the pot is credited at 0.05 SOL, or after a day whatever it holds");
    check(minPayment(DEFAULTS, 650_240n) === 1_000_000n && minPayment(DEFAULTS, 2_000_000n) === 2_000_000n, "the least payment is 0.001 SOL, or the rent-exempt minimum if that is more");
    const small = Object.entries(books.owners).filter(([, entry]) => BigInt(entry.owed) < MIN);
    check(small.length === 3, "three holders are owed too little to send");
    const empty: Snapshot = { slot: 2, supply: 0n, eligible: 1n, learned: {}, holders: [{ owner: Keypair.generate().publicKey.toBase58(), amount: 1n }], leftOut: NOBODY_LEFT_OUT() };
    books.pot = "1000";
    creditHolders(books, empty, s.now + 10);
    check(lapse(books, s.now + 86_400, MIN, 30 * 86_400) === null, "nothing lapses within thirty days");
    const lapsed = lapse(books, s.now + 31 * 86_400, MIN, 30 * 86_400);
    check(lapsed?.kind === "lapse" && lapsed.owners === 3 && Object.keys(books.owners).length === 5, "after thirty days the three small sums return to the pot, and nobody else's");
    check(BigInt(books.credited) === Object.values(books.owners).reduce((sum, entry) => sum + BigInt(entry.owed), 0n), "and the books still add up");
  }

  console.log("a round, on every kind of network");
  for (const network of NETWORKS) {
    const s = scene(`plain ${network.name}`, network, 45);
    await payHolders(s.store, s.chain, s.keeper, s.now, options(s.chain));
    await verifyToTheEnd(s, network.name);
  }

  console.log("a crash at every point, then a restart");
  let crashes = 0;
  for (const network of NETWORKS) {
    for (const point of POINTS) {
      for (const downtime of [1, 400]) {
        for (let nth = 0; ; nth++) {
          const label = `${network.name}, stopped at "${point}" no. ${nth + 1}, down for ${downtime} blocks`;
          const s = scene("crash", network, 45);
          let seen = 0;
          let crashed = false;
          try {
            await payHolders(s.store, s.chain, s.keeper, s.now, options(s.chain, (at) => { if (at === point && seen++ === nth) throw new Crash(); }));
          } catch (error) {
            if (!(error instanceof Crash)) throw error;
            crashed = true;
          }
          if (!crashed) break;
          crashes += 1;
          // What a crash can leave behind: a write that never got its rename, and half a line in the journal.
          writeFileSync(join(s.store.dir, "private", "books.json.tmp"), "{\"v\":1,\"half");
          const journal = readdirSync(join(s.store.dir, "private")).find((name) => name.endsWith(".journal.jsonl"));
          if (journal && nth % 2 === 0) appendFileSync(join(s.store.dir, "private", journal), "{\"t\":\"attempt\",\"id\":99,\"paym");
          s.chain.tick(downtime);
          await recover(s.store, s.chain, s.keeper, s.now, options(s.chain));
          // A second restart finds nothing to do.
          await recover(s.store, s.chain, s.keeper, s.now, options(s.chain));
          await verifyToTheEnd(s, label);
        }
      }
    }
  }
  console.log(`  ${crashes} crashes; ${putOffRounds} rounds put holders off to the next one`);

  console.log("crash after crash");
  let seed = 7;
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  for (let run = 0; run < 64; run++) {
    const network = NETWORKS[run % NETWORKS.length];
    const s = scene("storm", network, 30 + (run % 25));
    const fault: Fault = () => { if (random() < 0.25) throw new Crash(); };
    let done = false;
    for (let restart = 0; !done; restart++) {
      try {
        if (restart === 0) await payHolders(s.store, s.chain, s.keeper, s.now, options(s.chain, fault));
        else await recover(s.store, s.chain, s.keeper, s.now, options(s.chain, restart < 40 ? fault : undefined));
        done = true;
      } catch (error) {
        if (!(error instanceof Crash)) throw error;
        s.chain.tick(random() < 0.3 ? 400 : 3);
      }
    }
    // A crash before the plan was on disk leaves nothing to resume: the keeper's next turn plans again.
    if (readBooks(s.store).round === 0) await payHolders(s.store, s.chain, s.keeper, s.now, options(s.chain));
    await verifyToTheEnd(s, `storm ${run} on ${network.name}`);
  }

  console.log("a round stopped by its signal");
  {
    const s = scene("stopped", NETWORKS[0], 45);
    const stop = new AbortController();
    let looks = 0;
    const paid = await payHolders(s.store, s.chain, s.keeper, s.now, { ...options(s.chain), signal: stop.signal, sleep: async () => { s.chain.tick(); if (++looks === 1) stop.abort(); } });
    check(paid.state === "stopped" && readBooks(s.store).round === 0, "it gives up at the next step and leaves the round open");
    const picked = await recover(s.store, s.chain, s.keeper, s.now, options(s.chain));
    check(picked.state === "done" && picked.finished === 1, "and the next start finishes it from the journal");
    verify(s, "stopped by its signal");
  }

  console.log("a node that has forgotten the blocks a transaction landed in");
  {
    const s = scene("forgetful", NETWORKS[0], 45);
    // The process dies right after sending the first two transactions, and stays down while they land.
    await payHolders(s.store, s.chain, s.keeper, s.now, options(s.chain, (at) => { if (at === "sent") throw new Crash(); })).catch((error) => { if (!(error instanceof Crash)) throw error; });
    s.chain.tick(400);
    const journalFile = join(s.store.dir, "private", "round-000001.journal.jsonl");
    // How many entries the open round's journal has. None if the round was closed and its journal put away.
    const journal = () => (existsSync(journalFile) ? readFileSync(journalFile, "utf8").split("\n").filter(Boolean).length : 0);
    check(s.chain.landed.size === 2 && journal() === 2, "two transactions landed while the keeper was down, and its journal does not know their fate");
    // The node it comes back to keeps only its last hundred blocks, and says "never seen" of both.
    s.chain.forgotBefore = s.chain.slot - 100;
    const back = await recover(s.store, s.chain, s.keeper, s.now, options(s.chain));
    check(back.state === "blind" && back.why?.includes("I cannot tell what became of transaction") === true, "it does not take that node's word that they are dead, and says it cannot tell");
    check(journal() === 2 && s.chain.landed.size === 2, "it signs nothing in their place");
    s.chain.forgotBefore = 0;
    check((await recover(s.store, s.chain, s.keeper, s.now, options(s.chain))).state === "done", "and finishes the round once a node that has those blocks answers");
    verify(s, "a node that had forgotten");
  }

  console.log("a holder the chain will not let me pay");
  {
    const s = scene("refused", NETWORKS[0], 45);
    const refused = [...s.planned.keys()][7];
    s.chain.refused.add(refused);
    await payHolders(s.store, s.chain, s.keeper, s.now, options(s.chain));
    verify(s, "one refused", [refused]);
    const books = readBooks(s.store);
    check(books.owners[refused]?.stuck === true, "the refused holder is marked, and is not planned again");
    check((await payHolders(s.store, s.chain, s.keeper, s.now, options(s.chain))).state === null, "with nobody else owed enough, no second round is opened");
  }

  console.log("a network that takes nothing");
  {
    const s = scene("dead network", { name: "dead", takes: () => false }, 25);
    await payHolders(s.store, s.chain, s.keeper, s.now, options(s.chain));
    const books = readBooks(s.store);
    check(s.chain.received.size === 0 && books.totals.holders.paid === "0" && books.round === 1, "the round closes with everybody put off and nothing paid");
    check(Object.values(books.owners).every((entry) => !entry.stuck), "nobody is marked for it");
    s.chain.network = NETWORKS[0];
    await payHolders(s.store, s.chain, s.keeper, s.now, options(s.chain));
    check([...s.planned].every(([owner, lamports]) => s.chain.received.get(owner) === lamports), "and the next round pays them all, once");
  }

  console.log("a keeper short of SOL of its own");
  {
    const s = scene("short", NETWORKS[0], 45);
    // The wallet holds every lamport of fees it keeps for others, and nothing of its own to pay the network with.
    s.chain.funds = s.claimed;
    const paid = await payHolders(s.store, s.chain, s.keeper, s.now, options(s.chain));
    check(paid.state === "short" && s.chain.received.size === 0 && s.chain.landed.size === 0, "it refuses to start the payments, and sends nothing");
    check(paid.why?.includes("cannot afford") === true && paid.why.includes(s.keeper.publicKey.toBase58()), "and says so, with the wallet to top up");
    check((await recover(s.store, s.chain, s.keeper, s.now, options(s.chain))).state === "short", "the round stays open for as long as that lasts");
    s.chain.funds = s.claimed + FLOAT;
    check((await recover(s.store, s.chain, s.keeper, s.now, options(s.chain))).state === "done", "and is finished once the wallet has been topped up");
    verify(s, "topped up");
  }

  console.log("books older than the chain");
  {
    const s = scene("stale", NETWORKS[0], 25);
    const before = readFileSync(join(s.store.dir, "private", "books.json"), "utf8");
    await payHolders(s.store, s.chain, s.keeper, s.now, options(s.chain));
    check((await strangers(s.chain, s.keeper.publicKey, new Set([...knownSignatures(s.store)].map((text) => createHash("sha256").update(unbase58(text)).digest("hex"))))).length === 0, "with its own records, the keeper knows every transaction it paid for");
    // Yesterday's backup is put back over today's books.
    writeFileSync(join(s.store.dir, "private", "books.json"), before);
    check(await recover(s.store, s.chain, s.keeper, s.now, options(s.chain)).then(() => false, (error: Error) => /older than what was published/.test(error.message)), "books older than the published ledger are refused");
    rmSync(join(s.store.dir, "private", "done"), { recursive: true });
    rmSync(ledgerPath(s.store));
    check((await strangers(s.chain, s.keeper.publicKey, new Set())).length === 2, "and with the records gone too, the chain shows payments the keeper cannot account for");

    // A node can list a signature a moment before it can show the transaction.
    const key = Keypair.generate().publicKey;
    let shows = false;
    const slow = { history: async () => [{ signature: "listed-and-not-shown-yet", failed: false }], feePayer: async () => (shows ? key.toBase58() : null) } as unknown as Chain;
    const first = await strangers(slow, key, new Set());
    shows = true;
    check(first.length === 0 && (await strangers(slow, key, new Set())).length === 1, "a transaction the node could not show at first is asked about again, and not written off as somebody else's");
  }

  console.log("a batch the chain refuses while another transaction is slow to land");
  {
    // Thirty holders: two transactions. One holder in the first cannot be paid, and the second
    // lands thirty blocks after it is sent, so the first one's failure is seen while the second
    // is still out. The keeper has little SOL of its own: less than the second one pays out.
    const s = scene("refused and slow", { name: "the smaller transaction is slow", takes: () => true, delay: (payments) => (payments === 10 ? 30 : 0) }, 30);
    const refused = [...s.planned.keys()][0];
    s.chain.refused.add(refused);
    s.float = 20_000_000n;
    s.chain.funds = s.claimed + s.float;
    const paid = await payHolders(s.store, s.chain, s.keeper, s.now, options(s.chain));
    check(paid.state === "done", `the round does not stop to ask for SOL while the wallet holds every lamport it owes (it ended "${paid.state}"${paid.why ? `: ${paid.why.slice(0, 110)}...` : ""})`);
    if (paid.state === "done") {
      verify(s, "refused and slow", [refused]);
      check(readBooks(s.store).owners[refused]?.stuck === true && [...s.planned].every(([owner, lamports]) => owner === refused || s.chain.received.get(owner) === lamports), "it closes by itself: 29 holders paid, and the one the chain refuses marked");
    }
  }

  console.log("a pool of nodes where the one that lost the blocks is not the one asked for its oldest");
  {
    const s = scene("two nodes", NETWORKS[0], 45);
    await payHolders(s.store, s.chain, s.keeper, s.now, options(s.chain, (at) => { if (at === "sent") throw new Crash(); })).catch((error) => { if (!(error instanceof Crash)) throw error; });
    s.chain.tick(400);
    const journalFile = join(s.store.dir, "private", "round-000001.journal.jsonl");
    const journal = () => (existsSync(journalFile) ? readFileSync(journalFile, "utf8").split("\n").filter(Boolean).length : 0);
    check(s.chain.landed.size === 2 && journal() === 2, "two transactions landed while the keeper was down");
    // One node keeps its last hundred blocks and says "never seen" of both. Another, asked which is its oldest block, has them all.
    s.chain.forgotBefore = s.chain.slot - 100;
    s.chain.oldestSaid = 0;
    const back = await recover(s.store, s.chain, s.keeper, s.now, options(s.chain));
    check(back.state === "blind" && back.why?.includes("my wallet holds less than my journal accounts for") === true, `the wallet holds less than if they were dead, so the node's word is not taken, and it says so (it ended "${back.state}")`);
    check(journal() === 2 && s.chain.landed.size === 2, `it signs nothing in their place (${s.chain.landed.size} transactions are on the chain)`);
    check((await recover(s.store, s.chain, s.keeper, s.now, options(s.chain))).state === "blind" && s.chain.landed.size === 2, "however often it is asked");
    s.chain.forgotBefore = 0;
    check((await recover(s.store, s.chain, s.keeper, s.now, options(s.chain))).state === "done", "and it finishes the round once a node that knows those transactions answers");
    verify(s, "two nodes");
  }

  const sol = (lamports: bigint) => `${(Number(lamports) / 1e9).toFixed(6)} SOL`;
  const THIRD = (3n * SOL) / 10n;
  /** The treasury's 40% of 0.3 SOL. */
  const FORTY = (THIRD * 4n) / 10n;

  await withWorlds("a whole round on the made-up network", async () => {
    const w = world("ordinary");
    w.net.fees(THIRD);
    await rest(w, "an ordinary round");
    const lines = ledgerOf(w);
    check(lines.map((line) => line.kind).join(", ") === "claim, credit, treasury, buyback, payout", `fees are claimed, credited by the list taken before the claim, and paid out three ways (the ledger reads: ${lines.map((line) => line.kind).join(", ")})`);
    const [claimed, credited] = [lines.find((line) => line.kind === "claim"), lines.find((line) => line.kind === "credit")];
    check(!!claimed && claimed.kind === "claim" && !!credited && credited.kind === "credit" && credited.slot < (w.net.inBlocks.get(claimed.signature)?.slot ?? 0), "the holders were listed at a slot before the block the claim is in");
    check(w.net.balance(w.treasury) - w.treasuryHad === FORTY && w.holders.every((holder) => w.net.balance(holder) > 0n), "the treasury received its 40% and every holder was paid");
    agree(w, "an ordinary round");
  });

  await withWorlds("a treasury that is not a wallet, and one that has never been used", async () => {
    // TREASURY is a token account: an address copied from the wrong line.
    const w = world("treasury is a token account");
    w.net.others.set(w.treasury.toBase58(), { owner: TOKEN_PROGRAM_ID, data: 165 });
    w.net.fees(THIRD);
    const said = await rounds(w, 3);
    check(w.net.balance(w.treasury) === w.treasuryHad, `no SOL is sent to a treasury address that is a token account (it was sent ${sol(w.net.balance(w.treasury) - w.treasuryHad)})`);
    check(said.every((line) => line.startsWith("error:") && line.includes("is not a wallet")) && w.net.waiting === THIRD, "the keeper refuses to start, says the address is not a wallet, and claims nothing");

    // TREASURY with one character wrong, or a wallet so new that nothing has ever been sent to it: there is nothing at the address.
    const v = world("treasury never used");
    v.net.lamports.delete(v.treasury.toBase58());
    v.treasuryHad = 0n;
    v.net.fees(THIRD);
    const saidV = await rounds(v, 3);
    check(v.net.balance(v.treasury) === 0n, `no SOL is sent to a treasury address that has never been used (it was sent ${sol(v.net.balance(v.treasury))})`);
    check(saidV.every((line) => line.startsWith("error:") && line.includes("there is nothing at the treasury's address") && line.includes("send that wallet a little SOL")) && v.net.waiting === THIRD, "the keeper refuses to start, and says to compare the address and to send that wallet a little SOL");
    check(saidV.every((line) => line.length < 400 && !line.includes("://")), "in words short enough for the service's /health to show them");
    // The owner sends the wallet 0.01 SOL.
    v.treasuryHad = SOL / 100n;
    v.net.lamports.set(v.treasury.toBase58(), v.treasuryHad);
    await rest(v, "a treasury in use");
    check(v.net.balance(v.treasury) - v.treasuryHad === FORTY, "once something is there the keeper starts by itself, and the treasury is paid its 40%");
    agree(v, "after the treasury was shown to be a wallet");
  });

  await withWorlds("a node says a payment never landed, and the wallet shows that it did", async () => {
    // The process dies right after sending the treasury its share, and the payment lands. It
    // comes back to a pool of nodes: the one that answers about signatures keeps a hundred
    // blocks, and the one that answers "which is your oldest block" has them all.
    const w = world("forgetful treasury");
    w.net.fees(THIRD);
    let died = false;
    w.hooks.fault = (point) => {
      if (point !== "sent" || died || readBooks(w.store).pending?.kind !== "treasury") return;
      died = true;
      throw new Crash();
    };
    await once(w);
    w.net.tick(600);
    check(died && w.net.balance(w.treasury) - w.treasuryHad === FORTY, "the payment the keeper died on landed while it was down");
    w.net.forgotBefore = w.net.slot - 100;
    const said = await rounds(w, 4);
    check(w.net.balance(w.treasury) - w.treasuryHad === FORTY, `the treasury is paid once (it received ${sol(w.net.balance(w.treasury) - w.treasuryHad)}, and was owed ${sol(FORTY)})`);
    check(said.every((line) => line.startsWith("waiting:") && line.includes("never landed") && line.includes("my wallet holds")), "the keeper says the node's word and its wallet disagree, and signs nothing in its place");
    w.net.forgotBefore = 0;
    await rest(w, "a node that knows the payment");
    agree(w, "after a node that knows the payment answered");

    // The same in the middle of a payout round.
    const v = world("forgetful round");
    v.net.fees(THIRD);
    let diedV = false;
    v.hooks.fault = (point) => {
      if (point !== "sent" || diedV || !openRoundOf(v.store, readBooks(v.store))) return;
      diedV = true;
      throw new Crash();
    };
    await once(v);
    v.net.tick(600);
    const paidOnce = sentToHolders(v);
    check(diedV && paidOnce > 0n, "the holders' payments the keeper died on landed while it was down");
    v.net.forgotBefore = v.net.slot - 100;
    const saidV = await rounds(v, 4);
    check(sentToHolders(v) === paidOnce, `every holder is paid once (holders received ${sol(sentToHolders(v))}, and were owed ${sol(paidOnce)})`);
    check(saidV.every((line) => line.includes("my wallet holds less than my journal accounts for")), "the keeper says its wallet holds less than its journal accounts for, and signs nothing more");
    v.net.forgotBefore = 0;
    await rest(v, "a node that knows the payments");
    agree(v, "after a node that knows the payments answered");
  });

  await withWorlds("somebody buys the moment a claim lands", async () => {
    /** A keeper that comes back after three days to 6 SOL of fees, 1.8 SOL of them the holders', and somebody who has never held the token and buys 0.5 SOL of it when the claim lands. */
    const watched = async (name: string) => {
      const w = world(name);
      w.net.fees(SOL / 10n);
      await rest(w, `${name}, before the stop`);
      w.net.wait(3 * 86_400);
      w.net.fees(6n * SOL);
      const buyer = Keypair.generate().publicKey.toBase58();
      const seen = { bought: 0n };
      w.net.onLanded = (did) => { if (did.includes("claim") && seen.bought === 0n) seen.bought = w.net.buy(buyer, SOL / 2n); };
      const got = () => w.net.balance(buyer) + BigInt(readBooks(w.store).owners[buyer]?.owed ?? "0");
      return { w, seen, got };
    };

    const { w, seen, got } = await watched("watched claim");
    await rest(w, "a watched claim");
    check(seen.bought > 0n && got() === 0n, `whoever buys when the claim lands gets none of the fees that came in before they held (for 0.5 SOL of tokens held half a minute they got ${sol(got())} of the holders' 1.8 SOL)`);
    agree(w, "after the claim that was watched");

    // The same, with the keeper dying once its claim is sent, and coming back a minute later: the list it took is in its books with the claim.
    const cut = await watched("watched claim, cut short");
    let died = false;
    cut.w.hooks.fault = (point) => {
      if (point !== "sent" || died || readBooks(cut.w.store).pending?.kind !== "claim") return;
      died = true;
      throw new Crash();
    };
    await once(cut.w);
    cut.w.net.tick(200);
    await rest(cut.w, "a watched claim, cut short");
    check(died && cut.seen.bought > 0n && cut.got() === 0n, `and none either when the round was cut short between the claim and the credit (they got ${sol(cut.got())})`);
    agree(cut.w, "after the claim that was watched and cut short");
  });

  await withWorlds("a second keeper with the same key", async () => {
    // Two machines, the second started from a copy of the first one's disk. Both find a payout due.
    const a = world("first copy", { settings: { payWhenLamports: 100n * SOL } });
    a.net.fees(THIRD);
    await rest(a, "before the copy");
    const b = twin(a, "second copy");
    a.ctx.settings = { payWhenLamports: SOL / 20n };
    b.ctx.settings = { payWhenLamports: SOL / 20n };
    let died = false;
    a.hooks.fault = (point) => { if (point === "sent" && !died) { died = true; throw new Crash(); } };
    await once(a);
    const paidOnce = sentToHolders(a);
    check(died && paidOnce > 0n, "the first keeper's payments are in a block, and not final yet");
    const said = await once(b);
    check(sentToHolders(a) === paidOnce, `the second keeper pays nobody the first has just paid (holders were owed ${sol(paidOnce)} and have received ${sol(sentToHolders(a))})`);
    check(said.startsWith("error:") && said.includes("my records do not have"), "it sees the first one's transactions as soon as a block has them, and stops");

    // A transaction of the key's that the records lack turns up after the process's first look. The next thing due is a claim.
    const c = world("unknown before a claim");
    c.net.fees(THIRD);
    await rest(c, "before the unknown transaction");
    await c.net.byAnotherCopy(c.keeper);
    c.net.fees(THIRD);
    const waiting = c.net.waiting;
    const saidC = await once(c);
    check(c.net.waiting === waiting && saidC.startsWith("error:") && saidC.includes("my records do not have"), `the records are compared with the chain before a claim too: nothing is claimed (${sol(waiting - c.net.waiting)} was)`);

    // And when the next thing due is a buyback: the hook refuses it for three rounds, and lets it through after the unknown transaction.
    const d = world("unknown before a buyback", { settings: { treasuryAtLamports: 100n * SOL, payWhenLamports: 100n * SOL } });
    d.net.hookRefuses = true;
    d.net.fees(THIRD);
    await rounds(d, 3);
    await d.net.byAnotherCopy(d.keeper);
    d.net.hookRefuses = false;
    const supply = d.net.supplyOf(d.net.tokens);
    const saidD = await once(d);
    check(d.net.supplyOf(d.net.tokens) === supply && saidD.startsWith("error:") && saidD.includes("my records do not have"), "and before a buyback: nothing is bought");
  });

  await withWorlds("the guardian names another keeper", async () => {
    // Under these settings the keeper claims and credits and pays nothing out: all it has claimed is still with it.
    const HOLD = { treasuryAtLamports: 100n * SOL, minBuyLamports: 100n * SOL, payWhenLamports: 100n * SOL };
    const heir = Keypair.generate();
    const next = heir.publicKey;
    /** Rounds until the keeper says it has stopped for good. */
    const toTheEnd = async (w: World) => {
      const said: string[] = [];
      while (said.length < 40 && !said.at(-1)?.startsWith("retired:")) said.push(await once(w));
      return said;
    };
    const lastNote = (w: World) => { const line = ledgerOf(w).at(-1); return line?.kind === "note" && line.about === "retired" ? line.text : ""; };

    const w = world("replaced", { settings: HOLD });
    w.net.fees(THIRD);
    await rest(w, "before the change");
    // More fees come in and are counted. They are still in the pool when the guardian acts.
    w.net.fees(SOL / 50n);
    await once(w);
    const before = readBooks(w.store);
    check(before.totals.treasury.owed === FORTY.toString() && BigInt(before.totals.burn.owed) === (THIRD * 3n) / 10n && BigInt(before.credited) > 0n && sentToHolders(w) === 0n, "the keeper holds 0.12 SOL for the treasury, 0.09 SOL to buy back with and 0.09 SOL credited to holders");
    w.net.named = next;
    const leftThePool = w.net.total - w.net.waiting;
    const said = await toTheEnd(w);
    const books = readBooks(w.store);
    // "stopped for good" are the words the service passes on to /health, and the ones the owner's guides say to wait for.
    check(said.at(-1)?.startsWith("retired:") === true && said.at(-1)!.includes("as the keeper, not my key") && said.at(-1)!.includes("stopped for good") && !said.some((line) => line.startsWith("error:")), `it pays out round by round, with no error, and then says it has stopped for good (its rounds said: ${said.map((line) => line.slice(0, 40)).join(" / ")})`);
    check(w.net.total - w.net.waiting === leftThePool, "it claims nothing more: what waits in the pool is the next keeper's");
    check(w.net.balance(w.treasury) - w.treasuryHad === FORTY && books.totals.treasury.owed === "0", "the treasury is sent all it was owed, without waiting for the sum it is usually sent at");
    check(sentToHolders(w) === BigInt(before.credited) && books.credited === "0" && w.holders.every((holder) => w.net.balance(holder) > 0n), "every holder is sent all they were owed, without waiting for a full round");
    check(w.supply > w.net.supplyOf(w.net.tokens) && BigInt(books.totals.burn.owed) < 7_500n, `the burn share buys the token back until what is left would not pay a buyback's own fee (${books.totals.burn.owed} lamports are left)`);
    check(lastNote(w).includes(next.toBase58()) && lastNote(w).includes("I have claimed nothing since") && lastNote(w).includes("of the burn share (too little to buy back with)") && books.retired?.keeper === next.toBase58(), `the last line of its ledger says so, and what is left with it: "${lastNote(w)}"`);
    const linesThen = ledgerOf(w).length;
    check(await turn(w.ctx, w.hooks).then(() => false, (error) => error instanceof Retired) && ledgerOf(w).length === linesThen, "every round after that ends at once, and writes nothing");
    agree(w, "after the replaced keeper paid out");
    // The keeper named in its place, started on the same folder: what a service gets that is given the new key and nothing else.
    const [booksThen, saidHeir] = [readFileSync(join(w.store.dir, "private", "books.json"), "utf8"), await once({ ...w, ctx: { ...w.ctx, keeper: heir }, keeper: heir })];
    check(saidHeir.startsWith("error:") && saidHeir.includes(`are those of keeper ${w.keeper.publicKey.toBase58()}`) && ledgerOf(w).length === linesThen && readFileSync(join(w.store.dir, "private", "books.json"), "utf8") === booksThen, `the keeper named in its place refuses that folder, whose books are another's, and changes nothing in it: it needs a folder of its own (its round said: ${saidHeir.slice(0, 60)})`);
    // The guardian names the first keeper again, before anybody else has claimed.
    w.net.named = w.keeper.publicKey;
    const again = await once(w);
    check(again.startsWith("waiting: nothing is due") && readBooks(w.store).retired === undefined, `named again, it is the keeper as before (its round said: ${again.slice(0, 80)})`);

    // The hook refuses the buyback for as long as the keeper tries.
    const v = world("replaced and refused", { settings: HOLD });
    v.net.fees(THIRD);
    await rest(v, "before the change, with a rule in force");
    v.net.named = next;
    v.net.hookRefuses = true;
    const saidV = await toTheEnd(v);
    check(saidV.at(-1)?.startsWith("retired:") === true && v.net.balance(v.treasury) - v.treasuryHad === FORTY && v.holders.every((holder) => v.net.balance(holder) > 0n), "with a rule in force that refuses its buy, the treasury and the holders are paid all the same");
    check(readBooks(v.store).totals.burn.owed === ((THIRD * 3n) / 10n).toString() && v.net.supplyOf(v.net.tokens) === v.supply && lastNote(v).includes("0.09 SOL of the burn share (The edict in force refused my buy.)"), `and the burn share is left where it is, with the sum and the reason in the ledger: "${lastNote(v)}"`);
    agree(v, "after the replaced keeper was refused its buyback");

    // The keeper dies with a claim sent. The claim lands, the guardian names another keeper, and that one claims before the first comes back.
    const u = world("replaced with a claim out", { settings: HOLD });
    u.net.fees(THIRD);
    let died = false;
    u.hooks.fault = (point) => {
      if (point !== "sent" || died || readBooks(u.store).pending?.kind !== "claim") return;
      died = true;
      throw new Crash();
    };
    await once(u);
    u.net.tick(100);
    u.net.named = next;
    u.net.fees(SOL / 10n);
    u.net.claimedByAnother(SOL / 10n);
    const saidU = await toTheEnd(u);
    check(died && saidU.at(-1)?.startsWith("retired:") === true && readBooks(u.store).totals.claimed === THIRD.toString(), `its own claim, landed before the change, is counted for what it took and not for what the next keeper has taken since (its books say it claimed ${sol(BigInt(readBooks(u.store).totals.claimed))})`);
    check(u.net.balance(u.treasury) - u.treasuryHad === FORTY && u.holders.every((holder) => u.net.balance(holder) > 0n), "and it is paid out like the rest");
    agree(u, "after the replaced keeper settled its last claim", SOL / 10n);
  });

  console.log("what an error is printed as");
  {
    const said = plain(new Error("failed to get recent blockhash: request to https://rpc.example.com/v1/?api-key=SECRET-KEY failed, reason: socket hang up\n    at somewhere"));
    check(said === "failed to get recent blockhash: request to https://rpc.example.com failed, reason: socket hang up", `an address is cut down to its host, so that an RPC address never shows its key (${said})`);
  }

  rmSync(ROOT, { recursive: true, force: true });
  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exitCode = failures ? 1 : 0;
}

await main();
