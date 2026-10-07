// The keeper's numbers, in one place. Amounts are lamports, as bigint. Every one of them can be
// changed without touching the code: `round` takes a partial set, and scripts/keeper.ts reads
// one from KEEPER_SETTINGS.

export type Settings = {
  /** Take the fees out of the pool once this much is waiting there. */
  claimAtLamports: bigint;
  /** The treasury is sent its share once it is owed this much, and at the latest this long after the last time. */
  treasuryAtLamports: bigint;
  treasuryAtLeastEverySecs: number;
  /** The least SOL a buyback is sent with, and the most in one transaction. */
  minBuyLamports: bigint;
  maxBuyLamports: bigint;
  /** How far the price may move against a buyback between quoting it and landing, in bps. */
  slippageBps: number;
  /** How long a round waits for a rule that closes for seconds (a turn at the turnstile, the next minute) to open to the buyback. */
  buybackWaitSecs: number;
  /** The holders' pot is credited once it holds this much, or after the longest wait whatever it holds. */
  creditWhenLamports: bigint;
  creditAtLeastEverySecs: number;
  /** A payout round is run once this much is ready to send, or after the longest wait if anything is. */
  payWhenLamports: bigint;
  payAtLeastEverySecs: number;
  /** The least I send. Never less than the rent-exempt minimum, so a payment to an empty wallet goes through. */
  minPaymentLamports: bigint;
  /** How long a sum owed to somebody who holds nothing waits before it returns to the pot. */
  lapseAfterSecs: number;
  /** The project's own wallets, besides the keeper and the treasury. They are never paid as holders. */
  ownWallets: string[];
  /** Program-derived owners that can spend SOL after all, a multisig's vault for one. They are paid. */
  alsoPay: string[];
  /** Transfers in one payout transaction. Twenty fit, with the two instructions that set the fee. */
  batchSize: number;
  /** Payout transactions sent and watched at the same time. */
  inFlight: number;
  /** The priority fee every transaction of mine sets, in micro-lamports per compute unit. */
  microLamportsPerUnit: number;
  /** How long between two looks at a transaction that is out. */
  pollMs: number;
  /** Blocks past a blockhash's last valid height before a transaction nobody has seen is called dead. */
  expiryMargin: number;
};

const SOL = 1_000_000_000n;
const DAY = 24 * 3_600;

export const DEFAULTS: Settings = {
  claimAtLamports: SOL / 20n,
  treasuryAtLamports: SOL / 20n,
  treasuryAtLeastEverySecs: DAY,
  minBuyLamports: SOL / 200n,
  maxBuyLamports: SOL,
  slippageBps: 100,
  buybackWaitSecs: 30,
  creditWhenLamports: SOL / 20n,
  creditAtLeastEverySecs: DAY,
  payWhenLamports: SOL,
  payAtLeastEverySecs: DAY,
  minPaymentLamports: SOL / 1_000n,
  lapseAfterSecs: 30 * DAY,
  ownWallets: [],
  alsoPay: [],
  batchSize: 20,
  inFlight: 10,
  microLamportsPerUnit: 10_000,
  pollMs: 2_000,
  expiryMargin: 30,
};

/**
 * Settings as a person writes them in JSON: any of the names above, amounts in lamports as a
 * number or as text. Throws on a name it does not know, so a typo is not taken for a default.
 */
export function settingsFrom(given: Record<string, unknown>): Partial<Settings> {
  const settings: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(given)) {
    if (!(name in DEFAULTS)) throw new Error(`there is no keeper setting called "${name}"`);
    const usual = DEFAULTS[name as keyof Settings];
    if (typeof usual === "bigint") {
      if (typeof value !== "string" && !Number.isSafeInteger(value)) throw new Error(`"${name}" is a whole number of lamports`);
      settings[name] = BigInt(value as string | number);
      if ((settings[name] as bigint) < 0n) throw new Error(`"${name}" cannot be negative`);
    } else if (typeof usual === "number") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`"${name}" is a number`);
      settings[name] = value;
    } else {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`"${name}" is a list of addresses`);
      settings[name] = value;
    }
  }
  return settings as Partial<Settings>;
}

/** A whole number of smallest units as a decimal number, for a sentence: lamports with 9 decimals, the token's base units with 6. */
export function inUnits(units: bigint | string, decimals: number): string {
  const value = BigInt(units);
  const digits = (value < 0n ? -value : value).toString().padStart(decimals + 1, "0");
  const text = `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`.replace(/0+$/, "").replace(/\.$/, "");
  return `${value < 0n ? "-" : ""}${text}`;
}

/** Lamports as SOL, for a sentence. */
export const inSol = (lamports: bigint | string) => `${inUnits(lamports, 9)} SOL`;

/**
 * An error as one line that is safe to print. A node's complaint can quote the address it was
 * asked at, and an RPC address carries its key: only the host of any address is kept. The same
 * as `plain` in scripts/serve.ts.
 */
export function plain(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0].replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/g, (address) => {
    try {
      return new URL(address).origin;
    } catch {
      return "(an address)";
    }
  });
}
