// Хелперы для работы с Raydium CLMM: PDA, цена <-> sqrtPriceX64 <-> тик, tick arrays.
import * as anchor from "@coral-xyz/anchor";
import { Idl, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import raydiumIdl from "../idls/raydium_clmm.json";

/** Raydium CLMM в devnet (в localnet подгружается из tests/fixtures). */
export const CLMM_PROGRAM_ID = new PublicKey(raydiumIdl.address);
/** AmmConfig index 1 в devnet: комиссия 0.25%, tick spacing 60. */
export const AMM_CONFIG = new PublicKey("B9H7TR8PSjJT7nuW2tuPkFC63z7drtMZ4LoCtD7PrCN1");
export const TICK_SPACING = 60;
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/** Количество тиков в одном TickArray у Raydium. */
export const TICK_ARRAY_SIZE = 60;
export const Q64 = 1n << 64n;

export const clmmProgram = (provider: anchor.Provider) =>
  new Program(raydiumIdl as Idl, provider) as Program<any>;

const i32be = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};

const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, CLMM_PROGRAM_ID)[0];

/** В Raydium mint0 < mint1 (побайтово). */
export const sortMints = (a: PublicKey, b: PublicKey): [PublicKey, PublicKey] =>
  Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];

export const poolPda = (ammConfig: PublicKey, mint0: PublicKey, mint1: PublicKey) =>
  pda([Buffer.from("pool"), ammConfig.toBuffer(), mint0.toBuffer(), mint1.toBuffer()]);
export const poolVaultPda = (pool: PublicKey, mint: PublicKey) =>
  pda([Buffer.from("pool_vault"), pool.toBuffer(), mint.toBuffer()]);
export const observationPda = (pool: PublicKey) =>
  pda([Buffer.from("observation"), pool.toBuffer()]);
export const bitmapExtensionPda = (pool: PublicKey) =>
  pda([Buffer.from("pool_tick_array_bitmap_extension"), pool.toBuffer()]);
export const tickArrayPda = (pool: PublicKey, startIndex: number) =>
  pda([Buffer.from("tick_array"), pool.toBuffer(), i32be(startIndex)]);
export const personalPositionPda = (nftMint: PublicKey) =>
  pda([Buffer.from("position"), nftMint.toBuffer()]);
export const protocolPositionPda = (pool: PublicKey, tickLower: number, tickUpper: number) =>
  pda([Buffer.from("position"), pool.toBuffer(), i32be(tickLower), i32be(tickUpper)]);
export const metadataPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID
  )[0];

/** Целочисленный квадратный корень (метод Ньютона). */
const isqrt = (n: bigint): bigint => {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
};

/**
 * Цена в Raydium — сколько «сырых» единиц token1 стоит одна сырая единица token0.
 * `price` задаётся в человеческих единицах (token1 за 1 token0), decimals учитываются.
 */
export const priceToSqrtPriceX64 = (price: number, decimals0: number, decimals1: number): bigint => {
  const SCALE = 10n ** 18n;
  const num = BigInt(Math.round(price * 1e18)) * 10n ** BigInt(decimals1);
  const den = SCALE * 10n ** BigInt(decimals0);
  return isqrt((num << 128n) / den);
};

export const sqrtPriceX64ToPrice = (sqrtPriceX64: bigint, decimals0: number, decimals1: number) => {
  const s = Number(sqrtPriceX64) / Number(Q64);
  return s * s * 10 ** (decimals0 - decimals1);
};

/** Тик, соответствующий цене: price = 1.0001^tick. */
export const priceToTick = (price: number, decimals0: number, decimals1: number) =>
  Math.floor(Math.log(price * 10 ** (decimals1 - decimals0)) / Math.log(1.0001));

export const tickToPrice = (tick: number, decimals0: number, decimals1: number) =>
  1.0001 ** tick * 10 ** (decimals0 - decimals1);

/** Ближайший тик, кратный tick spacing (вниз). */
export const alignTick = (tick: number, tickSpacing = TICK_SPACING) =>
  Math.floor(tick / tickSpacing) * tickSpacing;

/** Начальный индекс TickArray, в который попадает тик. */
export const tickArrayStartIndex = (tick: number, tickSpacing = TICK_SPACING) => {
  const ticksInArray = tickSpacing * TICK_ARRAY_SIZE;
  return Math.floor(tick / ticksInArray) * ticksInArray;
};

/** Все адреса пула для набора минтов. */
export const poolAddresses = (mintA: PublicKey, mintB: PublicKey, ammConfig = AMM_CONFIG) => {
  const [mint0, mint1] = sortMints(mintA, mintB);
  const pool = poolPda(ammConfig, mint0, mint1);
  return {
    ammConfig,
    mint0,
    mint1,
    pool,
    vault0: poolVaultPda(pool, mint0),
    vault1: poolVaultPda(pool, mint1),
    observation: observationPda(pool),
    bitmapExtension: bitmapExtensionPda(pool),
  };
};
export type PoolAddresses = ReturnType<typeof poolAddresses>;
