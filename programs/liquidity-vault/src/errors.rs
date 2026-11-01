use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Комиссия превышает допустимый максимум")]
    FeeTooHigh,
}
