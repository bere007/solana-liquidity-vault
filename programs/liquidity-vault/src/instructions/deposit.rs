use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        mint_to, transfer_checked, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked,
    },
};

use crate::{
    constants::*,
    errors::VaultError,
    events::Deposited,
    math,
    state::{UserPosition, VaultConfig},
};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
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
        init_if_needed,
        payer = owner,
        associated_token::mint = share_mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program,
    )]
    pub user_share_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Deposit>, amount: u64, min_shares_out: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    require!(!vault.paused, VaultError::VaultPaused);
    require!(amount > 0, VaultError::ZeroAmount);

    // Пока средства не размещаются в пуле, все активы vault лежат на его ATA.
    let total_assets = ctx.accounts.vault_token_account.amount;
    let total_shares = ctx.accounts.share_mint.supply;

    if vault.deposit_cap > 0 {
        let after = total_assets
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        require!(after <= vault.deposit_cap, VaultError::DepositCapExceeded);
    }

    let shares = math::shares_for_deposit(amount, total_assets, total_shares)?;
    require!(shares > 0, VaultError::AmountTooSmall);
    require!(shares >= min_shares_out, VaultError::SlippageExceeded);

    // 1. underlying: пользователь -> vault
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_token_account.to_account_info(),
                mint: ctx.accounts.underlying_mint.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.underlying_mint.decimals,
    )?;

    // 2. shares: vault (PDA, mint authority) -> пользователь
    let underlying_key = ctx.accounts.underlying_mint.key();
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, underlying_key.as_ref(), &[vault.bump]]];
    mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.user_share_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        shares,
    )?;

    let position = &mut ctx.accounts.user_position;
    position.total_deposited = position
        .total_deposited
        .checked_add(amount)
        .ok_or(VaultError::MathOverflow)?;
    position.last_action_ts = Clock::get()?.unix_timestamp;

    emit!(Deposited {
        vault: ctx.accounts.vault.key(),
        user: ctx.accounts.owner.key(),
        amount,
        shares,
    });
    Ok(())
}
