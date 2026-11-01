// Управление позицией vault в CLMM-пуле Raydium: open / collect / close / rebalance.
import { BN, Program } from "@coral-xyz/anchor";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { LiquidityVault } from "../target/types/liquidity_vault";
import {
  alignTick,
  CLMM_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  metadataPda,
  METADATA_PROGRAM_ID,
  personalPositionPda,
  PoolAddresses,
  protocolPositionPda,
  tickArrayPda,
  tickArrayStartIndex,
  TICK_SPACING,
} from "./clmm";
import { computeBudget, swapRemainingAccounts } from "./raydium";

export type VaultCtx = {
  program: Program<LiquidityVault>;
  clmm: Program<any>;
  connection: Connection;
  authority: Keypair;
  vault: PublicKey;
  pool: PoolAddresses;
};

export const positionAuthorityPda = (programId: PublicKey, vault: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("position_authority"), vault.toBuffer()], programId)[0];
export const positionRecordPda = (programId: PublicKey, vault: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("clmm_position"), vault.toBuffer()], programId)[0];

const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);

export const vaultBalances = async (c: VaultCtx) => {
  const get = async (mint: PublicKey) => {
    try {
      return Number((await getAccount(c.connection, ata(mint, c.vault))).amount);
    } catch {
      return 0;
    }
  };
  return { amount0: await get(c.pool.mint0), amount1: await get(c.pool.mint1) };
};

/** Диапазон ±`halfWidth` тиков вокруг текущей цены пула, выровненный по tick spacing. */
export const rangeAroundPrice = (tickCurrent: number, halfWidth: number, tickSpacing = TICK_SPACING) => {
  const center = alignTick(tickCurrent, tickSpacing);
  return { tickLower: center - halfWidth, tickUpper: center + halfWidth + tickSpacing };
};

export async function openVaultPosition(
  c: VaultCtx,
  tickLower: number,
  tickUpper: number,
  amount0Max: number,
  amount1Max: number,
  baseFlag: boolean
) {
  const { program, authority, vault, pool: p } = c;
  const nftMint = Keypair.generate();
  const positionAuthority = positionAuthorityPda(program.programId, vault);
  const lowerStart = tickArrayStartIndex(tickLower);
  const upperStart = tickArrayStartIndex(tickUpper);
  await program.methods
    .openClmmPosition(tickLower, tickUpper, lowerStart, upperStart, new BN(amount0Max), new BN(amount1Max), baseFlag)
    .accountsPartial({
      authority: authority.publicKey,
      vault,
      positionRecord: positionRecordPda(program.programId, vault),
      positionAuthority,
      clmmProgram: CLMM_PROGRAM_ID,
      poolState: p.pool,
      tokenMint0: p.mint0,
      tokenMint1: p.mint1,
      vaultToken0: ata(p.mint0, vault),
      vaultToken1: ata(p.mint1, vault),
      authorityToken0: ata(p.mint0, positionAuthority),
      authorityToken1: ata(p.mint1, positionAuthority),
      positionNftMint: nftMint.publicKey,
      positionNftAccount: ata(nftMint.publicKey, positionAuthority),
      metadataAccount: metadataPda(nftMint.publicKey),
      protocolPosition: protocolPositionPda(p.pool, tickLower, tickUpper),
      tickArrayLower: tickArrayPda(p.pool, lowerStart),
      tickArrayUpper: tickArrayPda(p.pool, upperStart),
      personalPosition: personalPositionPda(nftMint.publicKey),
      tokenVault0: p.vault0,
      tokenVault1: p.vault1,
      metadataProgram: METADATA_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
    })
    .preInstructions([computeBudget()])
    .signers([authority, nftMint])
    .rpc();
  return nftMint.publicKey;
}

/** Аккаунты для collect_fees / close_clmm_position по текущей записи о позиции. */
async function manageAccounts(c: VaultCtx, signer: Keypair) {
  const { program, vault, pool: p } = c;
  const recordPda = positionRecordPda(program.programId, vault);
  const record = await program.account.vaultClmmPosition.fetch(recordPda);
  const positionAuthority = positionAuthorityPda(program.programId, vault);
  return {
    record,
    accounts: {
      authority: signer.publicKey,
      vault,
      positionRecord: recordPda,
      positionAuthority,
      clmmProgram: CLMM_PROGRAM_ID,
      poolState: record.pool,
      positionNftMint: record.nftMint,
      positionNftAccount: ata(record.nftMint, positionAuthority),
      personalPosition: personalPositionPda(record.nftMint),
      protocolPosition: protocolPositionPda(p.pool, record.tickLower, record.tickUpper),
      tokenVault0: p.vault0,
      tokenVault1: p.vault1,
      tickArrayLower: tickArrayPda(p.pool, tickArrayStartIndex(record.tickLower)),
      tickArrayUpper: tickArrayPda(p.pool, tickArrayStartIndex(record.tickUpper)),
      tokenMint0: p.mint0,
      tokenMint1: p.mint1,
      vaultToken0: ata(p.mint0, vault),
      vaultToken1: ata(p.mint1, vault),
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
      memoProgram: MEMO_PROGRAM_ID,
    },
  };
}

export async function collectFees(c: VaultCtx, signer = c.authority) {
  const { accounts } = await manageAccounts(c, signer);
  return c.program.methods.collectFees().accountsPartial(accounts).preInstructions([computeBudget()]).signers([signer]).rpc();
}

export async function closeVaultPosition(c: VaultCtx, onlyIfOutOfRange: boolean, amount0Min = 0, amount1Min = 0) {
  const { accounts } = await manageAccounts(c, c.authority);
  return c.program.methods
    .closeClmmPosition(new BN(amount0Min), new BN(amount1Min), onlyIfOutOfRange)
    .accountsPartial(accounts)
    .preInstructions([computeBudget()])
    .signers([c.authority])
    .rpc();
}

/** swap_via_clmm от имени vault. */
export async function vaultSwap(c: VaultCtx, inputMint: PublicKey, amountIn: number, minOut: number) {
  const { program, clmm, connection, authority, vault, pool: p } = c;
  const zeroForOne = inputMint.equals(p.mint0);
  const outputMint = zeroForOne ? p.mint1 : p.mint0;
  const state = await clmm.account.poolState.fetch(p.pool);
  return program.methods
    .swapViaClmm(new BN(amountIn), new BN(minOut), new BN(0))
    .accountsPartial({
      authority: authority.publicKey,
      vault,
      clmmProgram: CLMM_PROGRAM_ID,
      ammConfig: p.ammConfig,
      poolState: p.pool,
      inputTokenAccount: ata(inputMint, vault),
      outputTokenAccount: ata(outputMint, vault),
      inputVault: zeroForOne ? p.vault0 : p.vault1,
      outputVault: zeroForOne ? p.vault1 : p.vault0,
      observationState: p.observation,
      inputVaultMint: inputMint,
      outputVaultMint: outputMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
      memoProgram: MEMO_PROGRAM_ID,
    })
    .remainingAccounts(await swapRemainingAccounts(connection, p, state.tickCurrent, zeroForOne))
    .preInstructions([computeBudget()])
    .signers([authority])
    .rpc();
}

/**
 * Ребаланс: если цена вышла из диапазона — закрыть позицию (on-chain проверка
 * only_if_out_of_range), выровнять токены swap'ом примерно 50/50 и открыть новую позицию
 * вокруг текущей цены. Цена ~ отношение резервов, поэтому делим стоимость пополам по цене пула.
 */
export async function rebalanceIfOutOfRange(c: VaultCtx, halfWidth: number, slippageBps = 100) {
  const { program, clmm, vault, pool: p } = c;
  const record = await program.account.vaultClmmPosition.fetch(positionRecordPda(program.programId, vault));
  const before = await clmm.account.poolState.fetch(p.pool);
  if (before.tickCurrent >= record.tickLower && before.tickCurrent < record.tickUpper) {
    return { rebalanced: false as const };
  }

  await closeVaultPosition(c, true);

  // Выравниваем стоимость токенов: цена token0 в token1 по текущему тику пула.
  const price = 1.0001 ** before.tickCurrent;
  let { amount0, amount1 } = await vaultBalances(c);
  const value0 = amount0 * price;
  if (value0 > amount1) {
    const sell0 = Math.floor((value0 - amount1) / 2 / price);
    await vaultSwap(c, p.mint0, sell0, Math.floor(sell0 * price * (1 - slippageBps / 10_000) * 0.9975));
  } else {
    const sell1 = Math.floor((amount1 - value0) / 2);
    await vaultSwap(c, p.mint1, sell1, Math.floor((sell1 / price) * (1 - slippageBps / 10_000) * 0.9975));
  }

  const now = await clmm.account.poolState.fetch(p.pool);
  ({ amount0, amount1 } = await vaultBalances(c));
  const { tickLower, tickUpper } = rangeAroundPrice(now.tickCurrent, halfWidth);
  // base = token0 с запасом: Raydium возьмёт столько token1, сколько нужно (не больше amount1)
  const nftMint = await openVaultPosition(c, tickLower, tickUpper, Math.floor(amount0 * 0.9), amount1, true);
  return { rebalanced: true as const, tickLower, tickUpper, nftMint };
}
