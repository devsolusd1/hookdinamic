// SOL's price, to turn a market cap in dollars into one in SOL.
const SOL = "So11111111111111111111111111111111111111112";

export async function solPriceUsd(): Promise<number> {
  const response = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL}`);
  const body = (await response.json()) as Record<string, { usdPrice?: number }>;
  const price = body[SOL]?.usdPrice;
  if (!price) throw new Error("Jupiter returned no SOL price; pass one in by hand");
  return price;
}
