// The keeper, running. Start it and leave it: every 20 seconds it reads the pool and the
// rulebook, counts the fees that came in to the edict in force, and does what is due: claims
// the fees, sends the treasury its share, buys back and burns, credits and pays the holders.
//
//   npm run keeper            runs until stopped
//   npm run keeper -- --once  takes one round and exits
//
// Asked to stop (Ctrl-C, or SIGTERM from a host), it finishes the step it is on and leaves at
// once. It also ends by itself in two cases: another keeper already holds its folder, or the
// guardian has named another keeper and this one has paid out everything it held.
//
// Settings come from the environment, or from a .env file next to package.json:
//   RPC_URL, HOOK_PROGRAM, MINT, POOL   where the token lives
//   KEEPER_KEYPAIR                      path to the keeper's keypair file (keep it out of the repository)
//   TREASURY                            the address the treasury's share is sent to
//   KEEPER_DIR                          its folder: public/ is the ledger the site shows, private/ its books (default keeper)
//   KEEPER_EVERY_SECS                   how often it takes a round (default 20)
//   KEEPER_OWN_WALLETS                  the project's own wallets, separated by commas: they are never paid as holders
//   KEEPER_SETTINGS                     any of the numbers in src/keeper/settings.ts, as JSON, to replace its defaults
//   DRY_RUN=1                           work out and print; send and write nothing
import { existsSync, readFileSync } from "node:fs";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AlreadyRunning, plain, Retired, round, settingsFrom, type KeeperContext, type KeeperOutcome } from "../src/keeper/index.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const env = (name: string, fallback?: string) => {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const stamp = () => new Date().toISOString();
const settings = settingsFrom(JSON.parse(process.env.KEEPER_SETTINGS || "{}") as Record<string, unknown>);
const ownWallets = (process.env.KEEPER_OWN_WALLETS || "").split(",").map((address) => address.trim()).filter(Boolean);
// A wallet listed with a typo would be paid as a holder: every address is checked before anything starts.
for (const address of ownWallets) new PublicKey(address);

const stop = new AbortController();
const connection = new Connection(env("RPC_URL"), "confirmed");
const ctx: KeeperContext = {
  connection,
  dbc: DynamicBondingCurveClient.create(connection, "confirmed"),
  hookProgram: new PublicKey(env("HOOK_PROGRAM")),
  mint: new PublicKey(env("MINT")),
  pool: new PublicKey(env("POOL")),
  keeper: Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(env("KEEPER_KEYPAIR"), "utf8")))),
  treasury: new PublicKey(env("TREASURY")),
  dir: env("KEEPER_DIR", "keeper"),
  dryRun: process.env.DRY_RUN === "1",
  signal: stop.signal,
  settings: { ...settings, ownWallets: [...(settings.ownWallets ?? []), ...ownWallets] },
  report: (line) => console.log(`${stamp()} ${line}`),
};

let said: string | null = null;
function report(event: KeeperOutcome | { status: "error"; error: unknown }) {
  // What a round did was already said as it happened. Waiting, and an error that repeats, are said once.
  if (event.status === "settled") return void (said = null);
  // An error is printed as one line with every web address cut down to its host: a node's complaint can quote the RPC address, which carries its key.
  const line = event.status === "waiting" ? `waiting: ${event.reason}` : `error: ${plain(event.error)}`;
  // The figures in "nothing is due" move with every trade: it is the same news.
  const news = line.startsWith("waiting: nothing is due") ? "nothing is due" : line;
  if (news === said) return;
  said = news;
  console.log(`${stamp()} ${line}`);
}

console.log(`${stamp()} keeper ${ctx.keeper.publicKey.toBase58()} on token ${ctx.mint.toBase58()}, treasury ${ctx.treasury.toBase58()}, folder ${ctx.dir}${ctx.dryRun ? " (dry run)" : ""}`);
if (process.argv.includes("--once")) {
  try {
    report(await round(ctx));
  } catch (error) {
    report({ status: "error", error });
    process.exitCode = 1;
  }
} else {
  // Asked to stop, it finishes the step it is on and leaves: whatever is out is picked up from the files at the next start.
  process.on("SIGINT", () => stop.abort());
  process.on("SIGTERM", () => stop.abort());
  const everySecs = Number(env("KEEPER_EVERY_SECS", "20"));
  while (!stop.signal.aborted) {
    try {
      report(await round(ctx));
    } catch (error) {
      report({ status: "error", error });
      // Another keeper holds the folder: this one has no business waiting for it.
      if (error instanceof AlreadyRunning) { process.exitCode = 1; break; }
      // The guardian has named another keeper, and this one has paid out what it held: it is done.
      if (error instanceof Retired) break;
    }
    // Asked to stop while the round was in hand: there is no interval to wait out.
    if (stop.signal.aborted) break;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); stop.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, everySecs * 1000);
      stop.signal.addEventListener("abort", done, { once: true });
    });
  }
  if (stop.signal.aborted) console.log(`${stamp()} stopped`);
}
