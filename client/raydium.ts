// Действия с пулом Raydium CLMM от имени обычного кошелька (подготовка пула и ликвидности).
import { BN, Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AccountMeta,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  metadataPda,
  METADATA_PROGRAM_ID,
  personalPositionPda,
  PoolAddresses,
  priceToSqrtPriceX64,
  protocolPositionPda,
  tickArrayPda,
  tickArrayStartIndex,
  TICK_ARRAY_SIZE,
  TICK_SPACING,
} from "./clmm";

export const computeBudget = (units = 1_000_000) => ComputeBudgetProgram.setComputeUnitLimit({ units });

export async function createPool(clmm: Program<any>, creator: Keypair, p: PoolAddresses, price: number, decimals0: number, decimals1: number) {
  const sqrtPrice = priceToSqrtPriceX64(price, decimals0, decimals1);
  return clmm.methods
    .createPool(new BN(sqrtPrice.toString()), new BN(0))
    .accountsPartial({
      poolCreator: creator.publicKey,
      ammConfig: p.ammConfig,
      poolState: p.pool,
      tokenMint0: p.mint0,
      tokenMint1: p.mint1,
      tokenVault0: p.vault0,
      tokenVault1: p.vault1,
      observationState: p.observation,
      tickArrayBitmap: p.bitmapExtension,
      tokenProgram0: TOKEN_PROGRAM_ID,
      tokenProgram1: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([creator])
    .rpc();
}

/** Открывает позицию LP от имени кошелька; ликвидность считается из суммы token0 (base_flag). */
export async function openWalletPosition(
  clmm: Program<any>,
  owner: Keypair,
  p: PoolAddresses,
  tickLower: number,
  tickUpper: number,
  amount0Max: number,
  amount1Max: number
) {
  const nftMint = Keypair.generate();
  const ata = (mint: PublicKey) => getAssociatedTokenAddressSync(mint, owner.publicKey);
  const lowerStart = tickArrayStartIndex(tickLower);
  const upperStart = tickArrayStartIndex(tickUpper);
  await clmm.methods
    .openPositionV2(tickLower, tickUpper, lowerStart, upperStart, new BN(0), new BN(amount0Max), new BN(amount1Max), false, true)
    .accountsPartial({
      payer: owner.publicKey,
      positionNftOwner: owner.publicKey,
      positionNftMint: nftMint.publicKey,
      positionNftAccount: ata(nftMint.publicKey),
      metadataAccount: metadataPda(nftMint.publicKey),
      poolState: p.pool,
      protocolPosition: protocolPositionPda(p.pool, tickLower, tickUpper),
      tickArrayLower: tickArrayPda(p.pool, lowerStart),
      tickArrayUpper: tickArrayPda(p.pool, upperStart),
      personalPosition: personalPositionPda(nftMint.publicKey),
      tokenAccount0: ata(p.mint0),
      tokenAccount1: ata(p.mint1),
      tokenVault0: p.vault0,
      tokenVault1: p.vault1,
      rent: SYSVAR_RENT_PUBKEY,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      metadataProgram: METADATA_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
      vault0Mint: p.mint0,
      vault1Mint: p.mint1,
    })
    .preInstructions([computeBudget()])
    .signers([owner, nftMint])
    .rpc();
  return nftMint.publicKey;
}

/**
 * Remaining accounts для swap: bitmap extension + существующие tick arrays,
 * начиная с текущего, по направлению движения цены (zeroForOne -> цена вниз).
 */
export async function swapRemainingAccounts(
  connection: Connection,
  p: PoolAddresses,
  tickCurrent: number,
  zeroForOne: boolean,
  maxArrays = 3,
  tickSpacing = TICK_SPACING
): Promise<AccountMeta[]> {
  const step = tickSpacing * TICK_ARRAY_SIZE * (zeroForOne ? -1 : 1);
  const start = tickArrayStartIndex(tickCurrent, tickSpacing);
  const candidates = Array.from({ length: 8 }, (_, i) => tickArrayPda(p.pool, start + i * step));
  const infos = await connection.getMultipleAccountsInfo(candidates);
  const existing = candidates.filter((_, i) => infos[i] !== null).slice(0, maxArrays);
  return [
    { pubkey: p.bitmapExtension, isSigner: false, isWritable: false },
    ...existing.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
  ];
}
