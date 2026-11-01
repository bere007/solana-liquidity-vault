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

    /// Открыть позицию vault в CLMM-пуле Raydium в диапазоне [tick_lower, tick_upper)
    /// (только authority). Ликвидность считается из base-токена (`base_flag`: true — token0).
    #[allow(clippy::too_many_arguments)]
    pub fn open_clmm_position(
        ctx: Context<OpenClmmPosition>,
        tick_lower: i32,
        tick_upper: i32,
        tick_array_lower_start: i32,
        tick_array_upper_start: i32,
        amount0_max: u64,
        amount1_max: u64,
        base_flag: bool,
    ) -> Result<()> {
        instructions::clmm_position::open_handler(
            ctx,
            tick_lower,
            tick_upper,
            tick_array_lower_start,
            tick_array_upper_start,
            amount0_max,
            amount1_max,
            base_flag,
        )
    }

    /// Собрать накопленные комиссии позиции на vault (только authority).
    pub fn collect_fees(ctx: Context<ManageClmmPosition>) -> Result<()> {
        instructions::clmm_position::collect_fees_handler(ctx)
    }

    /// Закрыть позицию: ликвидность и комиссии возвращаются на vault (только authority).
    /// `only_if_out_of_range` — закрыть только если цена вышла из диапазона (ребаланс).
    pub fn close_clmm_position(
        ctx: Context<ManageClmmPosition>,
        amount0_min: u64,
        amount1_min: u64,
        only_if_out_of_range: bool,
    ) -> Result<()> {
        instructions::clmm_position::close_handler(ctx, amount0_min, amount1_min, only_if_out_of_range)
    }
}
