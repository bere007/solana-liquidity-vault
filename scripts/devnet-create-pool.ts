// Неделя 11: создаёт в devnet два тестовых токена, CLMM-пул Raydium и стартовую ликвидность.
//
// Запуск:
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET=~/.config/solana/devnet.json \
//   yarn ts-node scripts/devnet-create-pool.ts
//
// Кошелёк хранится только локально (не в репозитории). Результат пишется в deployments/devnet.json.
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import {
  alignTick,
  clmmProgram,
  metadataPda,
  METADATA_PROGRAM_ID,
  personalPositionPda,
  poolAddresses,
  priceToSqrtPriceX64,
  protocolPositionPda,
  sqrtPriceX64ToPrice,
  tickArrayPda,
  tickArrayStartIndex,
} from "../client/clmm";

const DECIMALS = 6;
const ONE = 10 ** DECIMALS;
const INITIAL_PRICE = 1; // 1 token1 = 1 token0
const RANGE_TICKS = 600; // ±~6% вокруг цены
const LIQUIDITY_AMOUNT = 10_000 * ONE;

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const wallet = (provider.wallet as anchor.Wallet).payer;
  const clmm = clmmProgram(provider);

  console.log("Кошелёк:", wallet.publicKey.toBase58());
  console.log("Баланс:", (await connection.getBalance(wallet.publicKey)) / 1e9, "SOL");

  // 1. Тестовые токены
  const mintA = await createMint(connection, wallet, wallet.publicKey, null, DECIMALS);
  const mintB = await createMint(connection, wallet, wallet.publicKey, null, DECIMALS);
  const p = poolAddresses(mintA, mintB);
  for (const m of [p.mint0, p.mint1]) {
    const a = await getOrCreateAssociatedTokenAccount(connection, wallet, m, wallet.publicKey);
    await mintTo(connection, wallet, m, a.address, wallet, 1_000_000 * ONE);
  }
  console.log("token0:", p.mint0.toBase58());
  console.log("token1:", p.mint1.toBase58());

  // 2. CLMM-пул
  const sqrtPrice = priceToSqrtPriceX64(INITIAL_PRICE, DECIMALS, DECIMALS);
  const createSig = await clmm.methods
    .createPool(new BN(sqrtPrice.toString()), new BN(0))
    .accountsPartial({
      poolCreator: wallet.publicKey,
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
    .rpc();
  console.log("pool:", p.pool.toBase58(), "tx:", createSig);

  // 3. Стартовая ликвидность в диапазоне вокруг цены
  const tickLower = alignTick(-RANGE_TICKS);
  const tickUpper = alignTick(RANGE_TICKS);
  const lowerStart = tickArrayStartIndex(tickLower);
  const upperStart = tickArrayStartIndex(tickUpper);
  const nftMint = Keypair.generate();
  const ata = (mint: anchor.web3.PublicKey) => getAssociatedTokenAddressSync(mint, wallet.publicKey);

  const positionSig = await clmm.methods
    .openPositionV2(tickLower, tickUpper, lowerStart, upperStart, new BN(0),
      new BN(LIQUIDITY_AMOUNT), new BN(Math.floor(LIQUIDITY_AMOUNT * 1.1)), false, true)
    .accountsPartial({
      payer: wallet.publicKey,
      positionNftOwner: wallet.publicKey,
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
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 })])
    .signers([nftMint])
    .rpc();
  console.log("LP position NFT:", nftMint.publicKey.toBase58(), "tx:", positionSig);

  const pool = await (clmm.account as any).poolState.fetch(p.pool);
  const price = sqrtPriceX64ToPrice(BigInt(pool.sqrtPriceX64.toString()), DECIMALS, DECIMALS);
  console.log(`Цена: ${price}, тик: ${pool.tickCurrent}, ликвидность: ${pool.liquidity.toString()}`);

  const out = {
    cluster: "devnet",
    createdAt: new Date().toISOString(),
    clmmProgram: clmm.programId.toBase58(),
    ammConfig: p.ammConfig.toBase58(),
    feeRate: "0.25%",
    tickSpacing: pool.tickSpacing,
    token0: p.mint0.toBase58(),
    token1: p.mint1.toBase58(),
    decimals: DECIMALS,
    pool: p.pool.toBase58(),
    vault0: p.vault0.toBase58(),
    vault1: p.vault1.toBase58(),
    observation: p.observation.toBase58(),
    initialPrice: INITIAL_PRICE,
    lpPosition: { nftMint: nftMint.publicKey.toBase58(), tickLower, tickUpper },
    txs: { createPool: createSig, openPosition: positionSig },
  };
  const file = path.join(__dirname, "..", "deployments", "devnet.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log("Сохранено в", file);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
