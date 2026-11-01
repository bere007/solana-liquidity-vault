//! Liquidity Vault — каркас DeFi-vault.
//!
//! Пользователь вносит базовый токен (underlying) в vault и получает share-токены,
//! отражающие его долю в общем пуле активов. На следующих этапах средства vault
//! будут размещаться в пуле ликвидности (`VaultConfig::liquidity_pool`).

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

pub use instructions::*;

// CPI-клиент Raydium CLMM, сгенерированный из idls/raydium_clmm.json.
declare_program!(raydium_clmm);

declare_id!("9a94zBboh2ukX4SF7NkzFwCwQnFSVsiPK75n4396G48u");

#[program]
pub mod liquidity_vault {
    use super::*;

    /// Создаёт vault для базового токена: аккаунт настроек, share-mint и хранилище токенов.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        deposit_cap: u64,
        fee_bps: u16,
    ) -> Result<()> {
        instructions::initialize_vault::handler(ctx, deposit_cap, fee_bps)
    }

    /// Изменение настроек vault (только authority).
    pub fn update_config(ctx: Context<UpdateConfig>, params: UpdateConfigParams) -> Result<()> {
        instructions::update_config::handler(ctx, params)
    }

    /// Создаёт PDA-позицию пользователя в конкретном vault.
    pub fn open_position(ctx: Context<OpenPosition>) -> Result<()> {
        instructions::open_position::handler(ctx)
    }

    /// Внести `amount` базовых токенов и получить share-токены.
    pub fn deposit(ctx: Context<Deposit>, amount: u64, min_shares_out: u64) -> Result<()> {
        instructions::deposit::handler(ctx, amount, min_shares_out)
    }

    /// Сжечь `shares` share-токенов и получить базовые токены обратно.
    pub fn withdraw(ctx: Context<Withdraw>, shares: u64, min_amount_out: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, shares, min_amount_out)
    }

    /// Обменять `amount_in` токенов vault через CLMM-пул Raydium,
    /// получив не меньше `min_amount_out` (только authority).
    pub fn swap_via_clmm<'info>(
        ctx: Context<'_, '_, 'info, 'info, SwapViaClmm<'info>>,
        amount_in: u64,
        min_amount_out: u64,
        sqrt_price_limit_x64: u128,
    ) -> Result<()> {
        instructions::swap::handler(ctx, amount_in, min_amount_out, sqrt_price_limit_x64)
    }
}
