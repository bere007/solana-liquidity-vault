use anchor_lang::prelude::*;

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
#[constant]
pub const SHARE_MINT_SEED: &[u8] = b"shares";
#[constant]
pub const USER_POSITION_SEED: &[u8] = b"position";

/// 100% в базисных пунктах.
pub const MAX_BPS: u16 = 10_000;
/// Верхняя граница комиссии — 20%.
pub const MAX_FEE_BPS: u16 = 2_000;

#[constant]
pub const CLMM_POSITION_SEED: &[u8] = b"clmm_position";
#[constant]
pub const POSITION_AUTHORITY_SEED: &[u8] = b"position_authority";
/// Баланс SOL, до которого пополняется position_authority перед открытием позиции
/// (рента за NFT, personal/protocol position и, если нужно, tick arrays Raydium).
pub const POSITION_AUTHORITY_MIN_LAMPORTS: u64 = 200_000_000;
