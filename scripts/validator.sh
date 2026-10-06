#!/bin/bash
# A local validator with the real mainnet bytecode of Meteora DBC and Token-2022 cloned in and
# the hook loaded at genesis. Run it from Linux or WSL, and restart it after rebuilding the hook.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

target="${HOOK_TARGET:-$HOME/agent-hook-target}"
so="$target/hook/deploy/agent_hook.so"
# A throwaway program address for local runs only.
key="$target/local-program-keypair.json"
port="${LOCAL_RPC_PORT:-8797}"
# Solana's public endpoint by default, so a test run never spends a paid RPC's quota.
rpc="${CLONE_RPC_URL:-https://api.mainnet-beta.solana.com}"

[ -f "$so" ] || { echo "build the hook first: bash programs/test.sh" >&2; exit 1; }
[ -f "$key" ] || solana-keygen new --no-bip39-passphrase --silent --outfile "$key"
program=$(solana-keygen pubkey "$key")

# What scripts/e2e.ts reads to find this validator.
mkdir -p .local
printf '{"rpc":"http://127.0.0.1:%s","hookProgram":"%s"}\n' "$port" "$program" > .local/validator.json

exec solana-test-validator --url "$rpc" --rpc-port "$port" --faucet-port $((port + 3)) --gossip-port $((port + 4)) \
  --dynamic-port-range $((port + 10))-$((port + 60)) --ledger "$target/test-ledger" --reset --quiet \
  `# mainnet's own Token-2022 and token-account programs, not the validator's built-in copies` \
  --clone-upgradeable-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --clone ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL \
  `# Meteora DBC` \
  --clone-upgradeable-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN \
  --bpf-program "$program" "$so"
