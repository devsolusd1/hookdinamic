// The Meteora DBC config the token trades on: one constant-product curve that never graduates.
//
// Meteora removes a token's hook in the buy that fills its curve, so the hook lives exactly
// as long as the curve does. The graduation market cap is therefore put far out of reach
// (about US$ 1 billion), and the curve is the token's pool for life: the SOL in it can only
// leave through sells.
import {
  ActivationType,
  BaseFeeMode,
  buildCurveWithLiquidityWeights,
  CollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

export const TOTAL_SUPPLY = 1_000_000_000;
export const TOKEN_DECIMALS = 6;
/** Meteora keeps this share of every trading fee; the rest is the project's. */
export const METEORA_FEE_SHARE = 0.2;

export type CurveInput = {
  /** Market cap the token starts at, in SOL. With a single curve this is also its depth. */
  startCapSol: number;
  /** Market cap at which the curve would graduate, in SOL. Meant never to be reached. */
  graduationCapSol: number;
  /** Fee on every buy and sell, in bps. Meteora fixes it per config: it cannot change later. */
  feeBps: number;
  /** Whether the token's name and ticker can change after launch. Also fixed with the config. */
  renamable?: boolean;
};

export function curveConfig({ startCapSol, graduationCapSol, feeBps, renamable }: CurveInput) {
  // Sixteen segments of equal liquidity are one constant-product curve, like pump.fun's.
  // The SDK's single-segment builder (buildCurveWithMarketCap) refuses a range this wide:
  // past about 30,000 times the start cap its own rounding leaves it a few lamports short.
  return buildCurveWithLiquidityWeights({
    liquidityWeights: Array(16).fill(1),
    token: {
      tokenType: TokenType.Token2022,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: 9,
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
    // Only matters if the curve ever fills: all liquidity would go to the fee claimer, locked.
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
    initialMarketCap: startCapSol,
    migrationMarketCap: graduationCapSol,
  });
}
