use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    burn, transfer_checked, Burn, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::*,
    errors::VaultError,
    events::Withdrawn,
    math,
    state::{UserPosition, VaultConfig},
};

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,

    #[account(
        has_one = underlying_mint,
        has_one = share_mint,
        has_one = vault_token_account,
        seeds = [VAULT_SEED, underlying_mint.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, VaultConfig>,

    #[account(
        mut,
        has_one = owner,
        has_one = vault,
        seeds = [USER_POSITION_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = user_position.bump,
    )]
    pub user_position: Account<'info, UserPosition>,

    pub underlying_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub share_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = underlying_mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = share_mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub user_share_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Вывод разрешён и на паузе: пауза блокирует только новые депозиты.
pub fn handler(ctx: Context<Withdraw>, shares: u64, min_amount_out: u64) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);

    let total_assets = ctx.accounts.vault_token_account.amount;
    let total_shares = ctx.accounts.share_mint.supply;
    let amount = math::assets_for_withdraw(shares, total_assets, total_shares)?;
    require!(amount > 0, VaultError::AmountTooSmall);
    require!(amount >= min_amount_out, VaultError::SlippageExceeded);

    // 1. Сжигаем доли пользователя
    burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.share_mint.to_account_info(),
                from: ctx.accounts.user_share_account.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        shares,
    )?;

    // 2. underlying: vault -> пользователь (подпись PDA vault)
    let underlying_key = ctx.accounts.underlying_mint.key();
    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_SEED,
        underlying_key.as_ref(),
        &[ctx.accounts.vault.bump],
    ]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault_token_account.to_account_info(),
                mint: ctx.accounts.underlying_mint.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        ctx.accounts.underlying_mint.decimals,
    )?;

    let position = &mut ctx.accounts.user_position;
    position.total_withdrawn = position
        .total_withdrawn
        .checked_add(amount)
        .ok_or(VaultError::MathOverflow)?;
    position.last_action_ts = Clock::get()?.unix_timestamp;

    emit!(Withdrawn {
        vault: ctx.accounts.vault.key(),
        user: ctx.accounts.owner.key(),
        amount,
        shares,
    });
    Ok(())
}
