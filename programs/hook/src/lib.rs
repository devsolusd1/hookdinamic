//! A Token-2022 transfer hook whose rules an agent rewrites over time.
//!
//! Solana runs this program on every transfer of the token. A hook can only allow or refuse a
//! transfer, so every rule here is of that kind: buys only through one app for a while, a cap
//! on one buy, a cap on one wallet. Selling into the curve is never refused.
//!
//! The rules live in one account per token, the rulebook. One key, the agent, may rewrite
//! them, and only inside limits fixed at launch. A second key, the guardian, can pause the
//! agent or replace it, and cannot write rules itself.
//!
//! The rulebook also carries the split of the trading fees. The hook does not act on it (a
//! hook cannot move value): it sits there so that one change by the agent sets both, and so
//! that whatever pays the fees out reads the split from the same place.

#![cfg_attr(target_os = "solana", no_std)]

pub mod processor;
pub mod state;

#[cfg(target_os = "solana")]
mod entrypoint {
    pinocchio::program_entrypoint!(crate::processor::process_instruction);
    pinocchio::no_allocator!();
    pinocchio::nostd_panic_handler!();
}
