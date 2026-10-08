// The Meteora DBC config the token trades on: one constant-product curve that cannot graduate.
//
// Meteora removes a token's hook in the buy that fills its curve (its "graduation"), and the
// agent's rules go with the hook. A curve is full when the SOL in it reaches a number written
// in its config for good. Here that number is GRADUATION_SOL, many times all the SOL there
// is, so the curve is the token's pool for life: the SOL in it can only leave through sells.
import {
  ActivationType,
  BaseFeeMode,
  buildCurveWithCustomSqrtPrices,
  CollectFeeMode,
  getSqrtPriceFromMarketCap,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";

export const TOTAL_SUPPLY = 1_000_000_000;
export const TOKEN_DECIMALS = 6;
/** The curve is priced in SOL, which has nine decimals. */
const SOL_DECIMALS = 9;
/** Meteora keeps this share of every trading fee; the rest is the project's. */
export const METEORA_FEE_SHARE = 0.2;

/**
 * The SOL the curve would have to hold to graduate: nine billion, whatever SOL is worth.
 * Meteora keeps this number in lamports in 64 bits, which have room for about twice as much.
 * Nine billion is the largest round number that also fits the signed 64-bit numbers a good
 * deal of software keeps amounts in. Larger ones were already in use when this was written:
 * seventeen configs with a hook were set to ten billion.
 */
export const GRADUATION_SOL = 9_000_000_000;
/**
 * All the SOL there was in October 2026, to the nearest million. It grows by under 4% a year,
 * a rate that falls to 1.5%: at that pace there are nine billion SOL in about 175 years, and
 * graduating would take every one of them in this curve at once.
 */
export const SOL_IN_EXISTENCE = 635_000_000;

export type CurveInput = {
  /** Market cap the token starts at, in SOL. With a single curve this is also its depth. */
  startCapSol: number;
  /** Fee on every buy and sell, in bps. Meteora fixes it per config: it cannot change later. */
  feeBps: number;
  /** Whether the token's name and ticker can change after launch. Also fixed with the config. */
  renamable?: boolean;
};

export function curveConfig({ startCapSol, feeBps, renamable }: CurveInput) {
  // Meteora writes a price as the square root of lamports per smallest unit of token, times 2^64.
  const start = getSqrtPriceFromMarketCap(startCapSol, TOTAL_SUPPLY, TOKEN_DECIMALS, SOL_DECIMALS);
  // One constant-product curve, like pump.fun's: it trades as a pool would that opened with
  // the whole supply on one side and startCapSol of SOL on the other. This number is its depth.
  const liquidity = new BN(TOTAL_SUPPLY).mul(new BN(10 ** TOKEN_DECIMALS)).mul(start);
  // The curve ends at the price it would have with GRADUATION_SOL in it.
  const threshold = new BN(GRADUATION_SOL).mul(new BN(10 ** SOL_DECIMALS));
  const end = start.add(threshold.shln(128).div(liquidity));

  // The SDK's builder puts the token, the fee and what a graduation would do in the form the
  // program takes. Given the same two prices it draws this curve too, but its rounding leaves
  // the threshold short of the round number, by 840 SOL for a start at 30, so the curve's own
  // three numbers are set exactly, after it. (buildCurveWithMarketCap, its builder for one
  // segment between two market caps, fails on a range this wide.)
  const built = buildCurveWithCustomSqrtPrices({
    sqrtPrices: [start, end],
    token: {
      tokenType: TokenType.Token2022,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: SOL_DECIMALS,
      // Nobody can mint more. The metadata is sealed, or left with the pool's creator, who
      // hands it to the rulebook as soon as the pool exists.
      tokenAuthorityOption: renamable ? TokenAuthorityOption.CreatorUpdateAuthority : TokenAuthorityOption.Immutable,
      totalTokenSupply: TOTAL_SUPPLY,
      leftover: 0,
    },
    fee: {
      // a flat fee: same start and end, no decay
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: feeBps, endingFeeBps: feeBps, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false,
      // fees are taken in SOL on both buys and sells
      collectFeeMode: CollectFeeMode.QuoteToken,
      // everything Meteora does not keep goes to the config's fee claimer
      creatorTradingFeePercentage: 0,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    // What a graduation would do, which the program wants said even for a curve that cannot
    // have one: all liquidity would go to the fee claimer, locked.
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps200,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 100,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
  });
  return { ...built, sqrtStartPrice: start, curve: [{ sqrtPrice: end, liquidity }], migrationQuoteThreshold: threshold };
}
