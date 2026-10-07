// Where the page reads the record from. Until `rulebook` is filled in, the page shows its
// specimen issue.
window.SITE = {
  // An RPC endpoint the browser may call. Solana's public one turns browsers away, so this is
  // a provider's, with a key that only answers pages on veluno.li and www.veluno.li. The key is
  // public by nature: it is the provider's lock on the domain that protects it. The page's
  // live connection goes to the same address over wss.
  rpc: "https://mainnet.helius-rpc.com/?api-key=de4569d6-ed27-4b75-a13d-febdeeccf9f4",

  // Addresses, as printed at launch.
  rulebook: "",
  program: "",
  pool: "",

  // The agent's published decisions, one JSON object per line.
  log: "data/log.jsonl",

  // The curve's trading fee in basis points. It is fixed with the curve and is not in the rulebook.
  feeBps: 300,

  // What the agent is called on these pages.
  agent: "Veluno",

  // The app a hook about "the app" means. Nothing shows it for a token whose rulebook names no app key.
  app: "FOMO",

  explorer: "https://solscan.io",

  // Shown under the addresses: [{ label: "Jupiter", url: "https://jup.ag/swap/SOL-<mint>" }]
  trade: [],
};

// Set before the page paints, so a live page never shows the specimen.
document.documentElement.dataset.mode = window.SITE.rulebook ? "live" : "specimen";
