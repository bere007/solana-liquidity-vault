# AMM и концентрированная ликвидность (Raydium CLMM)

Конспект к неделе 11: как работают пулы ликвидности и ценовые диапазоны,
и как это устроено в Raydium CLMM.

## 1. Классический AMM (constant product)

Пул хранит два токена в резервах `x` и `y` и поддерживает инвариант

```
x * y = k
```

- Цена token0 в token1: `P = y / x`.
- Swap `Δx` token0 → получаем `Δy = y - k / (x + Δx)` (минус комиссия).
  Чем больше сделка относительно резервов, тем сильнее сдвигается цена (price impact).
- Ликвидность размазана по всей кривой от 0 до ∞, поэтому
  большая её часть не работает: реальные сделки идут в узком диапазоне цен.
- LP получает LP-токены (долю пула) и комиссию пропорционально доле.

## 2. Концентрированная ликвидность (CLMM, идея Uniswap v3)

LP сам выбирает диапазон цен `[P_a, P_b]`, в котором работает его ликвидность.
Внутри диапазона позиция ведёт себя как constant-product пул с «виртуальными» резервами:

```
(x + L / √P_b) * (y + L * √P_a) = L²
```

- `L` — ликвидность позиции. При той же сумме денег узкий диапазон даёт гораздо больший `L`,
  то есть больше глубины и больше комиссий, пока цена внутри.
- Количество токенов для ликвидности `L` при текущей цене `P`:
  - `P` внутри `[P_a, P_b]`: `x = L (1/√P − 1/√P_b)`, `y = L (√P − √P_a)` — нужны оба токена;
  - `P < P_a` (диапазон выше цены): только token0;
  - `P > P_b` (диапазон ниже цены): только token1.
- Когда цена выходит из диапазона, позиция целиком конвертируется в один токен,
  перестаёт участвовать в торгах и не зарабатывает комиссии. Её нужно **переставить** (rebalance).
- Impermanent loss в узком диапазоне сильнее — это плата за эффективность капитала.

## 3. Тики

Цена дискретизирована тиками:

```
P(tick) = 1.0001^tick        (каждый тик = 0.01% цены)
```

- `tick_spacing` — шаг допустимых границ диапазона; задаётся `AmmConfig`
  (у нас index 1: комиссия 0.25%, spacing 60 → шаг границ ≈ 0.6%).
- Границы позиции — тики, кратные `tick_spacing`.
- В тиках хранится `liquidity_net`: при пересечении тика активная ликвидность пула
  увеличивается или уменьшается. Поэтому swap идёт «по шагам» от тика к тику.

## 4. Цена в Q64.64

Raydium хранит не цену, а `sqrt_price_x64 = √P · 2^64` (fixed-point Q64.64).

- Работа с корнем упрощает формулы (см. выше: везде `√P`).
- Цена «сырая»: в минимальных единицах токенов, поэтому учитываем decimals:
  `P_raw = P_human · 10^(decimals1 − decimals0)`.
- Пример: цена 1.0 при одинаковых decimals → `sqrt_price_x64 = 2^64`, тик 0.

Код: [`client/clmm.ts`](../client/clmm.ts) — `priceToSqrtPriceX64`, `priceToTick`, `alignTick`.

## 5. Аккаунты Raydium CLMM

| Аккаунт | Seeds | Что хранит |
|---|---|---|
| `AmmConfig` | `["amm_config", index]` | уровень комиссии, `tick_spacing` (создаёт Raydium) |
| `PoolState` | `["pool", amm_config, mint0, mint1]` | `sqrt_price_x64`, `tick_current`, активная `liquidity`, `fee_growth_global` |
| Хранилища пула | `["pool_vault", pool, mint]` | резервы token0 / token1 |
| `ObservationState` | `["observation", pool]` | история цены (оракул) |
| `TickArrayBitmapExtension` | `["pool_tick_array_bitmap_extension", pool]` | какие tick arrays инициализированы |
| `TickArrayState` | `["tick_array", pool, start_index]` | 60 тиков подряд |
| `PersonalPositionState` | `["position", nft_mint]` | позиция LP: тики, `L`, накопленные комиссии |
| `ProtocolPositionState` | `["position", pool, tick_lower, tick_upper]` | агрегат по диапазону |

- `mint0 < mint1` побайтово — порядок токенов в пуле фиксирован.
- `TickArray` покрывает `tick_spacing · 60` тиков; стартовый индекс —
  `floor(tick / (spacing·60)) · spacing·60`.
- Позиция LP — это **NFT**: кто владеет NFT, тот управляет позицией.
  Поэтому vault сможет владеть позицией через свой PDA.

## 6. Основные инструкции

| Инструкция | Что делает |
|---|---|
| `create_pool(sqrt_price_x64, open_time)` | создаёт пул с начальной ценой |
| `open_position_v2(...)` | минтит NFT позиции, вносит ликвидность в `[tick_lower, tick_upper]`; при `liquidity = 0` и `base_flag` Raydium сам считает `L` из суммы base-токена |
| `increase_liquidity_v2` / `decrease_liquidity_v2` | добавить / забрать ликвидность; `decrease` с `liquidity = 0` просто собирает комиссии |
| `close_position` | сжигает NFT пустой позиции |
| `swap_v2(amount, other_amount_threshold, sqrt_price_limit_x64, is_base_input)` | обмен; `other_amount_threshold` — минимум на выходе (slippage); в remaining accounts — bitmap extension и tick arrays по направлению движения цены |

## 7. Что сделано на неделе 11

- Свои тестовые токены и CLMM-пул:
  - **localnet** — [`tests/raydium-clmm.ts`](../tests/raydium-clmm.ts): программа Raydium и `AmmConfig`
    выгружены из devnet в `tests/fixtures` и поднимаются в локальном валидаторе;
  - **devnet** — [`scripts/devnet-create-pool.ts`](../scripts/devnet-create-pool.ts), адреса в `deployments/devnet.json`.
- Проверено тестами: начальная цена и тик пула; позиция внутри диапазона берёт оба токена,
  выше цены — только token0; swap сдвигает цену и начисляет LP комиссию;
  `other_amount_threshold` отклоняет невыгодный обмен.

### Пул в devnet

Создан скриптом `scripts/devnet-create-pool.ts` (полный вывод — [`deployments/devnet.json`](../deployments/devnet.json)):

| | Адрес |
|---|---|
| CLMM-пул | [`4JNiGaJ48DVKJV7Qd9FvKUXXcWSrLW3UfhJKFnarUJ2y`](https://explorer.solana.com/address/4JNiGaJ48DVKJV7Qd9FvKUXXcWSrLW3UfhJKFnarUJ2y?cluster=devnet) |
| token0 | [`JqGwtL9adY1V53TEBM2rXd1PPSDhkZoxk6QtLNPqq9Q`](https://explorer.solana.com/address/JqGwtL9adY1V53TEBM2rXd1PPSDhkZoxk6QtLNPqq9Q?cluster=devnet) |
| token1 | [`3sxvCJn32WoFBHycb8m9rhsi46UMe7KRB9qWAHBYfjyj`](https://explorer.solana.com/address/3sxvCJn32WoFBHycb8m9rhsi46UMe7KRB9qWAHBYfjyj?cluster=devnet) |
| NFT позиции LP | [`J8JPiBzKUKVbLitVQQKf6xHkrsnoUdRrDDh5fRwCbvgY`](https://explorer.solana.com/address/J8JPiBzKUKVbLitVQQKf6xHkrsnoUdRrDDh5fRwCbvgY?cluster=devnet) |
| AmmConfig | `B9H7TR8PSjJT7nuW2tuPkFC63z7drtMZ4LoCtD7PrCN1` (0.25%, tick spacing 60) |

Начальная цена 1.0 (тик 0), стартовая позиция LP — 10 000 token0 + ~10 000 token1 в диапазоне тиков [-600, 600].
