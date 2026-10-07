// The keeper: the process that takes the trading fees out of the pool and pays them out as
// each edict says. The treasury's share goes to the treasury, the burn share buys the token
// back and burns it, and the holders' share is paid to holders in SOL.
//
// It holds one key, the keeper's, which the rulebook names: the hook program claims the fees
// for that key and for nobody else. The key is not exempt from the buying rules, so its
// buyback is a buy like anyone's. Network fees come out of the keeper's own SOL, never out of
// the fees it keeps for others.
//
//   fees.ts      reading the pool and the rulebook, counting fees to edicts, the claim and the buyback
//   holders.ts   who the holders are, what each is owed, payout rounds
//   books.ts     the books, the public ledger, the files, the lock
//   round.ts     one round, start to finish
import { Retired, turn, type KeeperContext, type KeeperOutcome } from "./round.js";

export type { KeeperContext, KeeperOutcome };
export { Retired };
export { AlreadyRunning, type Head, type Line, type Totals } from "./books.js";
export { DEFAULTS, plain, settingsFrom, type Settings } from "./settings.js";

/**
 * One round: read, count, and do what is due. Safe to call every 20 seconds. It picks up from
 * its files after a crash at any point, and gives up at the next step once `ctx.signal` is aborted.
 *
 * Under `ctx.dir` it writes `public/ledger.jsonl` and `public/ledger-head.json`, which the site
 * reads, and keeps everything else under `private/`.
 *
 * It throws when a person has to look. Two of its errors mean the loop that calls it has no
 * reason to go on: `AlreadyRunning`, when another process holds the folder, and `Retired`, when
 * the guardian has named another keeper and this one has paid out what it held.
 */
export const round = (ctx: KeeperContext): Promise<KeeperOutcome> => turn(ctx);
