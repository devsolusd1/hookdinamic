// The pool's latest trades, read from an RPC node: the buys, the sells, and the buys the
// hook refused. Nothing but fetch, so it runs as it is in a browser and in Node.
//
// A public node allows few calls. Solana's devnet endpoint, measured in October 2026, takes
// about ten getTransaction calls in ten seconds from one IP address and needs up to twenty
// seconds to forget them; a batch counts one call for every transaction in it plus one for
// itself, and a call it turns away counts too. So one reading is two requests at most: the
// list of signatures, then a single batch for the transactions not read before, never more
// than eight, and never more than eight in any twelve seconds however often a reading is
// asked for. What is left over comes with the next reading.

/** Meteora's bonding-curve program, and the address that owns the vaults of every curve. The hook knows a buy by the same address. */
const DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM";
const TOTAL_SUPPLY = 1_000_000_000;

/** The most transactions one reading asks for. */
const PER_READING = 8;
/** How many calls are in flight at once, on an endpoint that does not take batches. */
const AT_ONCE = 4;
const TIMEOUT_MS = 10_000;

/** What the node is asked for in any stretch of this long is kept under PER_READING, however often a reading is wanted. */
const BUDGET_MS = 12_000;
/** When each transaction was asked for, by endpoint. */
const spent = new Map();

/** How many transactions this endpoint can still be asked for right now. */
function allowance(rpcUrl) {
  const recent = (spent.get(rpcUrl) ?? []).filter((time) => Date.now() - time < BUDGET_MS);
  spent.set(rpcUrl, recent);
  return Math.max(0, PER_READING - recent.length);
}

/** The node's answer when it is turning requests away. */
const BUSY = Symbol("busy");
/** Endpoints that turned a batch down. They are asked for one transaction at a time. */
const unbatched = new Set();

async function post(rpcUrl, body, signal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : (signal ?? timeout),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const request = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, params });

/** What the node said to one request: its result, BUSY, or null if it had nothing or an error of its own. */
const said = (answer) => (!answer || answer.error?.code === 429 ? BUSY : (answer.result ?? null));

/** One call: the node's answer as it came ({ result } or { error }), or BUSY. */
async function call(rpcUrl, method, params, signal) {
  const { status, body } = await post(rpcUrl, request(method, params), signal);
  if (status === 429 || body?.error?.code === 429) return BUSY;
  if (status !== 200 || !body) throw new Error(`the RPC answered ${status}`);
  return body;
}

/**
 * The same call with several sets of parameters: for each, its result, BUSY, or null. One
 * batch where the endpoint takes one, a few calls at a time where it does not.
 */
async function callEach(rpcUrl, method, each, { signal, batch }) {
  if (batch && each.length > 1 && !unbatched.has(rpcUrl)) {
    const { status, body } = await post(rpcUrl, each.map((params, id) => request(method, params, id)), signal);
    if (status === 429 || body?.error?.code === 429) return each.map(() => BUSY);
    if (status >= 500) throw new Error(`the RPC answered ${status}`);
    if (status === 200 && Array.isArray(body)) {
      // The answers come back in any order, and the ones over the limit as errors of their own.
      const answers = new Map(body.map((answer) => [answer.id, answer]));
      return each.map((_, id) => said(answers.get(id)));
    }
    unbatched.add(rpcUrl);
  }
  const results = new Array(each.length);
  let next = 0;
  const worker = async () => {
    while (next < each.length) {
      const i = next++;
      const answer = await call(rpcUrl, method, each[i], signal);
      results[i] = answer === BUSY ? BUSY : said(answer);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, each.length) }, worker));
  return results;
}

/**
 * What one transaction did to the pool. `tx` is a getTransaction result in "jsonParsed".
 *
 *   buy      tokens left the pool's vault and SOL went in
 *   sell     tokens went into the vault and SOL came out
 *   refused  the transaction failed because the hook turned a buy down; `sol` and `tokens`
 *            are what the buyer asked for, none of which moved
 *   other    anything else: the pool's creation, a fee claim, a trade that failed for a
 *            reason of its own (slippage, not enough SOL)
 */
export function classify(tx, { pool, mint, hookProgram, supply = TOTAL_SUPPLY, program = DBC_PROGRAM, poolAuthority = POOL_AUTHORITY }) {
  const trade = (kind, sol = null, tokens = null) => ({ kind, sol, tokens, sharePct: tokens === null ? null : (tokens / supply) * 100 });
  const meta = tx?.meta;
  if (!meta) return trade("other");
  const inner = (meta.innerInstructions ?? []).map((group) => group.instructions);

  if (meta.err) {
    // Other programs use the same small numbers (the system program's 1 is "not enough SOL"),
    // so it is a refusal only when the hook is the program that failed, and with its code 1.
    if (!(meta.logMessages ?? []).includes(`Program ${hookProgram} failed: custom program error: 0x1`)) return trade("other");
    // The node keeps what ran before the refusal. In a buy the SOL goes in, then the tokens
    // come out and Token-2022 calls the hook, so those two transfers are the last ones made.
    const steps = inner[inner.length - 1] ?? [];
    let sol = null;
    let tokens = null;
    for (let i = steps.length - 1; i >= 0 && sol === null; i--) {
      const sent = steps[i].parsed?.type === "transferChecked" ? steps[i].parsed.info : null;
      if (!sent?.tokenAmount) continue;
      const amount = Number(sent.tokenAmount.amount) / 10 ** sent.tokenAmount.decimals;
      if (tokens === null) {
        if (sent.mint === mint) tokens = amount;
      } else if (sent.mint !== mint) sol = amount;
    }
    return trade("refused", sol, tokens);
  }

  // The pool's two vaults: the token accounts its authority owns, among the accounts the curve
  // program was handed together with the pool. One holds the token, the other the SOL.
  const keys = tx.transaction.message.accountKeys.map((key) => key.pubkey ?? key);
  const handed = new Set(
    [...tx.transaction.message.instructions, ...inner.flat()]
      .filter((instruction) => instruction.programId === program && instruction.accounts?.includes(pool))
      .flatMap((instruction) => instruction.accounts),
  );
  const change = (ofToken) => {
    let units = 0n;
    let decimals = 0;
    for (const [rows, sign] of [[meta.preTokenBalances, -1n], [meta.postTokenBalances, 1n]]) {
      for (const row of rows ?? []) {
        if (row.owner !== poolAuthority || (row.mint === mint) !== ofToken || !handed.has(keys[row.accountIndex])) continue;
        units += sign * BigInt(row.uiTokenAmount.amount);
        decimals = row.uiTokenAmount.decimals;
      }
    }
    return Number(units) / 10 ** decimals;
  };
  const tokens = change(true);
  const sol = change(false);
  if (tokens < 0 && sol > 0) return trade("buy", sol, -tokens);
  if (tokens > 0 && sol < 0) return trade("sell", -sol, tokens);
  return trade("other");
}

/**
 * For each cache a caller keeps: the stretch of the chain's clock over which every one of the
 * pool's transactions has been read into it, `from` one second `to` another.
 */
const whole = new WeakMap();

/**
 * From which second of the chain's clock on every transaction in `listed`, newest first, has
 * been read: the second after the newest one that has not. Zero when all of them have and the
 * list is the pool's whole history. Infinity when the one it turns on has no time to go by.
 */
function wholeFrom(listed, limit, got) {
  const gap = listed.findIndex((entry) => !got(entry.signature));
  // Nothing missing, and fewer than were asked for: there is nothing older.
  if (gap < 0 && listed.length < limit) return 0;
  // With nothing missing, the oldest one listed stands for whatever is older and was not: that may share its second.
  const edge = gap < 0 ? listed.at(-1) : listed[gap];
  return Number.isFinite(edge?.blockTime) ? edge.blockTime + 1 : Infinity;
}

/**
 * The pool's latest transactions, newest first:
 *
 *   { signature, at, kind: "buy" | "sell" | "refused" | "other", sol, tokens, sharePct }
 *
 * `at` is in unix seconds; `sharePct` is `tokens` as a percentage of the supply. `sol`,
 * `tokens` and `sharePct` are null where there is no amount to speak of.
 *
 *   limit    how many of the pool's latest transactions to list
 *   before   a signature: list from the transaction before it, to page back
 *   known    what the caller has read already, so that it is not read again.
 *            A Map: this fills it (signature to trade) and returns the whole list every
 *            time, taking from the map what was read before. Pass the same one each time.
 *            A Set or an array of signatures: those are left out of what comes back.
 *   signal   an AbortSignal, to give up
 *   batch    false to ask for the transactions one call each instead of in a batch
 *
 * One reading asks for eight transactions at most, the newest it has not read. The ones
 * beyond that, the ones the node turned away and the ones it lists but cannot show yet are
 * left out, and come with a later reading: with a Map and a reading every twenty seconds
 * the list fills in by itself. It rejects if the node would not give the list of
 * signatures, or turned away every transaction it was asked for. The list that comes back
 * carries two flags about the newest transaction: `pending` and `behind` (see the end).
 *
 * With a Map and no `before` it also carries `since`: the unix second from which on every
 * transaction of the pool is in the Map, so that whoever counts them knows from when a count
 * is whole. It reaches back across readings for as long as each one joins the one before it,
 * and is Infinity when that cannot be said. It costs no call of its own.
 */
export async function recentTrades(rpcUrl, { pool, mint, hookProgram, limit = 8, before, known, signal, batch = true, ...rest } = {}) {
  const answer = await call(rpcUrl, "getSignaturesForAddress", [pool, { limit, commitment: "confirmed", ...(before ? { before } : {}) }], signal);
  if (answer === BUSY) throw new Error("the RPC is turning requests away");
  if (answer.error) throw new Error(answer.error.message);
  const listed = answer.result;

  const cache = known instanceof Map ? known : null;
  const seen = known instanceof Map || known instanceof Set ? known : new Set(known ?? []);
  // The newest it has not read, and no more than the node has room for after the readings just before.
  const asked = listed.filter((entry) => !seen.has(entry.signature)).slice(0, allowance(rpcUrl));
  const read = new Map();
  let answers = [];
  if (asked.length) {
    spent.get(rpcUrl).push(...asked.map(() => Date.now()));
    answers = await callEach(
      rpcUrl,
      "getTransaction",
      // Anybody can trade on the pool, in any format the network carries: mainnet has version 1 as
      // well as 0, and a node refuses to show one to a caller that asks for less.
      asked.map((entry) => [entry.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]),
      { signal, batch },
    );
    if (answers.every((tx) => tx === BUSY)) throw new Error("the RPC is turning requests away");
    asked.forEach((entry, i) => {
      const tx = answers[i];
      if (!tx || tx === BUSY) return;
      const trade = {
        signature: entry.signature,
        at: entry.blockTime ?? tx.blockTime ?? Math.floor(Date.now() / 1000),
        ...classify(tx, { pool, mint, hookProgram, ...rest }),
      };
      read.set(entry.signature, trade);
      cache?.set(entry.signature, trade);
    });
  }
  const out = listed.map((entry) => read.get(entry.signature) ?? cache?.get(entry.signature)).filter(Boolean);
  // Whether the newest transaction listed is missing from what comes back, and why: the node
  // had it listed but could not show it yet ("pending": ask again in a moment), or this page
  // was not let in to read it ("behind": what it shows may be missing the latest).
  const newest = listed[0]?.signature;
  const missing = newest !== undefined && !read.has(newest) && !seen.has(newest);
  const got = missing ? answers[asked.findIndex((entry) => entry.signature === newest)] : undefined;
  out.pending = missing && got === null;
  out.behind = missing && !out.pending;
  if (cache && !before) {
    const since = wholeFrom(listed, limit, (signature) => cache.has(signature));
    const earlier = whole.get(cache);
    // This reading joins the ones before it when it reaches back to the newest transaction
    // they had listed: then nothing can have come and gone unread between them.
    const joined = earlier !== undefined && since <= earlier.to;
    const from = joined ? Math.min(earlier.from, since) : since;
    if (Number.isFinite(since)) whole.set(cache, { from, to: Math.max(joined ? earlier.to : 0, listed[0]?.blockTime ?? 0) });
    out.since = Number.isFinite(since) ? from : Infinity;
  }
  return out;
}
