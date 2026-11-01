use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Комиссия превышает допустимый максимум")]
    FeeTooHigh,
    #[msg("Vault поставлен на паузу")]
    VaultPaused,
    #[msg("Сумма должна быть больше нуля")]
    ZeroAmount,
    #[msg("Превышен лимит депозитов vault")]
    DepositCapExceeded,
    #[msg("Результат меньше минимально допустимого (slippage)")]
    SlippageExceeded,
    #[msg("Слишком маленькая сумма: получается 0 долей/токенов")]
    AmountTooSmall,
    #[msg("Арифметическое переполнение")]
    MathOverflow,
    #[msg("Пул не совпадает с пулом ликвидности, заданным в настройках vault")]
    WrongPool,
    #[msg("Нужно задать минимальную сумму получения (min_amount_out > 0)")]
    MinAmountOutRequired,
    #[msg("Входной и выходной токен совпадают")]
    SameMint,
}
