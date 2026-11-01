# Liquidity Vault

Сквозной проект курса: DeFi-vault на Solana (Anchor), который принимает токены
пользователей и размещает их в пуле ликвидности.

## Прогресс по неделям

| Неделя | Тема | Статус |
|---|---|---|
| 8 | Каркас: аккаунт настроек, PDA пользователя, share-токен | ✅ |

## Аккаунты

| Компонент | Тип | Seeds |
|---|---|---|
| `VaultConfig` — аккаунт настроек | PDA | `["vault", underlying_mint]` |
| Share-токен vault | Mint-PDA, mint authority = vault | `["shares", vault]` |
| Хранилище underlying | ATA vault | ATA(`underlying_mint`, `vault`) |
| `UserPosition` — PDA пользователя | PDA | `["position", vault, owner]` |

## Инструкции

| Инструкция | Что делает |
|---|---|
| `initialize_vault(deposit_cap, fee_bps)` | Создаёт конфиг, share-mint (decimals = как у underlying) и хранилище |
| `update_config(params)` | Только `authority`: лимит, комиссия (≤ 20%), пауза, адрес пула, смена админа |
| `open_position()` | Создаёт PDA-позицию пользователя |

Share-mint создаётся как PDA, и его mint authority — тоже PDA vault, поэтому выпускать
доли может только сама программа. Адрес пула ликвидности (`liquidity_pool`) пока пустой —
он задаётся через `update_config`, когда появится интеграция с пулом.

## Структура

```
programs/liquidity-vault/src/
├── lib.rs              # точки входа
├── state.rs            # VaultConfig, UserPosition
├── constants.rs, errors.rs, events.rs
└── instructions/       # initialize_vault, update_config, open_position
tests/liquidity-vault.ts  # интеграционные тесты (mocha)
```

## Запуск

Требуется Anchor 0.31.1, Solana CLI 2.1, Node + Yarn. `Cargo.lock` зафиксирован под toolchain Solana 2.1
(в частности `blake3 = 1.5.5`), поэтому собирается без обновления Rust в platform-tools.

```bash
yarn install
anchor keys sync     # подставить ID из локального keypair
anchor test          # сборка + локальный валидатор + тесты
```

Без локальной установки — через Docker:

```bash
docker run --rm -v "$PWD":/workdir -w /workdir solanafoundation/anchor:v0.31.1 \
  bash -lc "solana-keygen new --no-bip39-passphrase -s -o ~/.config/solana/id.json && yarn install --ignore-engines && anchor keys sync && anchor test"
```
