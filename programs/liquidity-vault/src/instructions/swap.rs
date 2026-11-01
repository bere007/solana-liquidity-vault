use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount},
};

use crate::{
    constants::*, errors::VaultError, events::Swapped, raydium_clmm, state::VaultConfig,
};

/// Обмен токенов vault через CLMM-пул Raydium (только authority vault).
///
/// Направление задаётся парой `input_*` / `output_*`: можно менять underlying -> парный
/// токен и обратно. Оба токен-аккаунта принадлежат PDA vault, CPI подписывается его seeds.
/// В `remaining_accounts` передаются bitmap extension пула и tick arrays по направлению swap.
#[derive(Accounts)]
pub struct SwapViaClmm<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        has_one = authority,
        seeds = [VAULT_SEED, vault.underlying_mint.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, VaultConfig>,

    pub clmm_program: Program<'info, raydium_clmm::program::AmmV3>,

    /// CHECK: проверяется программой Raydium (должен совпадать с pool_state.amm_config).
    pub amm_config: UncheckedAccount<'info>,

    /// CHECK: только пул, заданный в настройках vault; содержимое проверяет Raydium.
    #[account(
        mut,
        owner = raydium_clmm::ID,
        constraint = pool_state.key() == vault.liquidity_pool @ VaultError::WrongPool,
    )]
    pub pool_state: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = input_vault_mint,
        token::authority = vault,
        token::token_program = token_program,
    )]
    pub input_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = output_vault_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub output_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: хранилище пула для входного токена, проверяет Raydium.
    #[account(mut)]
    pub input_vault: UncheckedAccount<'info>,

    /// CHECK: хранилище пула для выходного токена, проверяет Raydium.
    #[account(mut)]
    pub output_vault: UncheckedAccount<'info>,

    /// CHECK: оракул пула, проверяет Raydium.
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    pub input_vault_mint: Box<InterfaceAccount<'info, Mint>>,
    pub output_vault_mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    /// CHECK: SPL Memo, адрес проверяет Raydium.
    pub memo_program: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, SwapViaClmm<'info>>,
    amount_in: u64,
    min_amount_out: u64,
    sqrt_price_limit_x64: u128,
) -> Result<()> {
    require!(amount_in > 0, VaultError::ZeroAmount);
    require!(min_amount_out > 0, VaultError::MinAmountOutRequired);
    require_keys_neq!(
        ctx.accounts.input_vault_mint.key(),
        ctx.accounts.output_vault_mint.key(),
        VaultError::SameMint
    );

    let in_before = ctx.accounts.input_token_account.amount;
    let out_before = ctx.accounts.output_token_account.amount;

    let underlying = ctx.accounts.vault.underlying_mint;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, underlying.as_ref(), &[ctx.accounts.vault.bump]]];

    let cpi_accounts = raydium_clmm::cpi::accounts::SwapV2 {
        payer: ctx.accounts.vault.to_account_info(),
        amm_config: ctx.accounts.amm_config.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        input_token_account: ctx.accounts.input_token_account.to_account_info(),
        output_token_account: ctx.accounts.output_token_account.to_account_info(),
        input_vault: ctx.accounts.input_vault.to_account_info(),
        output_vault: ctx.accounts.output_vault.to_account_info(),
        observation_state: ctx.accounts.observation_state.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        token_program2022: ctx.accounts.token_program_2022.to_account_info(),
        memo_program: ctx.accounts.memo_program.to_account_info(),
        input_vault_mint: ctx.accounts.input_vault_mint.to_account_info(),
        output_vault_mint: ctx.accounts.output_vault_mint.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.clmm_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    )
    .with_remaining_accounts(ctx.remaining_accounts.to_vec());

    // is_base_input = true: amount — точная сумма на входе,
    // other_amount_threshold — минимум на выходе (Raydium отклонит swap, если получится меньше).
    raydium_clmm::cpi::swap_v2(cpi_ctx, amount_in, min_amount_out, sqrt_price_limit_x64, true)?;

    ctx.accounts.input_token_account.reload()?;
    ctx.accounts.output_token_account.reload()?;
    let spent = in_before
        .checked_sub(ctx.accounts.input_token_account.amount)
        .ok_or(VaultError::MathOverflow)?;
    let received = ctx
        .accounts
        .output_token_account
        .amount
        .checked_sub(out_before)
        .ok_or(VaultError::MathOverflow)?;
    // Собственная проверка поверх Raydium: результат фиксируется по реальным балансам vault.
    require!(received >= min_amount_out, VaultError::SlippageExceeded);

    emit!(Swapped {
        vault: ctx.accounts.vault.key(),
        pool: ctx.accounts.pool_state.key(),
        input_mint: ctx.accounts.input_vault_mint.key(),
        output_mint: ctx.accounts.output_vault_mint.key(),
        amount_in: spent,
        amount_out: received,
    });
    Ok(())
}
