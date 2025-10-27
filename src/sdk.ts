// src/sdk.ts

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import idl from './idl/amm.json';

// Define the structure of a pool account based on your IDL
export type PoolState = {
    mintA: PublicKey;
    mintB: PublicKey;
    vaultA: PublicKey;
    vaultB: PublicKey;
    lpMint: PublicKey;
};

export class AmmSDK {
    public program: anchor.Program;
    public provider: anchor.AnchorProvider;
    public connection: Connection;
    public payer: Keypair;

    constructor(connection: Connection, payer: Keypair) {
        this.connection = connection;
        this.payer = payer;
        const wallet = new anchor.Wallet(payer);
        this.provider = new anchor.AnchorProvider(connection, wallet, {
            preflightCommitment: "confirmed",
        });
        anchor.setProvider(this.provider);

        this.program = new anchor.Program(idl as any, this.provider);
    }

    /**
     * Fetches the state of a given liquidity pool account.
     * @param poolAddress The public key of the pool.
     * @returns A promise that resolves to the pool's state.
     */
    async getPoolState(poolAddress: PublicKey): Promise<PoolState> {
        return (this.program.account as any).pool.fetch(poolAddress) as Promise<PoolState>;
    }

    /**
     * Swaps one token for another in a given liquidity pool.
     * @param poolAddress The public key of the pool.
     * @param inputTokenMint The mint address of the token being provided.
     * @param amountIn The amount of the input token to swap.
     * @param minimumAmountOut The minimum amount of the output token to accept.
     * @returns A promise that resolves to the transaction signature.
     */
    async swap(
        poolAddress: PublicKey,
        inputTokenMint: PublicKey,
        amountIn: anchor.BN,
        minimumAmountOut: anchor.BN
    ): Promise<string> {
        const poolState = await this.getPoolState(poolAddress);

        const isAtoB = inputTokenMint.equals(poolState.mintA);
        if (!isAtoB && !inputTokenMint.equals(poolState.mintB)) {
            throw new Error("Input token mint does not match either token in the pool.");
        }
        
        const outputTokenMint = isAtoB ? poolState.mintB : poolState.mintA;
        
        const userSourceAta = (await getOrCreateAssociatedTokenAccount(this.connection, this.payer, inputTokenMint, this.payer.publicKey)).address;
        const userDestAta = (await getOrCreateAssociatedTokenAccount(this.connection, this.payer, outputTokenMint, this.payer.publicKey)).address;
        
        return this.program.methods
            .swapToken(amountIn, minimumAmountOut)
            .accounts({
                pool: poolAddress,
                signer: this.payer.publicKey,
                vaultA: poolState.vaultA,
                vaultB: poolState.vaultB,
                userAtaA: isAtoB ? userSourceAta : userDestAta,
                userAtaB: isAtoB ? userDestAta : userSourceAta,
                poolAuth: this.findPoolAuthPDA(poolAddress),
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();
    }
    
    /**
     * Adds liquidity to a pool by providing both tokens.
     * @param poolAddress The public key of the pool.
     * @param amountA The amount of token A to deposit.
     * @param amountB The amount of token B to deposit.
     * @returns A promise that resolves to the transaction signature.
     */
    async addLiquidity(
        poolAddress: PublicKey,
        amountA: anchor.BN,
        amountB: anchor.BN
    ): Promise<string> {
        const poolState = await this.getPoolState(poolAddress);
        
        const userAtaA = (await getOrCreateAssociatedTokenAccount(this.connection, this.payer, poolState.mintA, this.payer.publicKey)).address;
        const userAtaB = (await getOrCreateAssociatedTokenAccount(this.connection, this.payer, poolState.mintB, this.payer.publicKey)).address;
        const userLpAta = (await getOrCreateAssociatedTokenAccount(this.connection, this.payer, poolState.lpMint, this.payer.publicKey)).address;

        return this.program.methods
            .addLiquidity(amountA, amountB)
            .accounts({
                pool: poolAddress,
                signer: this.payer.publicKey,
                vaultA: poolState.vaultA,
                vaultB: poolState.vaultB,
                userAtaA: userAtaA,
                userAtaB: userAtaB,
                lpMint: poolState.lpMint,
                userLpAta: userLpAta,
                poolAuth: this.findPoolAuthPDA(poolAddress),
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();
    }

    /**
     * Removes liquidity from a pool by burning LP tokens.
     * @param poolAddress The public key of the pool.
     * @param lpAmount The amount of LP tokens to burn.
     * @returns A promise that resolves to the transaction signature.
     */
    async removeLiquidity(
        poolAddress: PublicKey,
        lpAmount: anchor.BN
    ): Promise<string> {
        const poolState = await this.getPoolState(poolAddress);

        const userAtaA = (await getOrCreateAssociatedTokenAccount(this.connection, this.payer, poolState.mintA, this.payer.publicKey)).address;
        const userAtaB = (await getOrCreateAssociatedTokenAccount(this.connection, this.payer, poolState.mintB, this.payer.publicKey)).address;
        const userLpAta = (await getOrCreateAssociatedTokenAccount(this.connection, this.payer, poolState.lpMint, this.payer.publicKey)).address;

        return this.program.methods
            .removeLiquidity(lpAmount)
            .accounts({
                pool: poolAddress,
                // The `remove_liquidity` instruction in your IDL uses 'payer' for the signer
                payer: this.payer.publicKey, 
                vaultA: poolState.vaultA,
                vaultB: poolState.vaultB,
                userAtaA: userAtaA,
                userAtaB: userAtaB,
                userLpAta: userLpAta,
                lpMint: poolState.lpMint,
                poolAuth: this.findPoolAuthPDA(poolAddress),
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();
    }

    /**
     * Finds the Program Derived Address (PDA) for the pool's authority.
     * @param poolAddress The public key of the pool.
     * @returns The authority PDA's public key.
     */
    private findPoolAuthPDA(poolAddress: PublicKey): PublicKey {
        const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from("pool_auth"), poolAddress.toBuffer()],
            this.program.programId
        );
        return pda;
    }
}