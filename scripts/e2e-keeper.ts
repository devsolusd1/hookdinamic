// The keeper, end to end, against the real Meteora DBC bytecode on a local validator
// (scripts/validator.sh): a token is launched with the keeper named in its rulebook, wallets
// trade it under six edicts, and the real keeper script is run round by round as a process of
// its own. On the way the process is killed eight times, with a claim, a payment to the
// treasury and a payout round in hand, and started again. At the end the books are compared
// with the chain, to the lamport.
//
// It also shows, on a real node: the keeper refusing to start with a treasury that is not a
// wallet in use; the holders listed before the claim is signed; a second keeper with the same
// key stopping at a payment the first has only just made; the keeper leaving at once when
// asked to stop; and, last, the guardian naming another keeper, after which this one pays out
// what it holds and stops for good.
//
//   npm run validator     (in one terminal; needs WSL)
//   npm run e2e:keeper    (about twenty minutes)
//   npm run e2e:keeper -- --price=12345    the same, with the keeper's priority fee at that many micro-lamports a compute unit
//
// It is slow for three reasons. Every transaction of the keeper waits for a finalized block,
// a quarter of a minute here. One of them is left to expire, a minute and a half. And the
// validator drops its old blocks every few minutes, after which it can say nothing of a
// transaction that was in one: the test waits, when it has to, so that this does not happen
// in the middle of that minute and a half.
//
// The keeper's folder is .local/e2e-keeper. It is removed when every check has passed, and
// left for looking at when one has not.
import "../src/quiet.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveDbcPoolAddress, deriveDbcTokenVaultAddress, DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedWithTransferHookInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemInstruction, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { FEE_HOOKS, ruleOf } from "../site/hooks.js";
import { TOKEN_DECIMALS } from "../src/curve.js";
import { METEORA_DBC, rulebookAddress, setKeeperIx, setRulesIx, type Limits, type Split } from "../src/hook.js";
import type { Books, Fault, Head, Line } from "../src/keeper/books.js";
import { UNITS } from "../src/keeper/fees.js";
import { DEFAULTS, settingsFrom } from "../src/keeper/index.js";
import { turn, type KeeperContext } from "../src/keeper/round.js";
import { launch } from "../src/launch.js";

// ---------------------------------------------------------------------------------------------
// The keeper as a process
// ---------------------------------------------------------------------------------------------

/**
 * This same file, started with --stand-in, is a keeper that takes one round and freezes at a
 * chosen point of it, having left a marker file, so that the test can kill it exactly there.
 * It runs the keeper's own code; only the freezing is added.
 */
if (process.argv.includes("--stand-in")) {
  const env = (name: string) => process.env[name]!;
  const connection = new Connection(env("RPC_URL"), "confirmed");
  const ctx: KeeperContext = {
    connection,
    dbc: DynamicBondingCurveClient.create(connection, "confirmed"),
    hookProgram: new PublicKey(env("HOOK_PROGRAM")),
    mint: new PublicKey(env("MINT")),
    pool: new PublicKey(env("POOL")),
    keeper: Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(env("KEEPER_KEYPAIR"), "utf8")))),
    treasury: new PublicKey(env("TREASURY")),
    dir: env("KEEPER_DIR"),
    settings: { ...settingsFrom(JSON.parse(env("KEEPER_SETTINGS"))), ownWallets: env("KEEPER_OWN_WALLETS").split(",") },
    report: (line) => console.log(line),
  };
  const fault: Fault = (point) => {
    if (point !== env("STOP_AT")) return;
    writeFileSync(env("STOP_MARKER"), point);
    // Nothing more happens in this process: it waits here to be killed.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
  console.log(JSON.stringify(await turn(ctx, { fault })));
  process.exit(0);
}

/**
 * This same file, started with --to-be-stopped, is the real keeper script in a process the
 * test can ask to stop. A host asks with SIGTERM, which Windows has no way to send, so the
 * request comes as a message and the signal is raised here. Nothing else is added: the script
 * takes its rounds and ends by itself, and so does this process.
 */
const toBeStopped = process.argv.includes("--to-be-stopped");
if (toBeStopped) {
  process.once("message", () => {
    // The channel to the test would keep this process alive by itself.
    process.disconnect();
    process.emit("SIGTERM", "SIGTERM");
  });
  await import("./keeper.js");
}

const root = fileURLToPath(new URL("..", import.meta.url));
const local = JSON.parse(readFileSync(join(root, ".local", "validator.json"), "utf8")) as { rpc: string; hookProgram: string };
const connection = new Connection(local.rpc, "confirmed");
const HOOK = new PublicKey(local.hookProgram);
const dbc = DynamicBondingCurveClient.create(connection, "confirmed");

const dir = join(root, ".local", "e2e-keeper");
const ledgerFile = join(dir, "public", "ledger.jsonl");
const headFile = join(dir, "public", "ledger-head.json");
const booksFile = join(dir, "private", "books.json");
const privateDir = join(dir, "private");

const SOL = BigInt(LAMPORTS_PER_SOL);
const LIMITS: Limits = { minIntervalSecs: 2, maxRuleSecs: 2 * 3600, minTreasuryBps: 4_000, maxTreasuryBps: 5_000, minRenameSecs: 86_400 };
const [EVEN, BURN, PAYDAY, FUNDING] = FEE_HOOKS.map((hook) => hook.split(LIMITS.maxTreasuryBps, LIMITS.minTreasuryBps) as Split);
/** The least the keeper sends: 0.001 SOL, which is above this validator's rent-exempt minimum. */
const LEAST = SOL / 1_000n;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const inSol = (lamports: bigint | string) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

let failures = 0;
function check(ok: boolean, what: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
}

const partner = Keypair.generate(); // pays for the launch, and funds everybody
const guardian = Keypair.generate();
const agent = Keypair.generate();
const keeper = Keypair.generate();
const treasury = Keypair.generate();
const team = Keypair.generate(); // a wallet of the project's own, listed in the keeper's settings. It does the large trades.
const tiny = Keypair.generate(); // a holder whose share is too small to send at first
const leaver = Keypair.generate(); // another, who sells everything before being owed enough
const penniless = Keypair.generate(); // a holder who was sent tokens and has never held any SOL: there is no account at the address
const holders = Array.from({ length: 27 }, () => Keypair.generate());
const mint = Keypair.generate();
const config = Keypair.generate();
const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, config.publicKey);
const rulebook = rulebookAddress(HOOK, mint.publicKey);
const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint.publicKey, owner, true, TOKEN_2022_PROGRAM_ID);

const keeperEnv = (settings: Record<string, unknown>) => ({
  ...process.env,
  RPC_URL: local.rpc,
  HOOK_PROGRAM: HOOK.toBase58(),
  MINT: mint.publicKey.toBase58(),
  POOL: pool.toBase58(),
  KEEPER_KEYPAIR: join(dir, "keeper-keypair.json"),
  TREASURY: treasury.publicKey.toBase58(),
  KEEPER_DIR: dir,
  KEEPER_EVERY_SECS: "2",
  KEEPER_OWN_WALLETS: team.publicKey.toBase58(),
  KEEPER_SETTINGS: JSON.stringify(settings),
  DRY_RUN: "",
});

/** Node, with tsx to read TypeScript, on one of the project's scripts. One process: killing it kills the keeper. */
const node = (script: string, ...args: string[]) => [process.execPath, "--import", import.meta.resolve("tsx"), join(root, "scripts", script), ...args];

type Ran = { code: number | null; signal: NodeJS.Signals | null; out: string };

/**
 * Starts a process and waits for it to end. `until` is looked at ten times a second: when it
 * says so, the process is killed outright, with no chance to tidy up. With `asked`, the
 * process is one that can be asked to stop (see --to-be-stopped): `asked` is looked at the
 * same way, and when it says so the request is sent, once.
 */
function run(command: string[], env: NodeJS.ProcessEnv, until?: () => boolean, asked?: () => boolean): Promise<Ran> {
  return new Promise((resolve, reject) => {
    // It runs from the keeper's folder, where there is no .env for the script to pick up.
    const child = spawn(command[0], command.slice(1), { env, cwd: dir, stdio: ["ignore", "pipe", "pipe", ...(asked ? ["ipc" as const] : [])] });
    let out = "";
    const take = (chunk: Buffer) => {
      out += chunk.toString();
      for (const line of chunk.toString().split("\n")) if (line.trim() && !line.includes("bigint: Failed to load bindings")) console.log(`      | ${line.trim()}`);
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    let sent = false;
    const watch = setInterval(() => {
      if (until?.()) { clearInterval(watch); child.kill("SIGKILL"); }
      if (!sent && child.connected && asked?.()) { sent = true; child.send("stop"); }
    }, 100);
    const tooLong = setTimeout(() => child.kill("SIGKILL"), 8 * 60_000);
    child.on("error", reject);
    child.on("exit", (code, signal) => { clearInterval(watch); clearTimeout(tooLong); resolve({ code, signal, out }); });
  });
}

/**
 * The priority fee the keeper is run at, in micro-lamports per compute unit: the one it ships
 * with, or the one given as --price=, to see on a real node that the network charges what the
 * keeper reckons at another price too.
 */
const PRICE = Number(process.argv.find((arg) => arg.startsWith("--price="))?.slice("--price=".length) ?? DEFAULTS.microLamportsPerUnit);
/**
 * What the network charges for a transaction with one signature, by the runtime's own sum:
 * 5,000 lamports for the signature, and the price on every unit asked for, rounded up to the
 * lamport. Written out here in whole numbers, apart from the keeper's own reckoning of it.
 */
const chargedFor = (units: number, price: number) => 5_000n + (BigInt(units) * BigInt(price) + 999_999n) / 1_000_000n;

const FAST = { pollMs: 500, ...(PRICE === DEFAULTS.microLamportsPerUnit ? {} : { microLamportsPerUnit: PRICE }) };
const HUGE = "1000000000000000";
/** Every number as the keeper ships, except that no payout round starts: the test opens the first one itself, to kill it. */
const NO_PAYOUT = { ...FAST, payWhenLamports: HUGE };
/** Nothing is due at any size: the keeper only reads and counts. */
const COUNT_ONLY = { ...FAST, claimAtLamports: HUGE, treasuryAtLamports: HUGE, minBuyLamports: HUGE, creditWhenLamports: HUGE, payWhenLamports: HUGE };

/** One round of the real keeper script. */
async function keeperRound(settings: Record<string, unknown>): Promise<Ran> {
  const ran = await run(node("keeper.ts", "--once"), keeperEnv(settings));
  if (ran.code !== 0) check(false, `the keeper's round ended with exit code ${ran.code}`);
  return ran;
}

/** A round of the stand-in keeper, killed when it reaches `point`. True if it got there and was killed there. */
async function killedAt(point: Parameters<Fault>[0], settings: Record<string, unknown>): Promise<boolean> {
  const marker = join(dir, "stopped-at");
  rmSync(marker, { force: true });
  const ran = await run(node("e2e-keeper.ts", "--stand-in"), { ...keeperEnv(settings), STOP_AT: point, STOP_MARKER: marker }, () => existsSync(marker));
  const reached = existsSync(marker);
  rmSync(marker, { force: true });
  return reached && ran.code !== 0;
}

// ---------------------------------------------------------------------------------------------
// Trading, and reading the chain
// ---------------------------------------------------------------------------------------------

async function send(what: string, tx: Transaction, signers: Keypair[]): Promise<string> {
  const latest = await connection.getLatestBlockhash();
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(...signers);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const err = await connection.confirmTransaction({ signature, ...latest }, "confirmed").then((result) => result.value.err, (error) => error);
  if (err) {
    const seen = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    throw new Error(`${what} failed: ${JSON.stringify(err)}\n${(seen?.meta?.logMessages ?? []).join("\n")}`);
  }
  return signature;
}

const tx = (...ixs: TransactionInstruction[]) => new Transaction().add(...ixs);

async function swap(who: Keypair, buy: boolean, amount: bigint): Promise<string> {
  const swapTx = await dbc.pool.swap2WithTransferHook({
    owner: who.publicKey, pool, swapBaseForQuote: !buy, referralTokenAccount: null,
    swapMode: SwapMode.ExactIn, amountIn: new BN(amount.toString()), minimumAmountOut: new BN(0),
  });
  return send(buy ? "a buy" : "a sale", swapTx, [who]);
}

const buy = (who: Keypair, sol: number) => swap(who, true, BigInt(Math.round(sol * LAMPORTS_PER_SOL)));

/** What `owners` hold of the token, in base units, read in one call. */
async function tokensOf(owners: PublicKey[]): Promise<bigint[]> {
  const accounts = await connection.getMultipleAccountsInfo(owners.map(ata), "confirmed");
  return accounts.map((account) => (account ? account.data.readBigUInt64LE(64) : 0n));
}

async function sellShare(who: Keypair, percent: bigint): Promise<string> {
  const [held] = await tokensOf([who.publicKey]);
  return swap(who, false, (held * percent) / 100n);
}

/** A plain transfer of the token from one wallet to another, which the sender pays for. The hook is called and judges nothing: it is not a buy. */
async function give(from: Keypair, to: PublicKey, amount: bigint): Promise<string> {
  return send("a transfer", tx(
    createAssociatedTokenAccountIdempotentInstruction(from.publicKey, ata(to), to, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    await createTransferCheckedWithTransferHookInstruction(connection, ata(from.publicKey), mint.publicKey, ata(to), from.publicKey, amount, TOKEN_DECIMALS, [], "confirmed", TOKEN_2022_PROGRAM_ID),
  ), [from]);
}

async function airdrop(to: PublicKey, sol: number) {
  const signature = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
}

/** What the chain knows of a signature. Null: it has never seen it. */
const statusOf = async (signature: string) => (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];

/** Every file in the keeper's folder with its size and when it was last written, to see that nothing was touched. */
function untouched(): string {
  const list = (folder: string): string[] => (existsSync(folder) ? readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? list(join(folder, entry.name)) : [`${join(folder, entry.name)} ${statSync(join(folder, entry.name)).size} ${statSync(join(folder, entry.name)).mtimeMs}`])) : []);
  return list(dir).sort().join("\n");
}

const supply = async () => BigInt((await connection.getTokenSupply(mint.publicKey, "confirmed")).value.amount);
const lamportsOf = async (who: PublicKey) => BigInt(await connection.getBalance(who, "confirmed"));

/** The pool's fees for the token by Meteora's own decoder: what is waiting, and all it was ever credited. */
async function poolFees(): Promise<{ waiting: bigint; ever: bigint }> {
  const metrics = await dbc.state.getPoolFeeMetrics(pool);
  return { waiting: BigInt(metrics.current.partnerQuoteFee.toString()), ever: BigInt(metrics.total.totalTradingQuoteFee.toString()) };
}

/** Waits until a finalized block holds the transaction: the keeper lists the holders from finalized blocks. */
async function finalized(signature: string) {
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    if (value[0]?.confirmationStatus === "finalized") return;
    await sleep(500);
  }
}

let edicts = 0;
/** The agent writes an edict: a rule from the catalogue, or none, and a fee split. */
async function edict(what: string, rule: ReturnType<typeof ruleOf>, split: Split) {
  await sleep((LIMITS.minIntervalSecs + 1) * 1000);
  await send("an edict", tx(setRulesIx({ program: HOOK, agent: agent.publicKey, mint: mint.publicKey, change: { ruleSecs: 3_600, rule, ...split } })), [agent]);
  edicts += 1;
  console.log(`edict ${edicts}: ${what}, holders ${split.holdersBps / 100}% / burn ${split.burnBps / 100}% / treasury ${split.treasuryBps / 100}%`);
}

const ledger = (): Line[] => (existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).map((text) => JSON.parse(text) as Line) : []);
const books = () => JSON.parse(readFileSync(booksFile, "utf8")) as Books;
const head = () => JSON.parse(readFileSync(headFile, "utf8")) as Head;
const only = <K extends Line["kind"]>(lines: Line[], kind: K) => lines.filter((line): line is Extract<Line, { kind: K }> => line.kind === kind);

// ---------------------------------------------------------------------------------------------
// What the holders should be owed, worked out here from the public ledger and the chain
// ---------------------------------------------------------------------------------------------

/** The wallets that count as holders: everybody who bought, but for the project's own. */
const everyHolder = [...holders, tiny, leaver, penniless];
const model = { pot: 0n, owed: new Map<string, bigint>(), paid: new Map<string, bigint>(), rounds: new Map<string, number>(), followed: 0 };

/**
 * Follows the ledger lines not yet seen. A claim adds to the pot; a credit shares the pot by
 * what each holder holds now (nobody but the project has traded since the keeper looked); a
 * payout sends everybody owed the least or more all they are owed. Returns the new lines.
 */
async function follow(): Promise<Line[]> {
  const fresh = ledger().slice(model.followed);
  model.followed += fresh.length;
  if (!fresh.some((line) => line.kind === "credit" || line.kind === "payout" || line.kind === "lapse")) {
    for (const line of only(fresh, "claim")) model.pot += BigInt(line.holders);
    return fresh;
  }
  const held = await tokensOf(everyHolder.map((holder) => holder.publicKey));
  const eligible = held.reduce((sum, amount) => sum + amount, 0n);
  for (const line of fresh) {
    if (line.kind === "claim") model.pot += BigInt(line.holders);
    if (line.kind === "credit") {
      let credited = 0n;
      everyHolder.forEach((holder, i) => {
        const share = (model.pot * held[i]) / eligible;
        const owner = holder.publicKey.toBase58();
        model.owed.set(owner, (model.owed.get(owner) ?? 0n) + share);
        credited += share;
      });
      check(
        BigInt(line.lamports) === credited && line.holders === held.filter((amount) => amount > 0n).length && BigInt(line.tokens) === eligible,
        `the credit of ${inSol(line.lamports)} SOL is the pot shared between ${line.holders} holders in proportion to what each holds, rounded down to the lamport`,
      );
      model.pot -= credited;
    }
    if (line.kind === "lapse") {
      // Whoever holds none and is owed less than the least: what they are owed goes back into the pot.
      let [back, owners] = [0n, 0];
      everyHolder.forEach((holder, i) => {
        const owner = holder.publicKey.toBase58();
        const owed = model.owed.get(owner) ?? 0n;
        if (held[i] > 0n || owed === 0n || owed >= LEAST) return;
        model.owed.delete(owner);
        back += owed;
        owners += 1;
      });
      check(BigInt(line.lamports) === back && line.owners === owners, `the ledger returns ${line.lamports} lamports of ${line.owners} wallet(s) to the pot, which is what was worked out here`);
      model.pot += back;
    }
    if (line.kind === "payout") {
      let [sent, payments] = [0n, 0];
      for (const [owner, owed] of model.owed) {
        if (owed < LEAST) continue;
        model.paid.set(owner, (model.paid.get(owner) ?? 0n) + owed);
        model.rounds.set(owner, (model.rounds.get(owner) ?? 0) + 1);
        model.owed.set(owner, 0n);
        sent += owed;
        payments += 1;
      }
      check(BigInt(line.lamports) === sent && line.payments === payments, `round ${line.round} paid ${line.payments} holders ${inSol(line.lamports)} SOL: everybody owed 0.001 SOL or more, all they were owed`);
    }
  }
  return fresh;
}

// ---------------------------------------------------------------------------------------------
// What the keeper's key did, read from the chain as it happens
// ---------------------------------------------------------------------------------------------

/**
 * One transaction the keeper's key paid for, as the chain shows it: what the network charged,
 * whether it went through, the programs it calls, whether Meteora was called from inside one
 * of them, and its plain transfers of SOL. Then the compute units it asked for, the price it
 * set on each, and the units it used in the end.
 */
type Seen = { fee: bigint; landed: boolean; programs: string[]; meteoraInside: boolean; transfers: { to: string; lamports: bigint }[]; asked: number; price: number; used: number };

/**
 * This validator keeps little history: about every 550 slots it drops every block but the
 * last thirty or so, and can then say nothing of a transaction that was in one of them. So
 * the keeper's transactions are read every two seconds for as long as the test runs, and what
 * they did is kept here, where the checks at the end find it.
 */
const witnessed = new Map<string, Seen>();
const looked = new Set<string>();
let watching = false;

async function watchKeeper(): Promise<void> {
  if (watching) return;
  watching = true;
  try {
    for (const { signature } of await connection.getSignaturesForAddress(keeper.publicKey, { limit: 200 }, "confirmed")) {
      if (looked.has(signature)) continue;
      const seen = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!seen?.meta) continue;
      looked.add(signature);
      const keys = seen.transaction.message.staticAccountKeys;
      // Somebody sending the keeper SOL or tokens shows up here too. Only what its key paid for is its own doing.
      if (!keys[0].equals(keeper.publicKey)) continue;
      const transfers: Seen["transfers"] = [];
      // Nought for a limit or a price the transaction does not set.
      let [asked, price] = [0, 0];
      for (const ix of seen.transaction.message.compiledInstructions) {
        if (keys[ix.programIdIndex].equals(ComputeBudgetProgram.programId)) {
          // The compute-budget program's instructions start with their number: 2 sets the limit, a u32, and 3 the price, a u64.
          const data = Buffer.from(ix.data);
          if (data[0] === 2 && data.length >= 5) asked = data.readUInt32LE(1);
          if (data[0] === 3 && data.length >= 9) price = Number(data.readBigUInt64LE(1));
        }
        if (!keys[ix.programIdIndex].equals(SystemProgram.programId)) continue;
        const { toPubkey, lamports } = SystemInstruction.decodeTransfer({ programId: SystemProgram.programId, keys: ix.accountKeyIndexes.map((index) => ({ pubkey: keys[index], isSigner: false, isWritable: true })), data: Buffer.from(ix.data) });
        transfers.push({ to: toPubkey.toBase58(), lamports });
      }
      witnessed.set(signature, {
        asked,
        price,
        used: seen.meta.computeUnitsConsumed ?? 0,
        fee: BigInt(seen.meta.fee),
        landed: seen.meta.err === null,
        programs: seen.transaction.message.compiledInstructions.map((ix) => keys[ix.programIdIndex].toBase58()),
        meteoraInside: (seen.meta.logMessages ?? []).some((log) => log.startsWith(`Program ${METEORA_DBC.toBase58()} invoke [2]`)),
        transfers,
      });
    }
  } finally {
    watching = false;
  }
}

/** Every transfer of SOL in the transactions the ledger's payout lines list: who received, how much, how many times. */
async function paidOnChain(lines: Line[]): Promise<{ received: Map<string, bigint>; times: Map<string, number> }> {
  await watchKeeper();
  const [received, times] = [new Map<string, bigint>(), new Map<string, number>()];
  for (const line of only(lines, "payout")) {
    for (const { signature } of line.transactions) {
      const seen = witnessed.get(signature);
      if (!seen?.landed) throw new Error(`the ledger lists ${signature}, which the chain does not show as landed`);
      for (const { to, lamports } of seen.transfers) {
        received.set(to, (received.get(to) ?? 0n) + lamports);
        times.set(to, (times.get(to) ?? 0) + 1);
      }
    }
  }
  return { received, times };
}

/**
 * Waits, if it has to, so that the next `slots` slots go by without the validator dropping its
 * old blocks. The keeper will not call a transaction of its own dead unless the node still has
 * every block since it was signed, and the test that follows needs it to be able to.
 *
 * The validator looks at its ledger about every 540 slots, counted from the last time it
 * dropped anything, and drops the old blocks then, or now and then lets a turn go by. So the
 * moments to keep clear of are known to within a few dozen slots.
 */
async function clearOfTheNextDrop(slots: number): Promise<void> {
  const [EVERY, EITHER_WAY] = [540, 80];
  for (let waited = false; ; waited = true) {
    const [slot, oldest] = [await connection.getSlot("processed"), await connection.getFirstAvailableBlock()];
    // After a drop about forty slots are left. A validator that has never dropped anything first does when it is about 540 slots old.
    const since = oldest === 0 ? slot : slot - oldest - 40;
    const untilNext = EVERY - (((since % EVERY) + EVERY) % EVERY);
    if (untilNext > slots + EITHER_WAY) return void (waited && console.log());
    if (!waited) process.stdout.write(`      waiting ${Math.round((untilNext + EITHER_WAY) * 0.4)} seconds, until the validator is past the moment it may drop its old blocks`);
    for (let left = (untilNext + EITHER_WAY) * 400; left > 0; left -= 5_000) {
      process.stdout.write(".");
      await sleep(Math.min(left, 5_000));
    }
  }
}

// ---------------------------------------------------------------------------------------------

async function main() {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "keeper-keypair.json"), JSON.stringify([...keeper.secretKey]));

  console.log("a node that refuses, and repeats the address it was asked at");
  {
    // A stand-in for a provider that turns the request down and quotes the whole address in its answer, key and all.
    const refusing = createServer((request, response) => {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end(`this key may not be used at http://${request.headers.host}${request.url}`);
    });
    await new Promise<void>((listening) => refusing.listen(0, "127.0.0.1", () => listening()));
    const at = `http://127.0.0.1:${(refusing.address() as AddressInfo).port}`;
    const refused = await run(node("keeper.ts", "--once"), { ...keeperEnv(COUNT_ONLY), RPC_URL: `${at}/?api-key=SECRET-KEY` });
    refusing.close();
    refusing.closeAllConnections();
    check(refused.code === 1 && refused.out.includes("error: 403") && refused.out.includes(at) && !refused.out.includes("SECRET-KEY"), "what the keeper prints keeps the host of that address and not the key that follows it");
  }

  console.log("setting up");
  // The keeper's own wallet starts empty: it is given its SOL below, once it has been seen to go without.
  for (const wallet of [partner, team]) for (let asked = 0; asked < 400; asked += 100) await airdrop(wallet.publicKey, 100);
  const everybody = [guardian, agent, treasury, tiny, leaver, ...holders];
  for (let at = 0; at < everybody.length; at += 16) {
    await send("funding", tx(...everybody.slice(at, at + 16).map((wallet) => SystemProgram.transfer({ fromPubkey: partner.publicKey, toPubkey: wallet.publicKey, lamports: 2 * LAMPORTS_PER_SOL }))), [partner]);
  }
  await launch({
    dbc, hookProgram: HOOK, payer: partner, mint, config,
    guardian: guardian.publicKey, agent: agent.publicKey, keeper: keeper.publicKey,
    limits: LIMITS, split: EVEN,
    curve: { startCapSol: 30, feeBps: 300 },
    names: [{ name: "Veluno", symbol: "VELUNO" }], uri: "https://example.com/veluno.json",
  }, send);
  const solVault = deriveDbcTokenVaultAddress(pool, NATIVE_MINT);
  const startSupply = await supply();
  const watch = setInterval(() => void watchKeeper().catch(() => {}), 2_000);
  check((await connection.getAccountInfo(rulebook)) !== null, `a token is launched with the keeper ${keeper.publicKey.toBase58()} in its rulebook, fee 3%, treasury between 40% and 50%`);

  /** The pool's running total of fees at the end of each edict, by Meteora's count: what each edict earned is the difference. */
  const edge: bigint[] = [];
  const closeEdict = async () => edge.push((await poolFees()).ever);

  // -------------------------------------------------------------------------------------------
  console.log("edict 0, the opening split, no rule: wallets buy");
  for (let at = 0; at < holders.length; at += 9) await Promise.all(holders.slice(at, at + 9).map((holder, i) => buy(holder, 0.1 + 0.01 * (at + i))));
  await buy(tiny, 0.0005);
  await buy(leaver, 0.0006);
  await give(holders[2], penniless.publicKey, (await tokensOf([holders[2].publicKey]))[0] / 2n);
  await buy(treasury, 0.05);
  // The keeper looks at the treasury's address in finalized blocks: everything up to here is final before it is started.
  await finalized(await buy(team, 2));
  // The treasury's wallet does nothing of its own from here on: what it holds more than this at the end, the keeper sent it.
  const treasuryStart = await lamportsOf(treasury.publicKey);
  const mintStart = await lamportsOf(mint.publicKey);

  console.log("a treasury that is not a wallet in use");
  // An address with one character wrong is still an address, and so is a wallet so new that nothing has been sent to it: there is nothing there.
  const unused = await run(node("keeper.ts", "--once"), { ...keeperEnv(FAST), TREASURY: Keypair.generate().publicKey.toBase58() });
  check(
    unused.code === 1 && unused.out.includes("there is nothing at the treasury's address") && unused.out.includes("send that wallet a little SOL") && !existsSync(booksFile),
    "given a treasury address nothing has ever been sent to, the keeper refuses to start, and says to compare it with the wallet and to send that wallet a little SOL",
  );
  // The token's own address, pasted where the treasury's should be.
  const notAWallet = await run(node("keeper.ts", "--once"), { ...keeperEnv(FAST), TREASURY: mint.publicKey.toBase58() });
  check(
    notAWallet.code === 1 && notAWallet.out.includes("is not a wallet") && !existsSync(booksFile) && (await poolFees()).waiting > 0n && (await lamportsOf(mint.publicKey)) === mintStart,
    "given the address of something that is not a wallet, it refuses too: nothing is claimed and nothing is sent there",
  );
  const counted = await keeperRound(COUNT_ONLY);
  await closeEdict();
  const counting = books();
  check(
    counted.out.includes("waiting: nothing is due") && counting.inPool.length === 1 && counting.inPool[0].epoch === 0 && BigInt(counting.inPool[0].lamports) === edge[0] && ledger().length === 0,
    `a round with nothing due only counts: ${inSol(edge[0])} SOL of fees, all the pool has collected, to edict 0`,
  );
  const broke = await keeperRound(FAST);
  check(
    broke.out.includes("I cannot afford to claim the fees") && broke.out.includes(`My wallet ${keeper.publicKey.toBase58()} needs topping up`) && ledger().length === 0 && (await poolFees()).waiting === edge[0],
    "with no SOL of its own the keeper refuses to start the claim, says so, and sends nothing",
  );
  await airdrop(keeper.publicKey, 1);
  const keeperStart = await lamportsOf(keeper.publicKey);

  // -------------------------------------------------------------------------------------------
  await edict("no rule", [], FUNDING);
  // The keeper lists the holders from finalized blocks, and now does it before it claims: the project's own buy has to be final for the list to show it.
  await finalized(await buy(team, 60));
  const unsold = async () => BigInt((await connection.getTokenAccountBalance(deriveDbcTokenVaultAddress(pool, mint.publicKey), "confirmed")).value.amount);
  const before = { fees: await poolFees(), supply: await supply(), treasury: await lamportsOf(treasury.publicKey), keeper: await lamportsOf(keeper.publicKey), unsold: await unsold() };
  console.log("a round with everything as the keeper ships: claim and credit, treasury, buyback");
  await keeperRound(NO_PAYOUT);
  let lines = await follow();
  check(lines.map((line) => line.kind).join(", ") === "claim, credit, treasury, buyback", `the ledger gains four lines: the claim, the credit of the holders' share by the list taken before it, the treasury's payment and the buyback (${lines.map((line) => line.kind).join(", ")})`);
  const [claim] = only(lines, "claim");
  const earned = [edge[0], before.fees.ever - edge[0]];
  const claimed = witnessed.get(claim?.signature ?? "");
  check(
    !!claim && !!claimed?.landed && claimed.programs.includes(HOOK.toBase58()) && !claimed.programs.includes(METEORA_DBC.toBase58()) && claimed.meteoraInside && BigInt(claim.lamports) === before.fees.waiting && (await poolFees()).ever - (await poolFees()).waiting === BigInt(claim.lamports),
    `the fees are claimed through the hook program, which calls Meteora: ${inSol(claim?.lamports ?? 0n)} SOL, every lamport that was waiting`,
  );
  const expected = [{ epoch: 0, lamports: earned[0].toString(), ...EVEN }, { epoch: 1, lamports: earned[1].toString(), ...FUNDING }];
  check(JSON.stringify(claim?.shares) === JSON.stringify(expected), `the claim is counted edict by edict: ${inSol(earned[0])} SOL came in under edict 0 and ${inSol(earned[1])} SOL under edict 1, each with its own split`);
  const toTreasury = (earned[0] * 4_000n) / 10_000n + (earned[1] * 5_000n) / 10_000n;
  const toBurn = (earned[0] * 3_000n) / 10_000n + (earned[1] * 2_500n) / 10_000n;
  check(
    !!claim && BigInt(claim.treasury) === toTreasury && BigInt(claim.burn) === toBurn && BigInt(claim.holders) === earned[0] + earned[1] - toTreasury - toBurn,
    `to the lamport: the treasury's share is 40% of the first and 50% of the second, ${inSol(toTreasury)} SOL; ${inSol(toBurn)} SOL to burn; the rest, ${inSol(claim?.holders ?? 0n)} SOL, for holders`,
  );
  const [paidTreasury] = only(lines, "treasury");
  check(
    !!paidTreasury && BigInt(paidTreasury.lamports) === toTreasury && paidTreasury.to === treasury.publicKey.toBase58() && (await lamportsOf(treasury.publicKey)) - before.treasury === toTreasury,
    `the treasury's wallet receives exactly that: ${inSol(paidTreasury?.lamports ?? 0n)} SOL`,
  );
  const [bought] = only(lines, "buyback");
  const burned = before.supply - (await supply());
  check(
    !!bought && burned > 0n && BigInt(bought.tokens) === burned && BigInt(bought.lamports) <= toBurn && BigInt(bought.lamports) * 100n >= toBurn * 97n && (await tokensOf([keeper.publicKey]))[0] === 0n,
    `with no rule in force the buyback spends ${inSol(bought?.lamports ?? 0n)} SOL of the burn share, and the supply falls by the ${burned} base units it bought: the keeper keeps none`,
  );
  const [credit] = only(lines, "credit");
  const [teamHolds, treasuryHolds] = await tokensOf([team.publicKey, treasury.publicKey]);
  // The list was taken before the claim, and so before the buyback took tokens out of the pool.
  check(
    !!credit && credit.leftOut.pool.owners === 1 && BigInt(credit.leftOut.pool.tokens) === before.unsold && (await unsold()) === before.unsold - BigInt(bought?.tokens ?? 0n) && credit.leftOut.project.owners === 2 && BigInt(credit.leftOut.project.tokens) === teamHolds + treasuryHolds,
    `the pool's unsold tokens as they stood before the round, the treasury and the project wallet listed in the settings are left out of that credit`,
  );
  const tinyOwed = model.owed.get(tiny.publicKey.toBase58()) ?? 0n;
  check(tinyOwed > 0n && tinyOwed < LEAST && only(lines, "payout").length === 0, `the smallest holder is owed ${tinyOwed} lamports, under the least I send`);
  await closeEdict();

  // -------------------------------------------------------------------------------------------
  await edict("Max Buy at 0.25% of supply", ruleOf("max-buy", 1), BURN);
  await sellShare(team, 90n);
  const beforeMax = { supply: await supply(), owed: 0n, treasury: await lamportsOf(treasury.publicKey), lines: ledger().length };
  console.log("a round under Max Buy, with the keeper killed four times on the way and left down until a transaction of its own has expired");
  check(await killedAt("intent recorded", NO_PAYOUT), "killed with the claim signed and written in its books, and not yet sent");
  const claimOut = books().pending;
  check(claimOut?.kind === "claim" && (await statusOf(claimOut.signature)) === null && ledger().length === beforeMax.lines, "the claim's signed bytes are on disk, and the chain has never seen them");
  check(await killedAt("sent", NO_PAYOUT), "started again, it sends those same bytes; killed before it knows what became of them");
  check(books().pending?.signature === claimOut?.signature && ledger().length === beforeMax.lines, "it signed nothing new, and the ledger has no line yet");
  check(await killedAt("books written", NO_PAYOUT), "started again, it finds the claim in a finalized block and writes it in its books; killed before the public ledger has the line");
  const ahead = books();
  const [claimWritten, creditWritten] = ahead.outbox.slice(-2).map((text) => JSON.parse(text) as Line);
  check(
    ahead.pending === null && ahead.seq === beforeMax.lines + 2 && claimWritten?.kind === "claim" && creditWritten?.kind === "credit" && ledger().length === beforeMax.lines,
    "the books have the claim, and in the same write the credit of the holders' share; the ledger has neither yet",
  );
  // A claim is public the moment it lands. The list its share is credited by was taken before it was signed, and was on disk with it through both kills.
  const claimSlot = (await statusOf(claimOut?.signature ?? ""))?.slot ?? 0;
  check(
    creditWritten?.kind === "credit" && claimOut?.listed?.slot === creditWritten.slot && claimSlot > 0 && creditWritten.slot < claimSlot,
    `the holders were listed at slot ${creditWritten?.kind === "credit" ? creditWritten.slot : "?"}, before the claim was signed, and the claim is in the block of slot ${claimSlot}: nobody could buy in on seeing it`,
  );
  await clearOfTheNextDrop(250);
  check(await killedAt("intent recorded", NO_PAYOUT), "started again, it brings the ledger up, then signs the treasury's payment; killed before that is sent");
  const treasuryOut = books().pending;
  check(
    treasuryOut?.kind === "treasury" && only(ledger().slice(beforeMax.lines), "claim").length === 1 && only(ledger(), "claim").at(-1)?.signature === claimOut?.signature && (await lamportsOf(treasury.publicKey)) === beforeMax.treasury,
    "the ledger has that claim once, and the treasury has not been paid",
  );
  // The keeper stays down until no block can take that payment any more: 150 blocks, the margin of 30 the keeper adds, and the blocks it takes for one to be finalized.
  process.stdout.write("      waiting about a minute and a half for the payment's blockhash to run out");
  while ((await connection.getEpochInfo("finalized")).blockHeight! <= (treasuryOut?.lastValidBlockHeight ?? 0) + 30) {
    process.stdout.write(".");
    await sleep(5_000);
  }
  console.log();
  const back = await keeperRound(NO_PAYOUT);
  lines = await follow();
  const [paidOnce] = only(lines, "treasury");
  check(
    back.out.includes("never landed and no longer can") && only(lines, "claim").length === 1 && only(lines, "treasury").length === 1 && paidOnce.signature !== treasuryOut?.signature && (await statusOf(treasuryOut?.signature ?? "")) === null && (await lamportsOf(treasury.publicKey)) - beforeMax.treasury === BigInt(paidOnce.lamports),
    `started again, it proves the payment dead and only then signs another: the treasury receives its ${inSol(paidOnce?.lamports ?? 0n)} SOL once`,
  );
  const [capped] = only(lines, "buyback");
  // What the burn share was owed when the buyback was sized: the totals of the line before it.
  beforeMax.owed = capped ? BigInt(lines[lines.indexOf(capped) - 1].totals.burn.owed) : 0n;
  // The size of the buy as the hook measures it: millionths of the supply, rounded down. The cap is 2,500 of them.
  const size = (BigInt(capped?.tokens ?? 0n) * 1_000_000n) / beforeMax.supply;
  check(
    !!capped && (size === 2_500n || size === 2_499n) && BigInt(capped.lamports) * 2n < beforeMax.owed && BigInt(capped.totals.burn.owed) > 5_000_000n,
    `under Max Buy the buyback is cut to the cap: with ${inSol(beforeMax.owed)} SOL to spend it buys ${capped?.tokens} base units, ${Number(size) / 10_000}% of supply, for ${inSol(capped?.lamports ?? 0n)} SOL, and ${inSol(capped?.totals.burn.owed ?? 0n)} SOL stays owed to the burn share`,
  );
  check(beforeMax.supply - (await supply()) === BigInt(capped?.tokens ?? 0n), "and the supply falls by exactly what it bought");
  await closeEdict();

  // -------------------------------------------------------------------------------------------
  await edict("Regulars", ruleOf("regulars", 1), PAYDAY);
  // Somebody sends the keeper tokens, and a program's address holds some too.
  const gift = 5_000n * 10n ** BigInt(TOKEN_DECIMALS);
  // And one small holder sells everything. Selling is never judged.
  await sellShare(leaver, 100n);
  await give(holders[0], keeper.publicKey, gift);
  await give(holders[1], rulebook, gift);
  await finalized(await buy(team, 60));
  const beforeRegulars = await supply();
  console.log("a round under Regulars");
  await keeperRound(NO_PAYOUT);
  lines = await follow();
  const waits = only(lines, "note").filter((line) => line.about === "buyback-waits");
  const owedWaiting = BigInt(lines.at(-1)?.totals.burn.owed ?? "0");
  check(
    waits.length === 1 && only(lines, "buyback").length === 0 && (await supply()) === beforeRegulars && owedWaiting > 5_000_000n,
    `under Regulars the buyback waits, and one line of the ledger says so: "${waits[0]?.text}" ${inSol(owedWaiting)} SOL stays owed`,
  );
  const [leftOut] = only(lines, "credit");
  const [keeperHolds, teamNow, treasuryNow] = await tokensOf([keeper.publicKey, team.publicKey, treasury.publicKey]);
  check(
    !!leftOut && keeperHolds === gift && leftOut.leftOut.project.owners === 3 && BigInt(leftOut.leftOut.project.tokens) === keeperHolds + teamNow + treasuryNow && leftOut.leftOut.program.owners === 1 && BigInt(leftOut.leftOut.program.tokens) === gift,
    "the keeper, holding tokens somebody sent it, is left out of the credit with the treasury and the project wallet, and so is an address only a program can sign for",
  );
  const again = await keeperRound(NO_PAYOUT);
  check(again.out.includes("my buyback is waiting for the next edict") && (await follow()).length === 0, "the next round waits too, and the ledger is not told a second time");
  await closeEdict();

  // -------------------------------------------------------------------------------------------
  await edict("no rule", [], EVEN);
  await sellShare(team, 50n);
  const beforeResume = await supply();
  // In this round and its rehearsal, thirty days are a second: what the wallet that sold everything is owed has waited long enough.
  const A_SECOND = { ...NO_PAYOUT, lapseAfterSecs: 1 };
  console.log("a dry run");
  const [filesBefore, waitingBefore] = [untouched(), (await poolFees()).waiting];
  const rehearsed = await run(node("keeper.ts", "--once"), { ...keeperEnv(A_SECOND), DRY_RUN: "1" });
  check(
    rehearsed.code === 0 && ["would claim", "would send the treasury", "would buy back and burn", "would credit", "would return to the pot"].every((said) => rehearsed.out.includes(said)) && untouched() === filesBefore && (await poolFees()).waiting === waitingBefore,
    "a dry run says what it would claim, send the treasury, buy back, credit and return to the pot, and sends and writes nothing",
  );
  console.log("a round after Regulars");
  await keeperRound(A_SECOND);
  lines = await follow();
  const [lapsed] = only(lines, "lapse");
  check(
    !!lapsed && lapsed.owners === 1 && BigInt(lapsed.lamports) > 0n && BigInt(lapsed.lamports) < LEAST && books().owners[leaver.publicKey.toBase58()] === undefined && !model.owed.has(leaver.publicKey.toBase58()),
    `the ${lapsed?.lamports} lamports owed to the wallet that sold everything, never enough to send, return to the holders' pot once the wait is over`,
  );
  const resumes = lines.findIndex((line) => line.kind === "note" && line.about === "buyback-resumes");
  const [resumed] = only(lines, "buyback");
  check(
    resumes >= 0 && !!resumed && lines.indexOf(resumed) > resumes && BigInt(resumed.found ?? "0") === gift && beforeResume - (await supply()) === BigInt(resumed.tokens) && (await tokensOf([keeper.publicKey]))[0] === 0n,
    `at the next edict the ledger says the buyback resumes, and it buys with ${inSol(resumed?.lamports ?? 0n)} SOL: the supply falls by what it bought and by the tokens somebody had sent the keeper, burned with it`,
  );

  // -------------------------------------------------------------------------------------------
  console.log("a payout round, with the keeper killed four times in the middle of it");
  const ready = [...model.owed.values()].filter((owed) => owed >= LEAST);
  const readySum = ready.reduce((sum, owed) => sum + owed, 0n);
  check(ready.length >= 25 && readySum >= SOL, `${ready.length} holders are owed ${inSol(readySum)} SOL between them: more than the 1 SOL at which I pay`);
  // One transaction at a time, so that the round has more than one moment to be killed in.
  const ONE_BY_ONE = { ...FAST, inFlight: 1 };
  const journal = () => readFileSync(join(privateDir, "round-000001.journal.jsonl"), "utf8").split("\n").filter(Boolean).map((text) => JSON.parse(text) as { t: string; signature: string; outcome?: string });
  // A copy of the keeper's folder as it stands before the round: what a second machine started from a copy of this one's disk would have.
  const copy = join(root, ".local", "e2e-keeper-copy");
  rmSync(copy, { recursive: true, force: true });
  cpSync(dir, copy, { recursive: true });
  rmSync(join(copy, "private", "keeper.lock"), { force: true });
  // The second keeper is shown the first one's payment by the node: the validator must not drop its old blocks in between.
  await clearOfTheNextDrop(100);

  check(await killedAt("attempts recorded", ONE_BY_ONE), "killed with the first transaction signed and written in the journal, and not yet sent");
  const first = journal()[0]?.signature;
  check(journal().length === 1 && (await statusOf(first)) === null && existsSync(join(privateDir, "round-000001.plan.json")) && BigInt((JSON.parse(readFileSync(join(privateDir, "round-000001.plan.json"), "utf8")) as { wallet?: string }).wallet ?? "0") === (await lamportsOf(keeper.publicKey)), "the plan and that signature are on disk, with what the wallet held when the round opened, and the chain has never seen the transaction");
  check(await killedAt("sent", ONE_BY_ONE), "started again, it sends those same bytes; killed before it knows what became of them");
  // The second keeper wakes up now, with the same key and the older records. The first one's payment is seconds old: in a block, and not final.
  const fromTheCopy = await run(node("keeper.ts", "--once"), { ...keeperEnv(ONE_BY_ONE), KEEPER_DIR: copy });
  check(
    fromTheCopy.code === 1 && fromTheCopy.out.includes("my records do not have") && fromTheCopy.out.includes(first) && !existsSync(join(copy, "private", "round-000001.plan.json")),
    "a second keeper with the same key, on a copy of the folder from before the round, sees that payment as soon as a block has it, and pays nobody",
  );
  rmSync(copy, { recursive: true, force: true });
  check(journal().length === 1 && journal()[0].signature === first, "it signed nothing new: the journal still has that one transaction");
  check(await killedAt("outcomes recorded", ONE_BY_ONE), "started again, it finds the transaction in a finalized block and writes that down; killed before the second is signed");
  check(journal().length === 2 && journal()[1].outcome === "landed" && journal()[1].signature === first, "the journal says the first transaction landed");
  check(await killedAt("books written", ONE_BY_ONE), "started again, it pays the rest and closes the round in its books; killed before the public ledger has the line");
  check(books().round === 1 && only(ledger(), "payout").length === 0, "the books are at round 1 and the ledger does not have it yet");
  await keeperRound(ONE_BY_ONE);
  lines = await follow();
  const early = only(lines, "claim").find((line) => BigInt(line.lamports) < SOL / 20n);
  check(
    !!early && lines.some((line, i) => line.kind === "buyback" && i > lines.indexOf(early)),
    `on the way, ${inSol(early?.lamports ?? 0n)} SOL of fees were claimed, less than the 0.05 SOL I claim at, because a buyback was due and part of its SOL was still in the pool`,
  );
  const [round1] = only(lines, "payout");
  check(!!round1 && round1.round === 1 && round1.payments >= 25 && round1.transactions.length > 1 && round1.transactions[0].signature === first, `started once more, the real keeper brings the ledger up: round 1 paid ${round1?.payments} holders in ${round1?.transactions.length} transactions`);
  let onChain = await paidOnChain(ledger());
  check(
    everyHolder.every((holder) => (onChain.received.get(holder.publicKey.toBase58()) ?? 0n) === (model.paid.get(holder.publicKey.toBase58()) ?? 0n) && (onChain.times.get(holder.publicKey.toBase58()) ?? 0) === (model.rounds.get(holder.publicKey.toBase58()) ?? 0)),
    "after four kills every holder was sent what they were owed exactly once, and nobody was left unpaid",
  );
  check(!onChain.received.has(tiny.publicKey.toBase58()) && (model.owed.get(tiny.publicKey.toBase58()) ?? 0n) > 0n, "the smallest holder was not paid: what they are owed is carried forward");
  check(!existsSync(join(privateDir, "round-000001.plan.json")) && existsSync(join(privateDir, "done", "round-000001.journal.jsonl")), "the round's plan and journal are put away");

  // -------------------------------------------------------------------------------------------
  console.log("the smallest holder buys more, and a day passes (the longest wait is set to a second)");
  await finalized(await buy(tiny, 0.5));
  await sellShare(team, 50n);
  const carried = model.owed.get(tiny.publicKey.toBase58()) ?? 0n;
  await keeperRound({ ...FAST, payAtLeastEverySecs: 1 });
  lines = await follow();
  onChain = await paidOnChain(ledger());
  const tinyPaid = onChain.received.get(tiny.publicKey.toBase58()) ?? 0n;
  check(
    only(lines, "payout").length === 1 && tinyPaid === (model.paid.get(tiny.publicKey.toBase58()) ?? 0n) && tinyPaid > carried && tinyPaid >= LEAST && onChain.times.get(tiny.publicKey.toBase58()) === 1,
    `the ${carried} lamports carried forward are paid once they are part of enough: ${inSol(tinyPaid)} SOL in one payment, in round 2`,
  );
  await closeEdict();

  // -------------------------------------------------------------------------------------------
  await edict("Turnstile, open half the time", ruleOf("turnstile", 2), BURN);
  await sellShare(team, 50n);
  const beforeTurn = await supply();
  console.log("a round at the turnstile, a day after the treasury was last paid and the holders last credited (a day is set to a second)");
  await keeperRound({ ...FAST, treasuryAtLeastEverySecs: 1, creditAtLeastEverySecs: 1 });
  lines = await follow();
  const [turned] = only(lines, "buyback");
  check(
    !!turned && beforeTurn - (await supply()) === BigInt(turned.tokens) && only(lines, "note").length === 0,
    `at the turnstile, where a wallet's turn comes and goes every forty seconds, the keeper waits for its own inside the round and buys back in it: ${inSol(turned?.lamports ?? 0n)} SOL`,
  );
  const [smallClaim] = only(lines, "claim");
  const [smallTreasury] = only(lines, "treasury");
  const [smallCredit] = only(lines, "credit");
  check(
    !!smallClaim && !!smallTreasury && !!smallCredit && BigInt(smallTreasury.lamports) < SOL / 20n && BigInt(smallTreasury.lamports) >= LEAST && BigInt(smallCredit.lamports) < SOL / 20n,
    `the day having passed, the treasury is sent the ${inSol(smallTreasury?.lamports ?? 0n)} SOL it is owed and the holders are credited the ${inSol(smallCredit?.lamports ?? 0n)} SOL in their pot, although each is under 0.05 SOL`,
  );

  // -------------------------------------------------------------------------------------------
  console.log("two keepers on one folder");
  const marker = join(dir, "stop-the-first");
  let second: Ran | null = null;
  const firstKeeper = run(node("keeper.ts"), keeperEnv(FAST), () => existsSync(marker));
  // The first has the folder once it has written its lock.
  while (!existsSync(join(privateDir, "keeper.lock"))) await sleep(200);
  second = await run(node("keeper.ts", "--once"), keeperEnv(FAST));
  check(second.code === 1 && second.out.includes("a keeper is already running"), "a second keeper started on the same folder refuses to run");
  writeFileSync(marker, "");
  await firstKeeper;
  rmSync(marker);
  check(existsSync(join(privateDir, "keeper.lock")) && (await keeperRound(FAST)).code === 0, "the first one is killed and leaves its lock behind; the next keeper sees that process is gone and takes over");

  // -------------------------------------------------------------------------------------------
  console.log("asked to stop in the middle of a round");
  // Fees come in, and with a buyback due they are claimed at once.
  await sellShare(team, 50n);
  // Its next round would be five minutes away. The request is sent once its books show a transaction out: it is in the middle of a round then.
  let askedAt = 0;
  const leaving = await run(node("e2e-keeper.ts", "--to-be-stopped"), { ...keeperEnv(FAST), KEEPER_EVERY_SECS: "300" }, undefined, () => {
    try {
      if (books().pending === null) return false;
    } catch {
      // The books are being replaced at this very moment: the next look reads them.
      return false;
    }
    askedAt ||= Date.now();
    return true;
  });
  const took = Date.now() - askedAt;
  const stillOut = books().pending;
  check(
    askedAt > 0 && leaving.code === 0 && leaving.out.includes("is out and its fate is not in my books yet") && leaving.out.trimEnd().endsWith("stopped") && took < 30_000,
    `asked to stop with a transaction out, the keeper finishes the step it is on and leaves ${(took / 1000).toFixed(1)} seconds later, without sitting out the five minutes to its next round`,
  );
  const tookUp = await keeperRound(FAST);
  check(stillOut !== null && tookUp.out.includes(stillOut.signature) && books().pending === null, "and the next start takes up the transaction that was out");

  // -------------------------------------------------------------------------------------------
  console.log("the books and the chain");
  await closeEdict();
  await follow();
  const all = ledger();
  const texts = readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean);
  const kept = books();
  const totals = all.at(-1)!.totals;
  check(texts.every((text, i) => all[i].seq === i + 1 && all[i].prev === (i === 0 ? "" : sha256(texts[i - 1]))), `each of the ledger's ${all.length} lines carries the sha256 of the line before it`);
  const shown = head();
  const short = (line: Line): Line => (line.kind === "payout" ? { ...line, transactions: line.transactions.slice(0, 3) } : line);
  check(
    shown.seq === all.length && shown.last === sha256(texts.at(-1)!) && JSON.stringify(shown.totals) === JSON.stringify(totals) && JSON.stringify(shown.recent) === JSON.stringify(all.slice(-20).map(short)) && shown.mint === mint.publicKey.toBase58() && shown.keeper === keeper.publicKey.toBase58(),
    "ledger-head.json agrees with the ledger: its number, its hash, its totals and its last twenty lines",
  );

  // Edict by edict: what the claims took out plus what is counted and still in the pool is what each edict earned.
  const byEdict = new Map<number, bigint>();
  let exact = true;
  for (const line of only(all, "claim")) {
    let [toTreasury, toBurn, sum] = [0n, 0n, 0n];
    for (const share of line.shares) {
      byEdict.set(share.epoch, (byEdict.get(share.epoch) ?? 0n) + BigInt(share.lamports));
      const split = [EVEN, FUNDING, BURN, PAYDAY, EVEN, BURN][share.epoch];
      exact &&= share.holdersBps === split.holdersBps && share.burnBps === split.burnBps && share.treasuryBps === split.treasuryBps;
      toTreasury += (BigInt(share.lamports) * BigInt(split.treasuryBps)) / 10_000n;
      toBurn += (BigInt(share.lamports) * BigInt(split.burnBps)) / 10_000n;
      sum += BigInt(share.lamports);
    }
    exact &&= BigInt(line.treasury) === toTreasury && BigInt(line.burn) === toBurn && BigInt(line.holders) === sum - toTreasury - toBurn && BigInt(line.lamports) === sum;
  }
  for (const share of kept.inPool) byEdict.set(share.epoch, (byEdict.get(share.epoch) ?? 0n) + BigInt(share.lamports));
  const eachEdict = edge.map((total, i) => total - (edge[i - 1] ?? 0n));
  check(
    eachEdict.every((lamports, epoch) => (byEdict.get(epoch) ?? 0n) === lamports) && byEdict.size === eachEdict.length,
    `across five changes of edict, every edict was counted exactly the fees that came in under it: ${eachEdict.map(inSol).join(", ")} SOL`,
  );
  check(exact, `in all ${only(all, "claim").length} claims each edict's part is shared by that edict's own split, and the treasury's share is exactly its bps of it, rounded down to the lamport`);

  const fees = await poolFees();
  check(fees.ever - fees.waiting === BigInt(totals.claimed), `the pool says ${inSol(fees.ever - fees.waiting)} SOL of fees have left it, and that is what the ledger says was claimed`);
  check((await lamportsOf(treasury.publicKey)) - treasuryStart === BigInt(totals.treasury.paid), `the treasury's wallet received the ${inSol(totals.treasury.paid)} SOL the ledger says it was paid`);
  check(startSupply - (await supply()) === BigInt(totals.burn.tokens), `the supply has fallen by the ${totals.burn.tokens} base units the ledger says were burned`);
  const { received, times } = await paidOnChain(all);
  const sent = [...received.values()].reduce((sum, lamports) => sum + lamports, 0n);
  check(
    sent === BigInt(totals.holders.paid) && [...received.keys()].every((owner) => everyHolder.some((holder) => holder.publicKey.toBase58() === owner)) && everyHolder.every((holder) => (received.get(holder.publicKey.toBase58()) ?? 0n) === (model.paid.get(holder.publicKey.toBase58()) ?? 0n) && (times.get(holder.publicKey.toBase58()) ?? 0) === (model.rounds.get(holder.publicKey.toBase58()) ?? 0)),
    `the holders received ${inSol(sent)} SOL in all, each exactly what was worked out here from their share of every credit, and nobody else received anything`,
  );
  check(
    everyHolder.every((holder) => BigInt(kept.owners[holder.publicKey.toBase58()]?.owed ?? "0") === (model.owed.get(holder.publicKey.toBase58()) ?? 0n)) && Object.keys(kept.owners).length === everyHolder.length - 1,
    "and what the books still owe each of them is what is left of it",
  );
  const sentToNothing = await lamportsOf(penniless.publicKey);
  check(sentToNothing > 0n && sentToNothing === (model.paid.get(penniless.publicKey.toBase58()) ?? 0n), `a holder that had no SOL at all, not even an account at its address, was paid like the others and now holds exactly its ${inSol(sentToNothing)} SOL`);

  // Everything the keeper's key ever paid for, as the chain showed it while the test ran.
  await watchKeeper();
  const inLedger = new Set(all.flatMap((line) => (line.kind === "payout" ? line.transactions.map((one) => one.signature) : line.kind === "claim" || line.kind === "treasury" || line.kind === "buyback" ? [line.signature] : [])));
  const charged = [...witnessed.values()].reduce((sum, seen) => sum + seen.fee, 0n);
  const went = [...witnessed].filter(([, seen]) => seen.landed).map(([signature]) => signature);
  check(
    went.length === inLedger.size && went.every((signature) => inLedger.has(signature)),
    `the keeper's key paid for ${witnessed.size} transactions, ${went.length} of which went through: those are the ${inLedger.size} the ledger lists, and no other`,
  );
  check(charged === BigInt(kept.totals.fees) && kept.totals.fees === totals.fees, `the network charged the keeper ${charged} lamports in fees, which is what its books count`);
  // One by one as well: each set a limit and the price the keeper was run at, and was charged what the two come to by the network's own sum.
  check(
    [...witnessed.values()].every((seen) => seen.asked > 0 && seen.price === PRICE && seen.fee === chargedFor(seen.asked, seen.price) && seen.used <= seen.asked),
    `each of them asked for a limit, set ${PRICE} micro-lamports a unit, and was charged 5,000 lamports and that price on every unit it asked for`,
  );
  // What they really used, kind by kind: the one that used the most of what it asked for.
  const closest = (signatures: string[]) => signatures.map((signature) => witnessed.get(signature)).filter((seen): seen is Seen => !!seen && seen.asked > 0).sort((a, b) => b.used / b.asked - a.used / a.asked)[0];
  const usedMost = [
    ["a claim", closest(only(all, "claim").map((line) => line.signature))],
    ["a payment to the treasury", closest(only(all, "treasury").map((line) => line.signature))],
    ["a buyback", closest(only(all, "buyback").map((line) => line.signature))],
    ["a payout", closest(only(all, "payout").flatMap((line) => line.transactions.map((one) => one.signature)))],
  ] as const;
  check(
    usedMost.every(([, seen]) => !!seen && seen.used > 0),
    `the compute units they used, at the most, of those they asked for: ${usedMost.map(([kind, seen]) => `${kind}${seen && seen.transfers.length > 1 ? ` to ${seen.transfers.length} holders` : ""} ${seen?.used} of ${seen?.asked}`).join(", ")}`,
  );
  const tokenAccountRent = BigInt((await connection.getAccountInfo(ata(keeper.publicKey)))?.lamports ?? 0);
  const keeperNow = await lamportsOf(keeper.publicKey);
  const shouldHold = keeperStart + BigInt(totals.claimed) - BigInt(totals.treasury.paid) - BigInt(totals.burn.spent) - BigInt(totals.holders.paid) - charged - tokenAccountRent;
  check(keeperNow === shouldHold, `the keeper's wallet holds ${inSol(keeperNow)} SOL: what it started with, plus what it claimed, less what it paid the treasury, spent buying back and paid holders, less the network fees and the rent of its one token account`);
  const kept2 = BigInt(totals.treasury.owed) + BigInt(totals.burn.owed) + BigInt(totals.holders.owed);
  check(kept2 === BigInt(totals.claimed) - BigInt(totals.treasury.paid) - BigInt(totals.burn.spent) - BigInt(totals.holders.paid) && keeperNow >= kept2, `of that, ${inSol(kept2)} SOL is fees it still owes: ${inSol(totals.treasury.owed)} to the treasury, ${inSol(totals.burn.owed)} to burn, ${inSol(totals.holders.owed)} to holders`);
  check((await connection.getAccountInfo(solVault)) !== null && all.filter((line) => line.kind === "note").length === 2, "the ledger has two notes of the keeper's own: the buyback waiting, and resuming");

  // -------------------------------------------------------------------------------------------
  console.log("the guardian names another keeper");
  // First the keeper claims once more, under an edict with no rule and with settings that pay
  // nothing out, so that it holds something for each of the three when the guardian acts.
  await edict("no rule", [], EVEN);
  await finalized(await buy(team, 30));
  await keeperRound({ ...FAST, treasuryAtLamports: HUGE, minBuyLamports: HUGE, payWhenLamports: HUGE });
  lines = await follow();
  const held = books();
  const owedThen = [...model.owed.values()].filter((owed) => owed >= LEAST).length;
  check(
    only(lines, "claim").length === 1 && BigInt(held.totals.treasury.owed) > SOL / 20n && BigInt(held.totals.burn.owed) > SOL / 20n && owedThen >= 25,
    `the keeper holds ${inSol(held.totals.treasury.owed)} SOL for the treasury, ${inSol(held.totals.burn.owed)} SOL to buy back with and ${inSol(held.credited)} SOL credited to holders, ${owedThen} of them owed enough to send`,
  );
  const next = Keypair.generate();
  await send("naming another keeper", tx(setKeeperIx({ program: HOOK, guardian: guardian.publicKey, mint: mint.publicKey, keeper: next.publicKey })), [guardian]);
  // Trading goes on, and fees come into the pool that are no longer this keeper's to claim.
  await sellShare(team, 20n);
  const pooled = await poolFees();
  // The real keeper script, left running with every number as it ships: it takes its rounds two seconds apart, and ends by itself.
  const last = await run(node("keeper.ts"), keeperEnv(FAST));
  await watchKeeper();
  lines = await follow();
  const end = books();
  const farewell = lines.at(-1);
  check(
    last.code === 0 && last.out.includes(`the rulebook names ${next.publicKey.toBase58()} as the keeper, not my key ${keeper.publicKey.toBase58()}`) && last.out.includes("stopped for good"),
    "left running, the old keeper pays out round by round, says it has stopped for good, and its process ends by itself",
  );
  check(
    farewell?.kind === "note" && farewell.about === "retired" && farewell.text.includes(next.publicKey.toBase58()) && end.retired?.keeper === next.publicKey.toBase58(),
    `the last line of its ledger says so, and what is left with it: "${farewell?.kind === "note" ? farewell.text : ""}"`,
  );
  const poolNow = await poolFees();
  check(
    only(lines, "claim").length === 0 && end.totals.claimed === held.totals.claimed && poolNow.ever - poolNow.waiting === pooled.ever - pooled.waiting && pooled.waiting > 0n && poolNow.waiting >= pooled.waiting,
    `it claimed nothing more: the ${inSol(poolNow.waiting)} SOL of fees waiting in the pool are the next keeper's`,
  );
  check(
    end.totals.treasury.owed === "0" && only(lines, "treasury").length === 1 && BigInt(only(lines, "treasury")[0].lamports) === BigInt(held.totals.treasury.owed) && (await lamportsOf(treasury.publicKey)) - treasuryStart === BigInt(end.totals.treasury.paid),
    `the treasury was sent the ${inSol(held.totals.treasury.owed)} SOL it was owed, without waiting for the sum it is usually sent at`,
  );
  check(
    only(lines, "buyback").length >= 1 && BigInt(end.totals.burn.owed) < chargedFor(UNITS.buyback, PRICE) && startSupply - (await supply()) === BigInt(end.totals.burn.tokens),
    `the burn share bought the token back in ${only(lines, "buyback").length} buys, until the ${end.totals.burn.owed} lamports left would not pay a buyback's own fee`,
  );
  const paidInTheEnd = await paidOnChain(ledger());
  check(
    only(lines, "payout").length === 1 && only(lines, "payout")[0].payments === owedThen && Object.values(end.owners).every((entry) => BigInt(entry.owed) < LEAST) &&
      everyHolder.every((holder) => (paidInTheEnd.received.get(holder.publicKey.toBase58()) ?? 0n) === (model.paid.get(holder.publicKey.toBase58()) ?? 0n) && (paidInTheEnd.times.get(holder.publicKey.toBase58()) ?? 0) === (model.rounds.get(holder.publicKey.toBase58()) ?? 0)),
    `the ${owedThen} holders owed 0.001 SOL or more were each sent all of it, once, in a round that did not wait to be full; what is left is owed in sums under the least I send`,
  );
  const chargedInAll = [...witnessed.values()].reduce((sum, seen) => sum + seen.fee, 0n);
  const heldInTheEnd = await lamportsOf(keeper.publicKey);
  const t = end.totals;
  check(
    chargedInAll === BigInt(t.fees) && heldInTheEnd === keeperStart + BigInt(t.claimed) - BigInt(t.treasury.paid) - BigInt(t.burn.spent) - BigInt(t.holders.paid) - chargedInAll - tokenAccountRent,
    `the old keeper's wallet holds ${inSol(heldInTheEnd)} SOL, which is its own SOL and the ${inSol(BigInt(t.claimed) - BigInt(t.treasury.paid) - BigInt(t.burn.spent) - BigInt(t.holders.paid))} SOL its ledger says is left: books and chain agree to the lamport`,
  );
  const [linesThen, booksThen] = [ledger().length, readFileSync(booksFile, "utf8")];
  const oncemore = await run(node("keeper.ts", "--once"), keeperEnv(FAST));
  check(oncemore.code === 1 && oncemore.out.includes("stopped for good") && ledger().length === linesThen && readFileSync(booksFile, "utf8") === booksThen, "started again, it says the same and changes nothing");
  clearInterval(watch);

  console.log(failures ? `\n${failures} check(s) FAILED. The keeper's folder is left at ${dir}` : "\nall checks passed");
  if (!failures) rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

// A process started with --to-be-stopped has run the keeper above, and has no test to run.
if (!toBeStopped) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
