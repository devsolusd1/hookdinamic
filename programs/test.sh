#!/bin/bash
# Builds the hook program and runs every Rust test. Run it from Linux or WSL.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Cargo is slow on a Windows drive mounted in WSL, so build somewhere native.
target="${HOOK_TARGET:-$HOME/agent-hook-target}"
out="$target/hook/deploy"

(cd hook && CARGO_TARGET_DIR="$target/hook" cargo test --lib)
(cd hook && CARGO_TARGET_DIR="$target/hook" cargo build-sbf --sbf-out-dir "$out")
(cd hook-tests && CARGO_TARGET_DIR="$target/hook-tests" HOOK_SO="$out/agent_hook.so" cargo test -- --nocapture)

echo "binary: $(stat -c %s "$out/agent_hook.so") bytes at $out/agent_hook.so"
