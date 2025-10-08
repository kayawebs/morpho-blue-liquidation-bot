import type { Address, Client, Hash, Hex } from "viem";
import { type IMarketParams } from "@morpho-org/blue-sdk";
import { LiquidationEncoder } from "../utils/LiquidationEncoder";
import { sendTransaction, estimateGas } from "viem/actions";

export interface BackrunConfig {
  client: Client;
  executorAddress: Address;
  morphoAddress: Address;
  maxGasPrice: bigint;
  profitThresholdUsd: number;
}

export interface BackrunTarget {
  triggerTxHash: Hash;
  triggerGasPrice: bigint;
  marketParams: IMarketParams;
  borrower: Address;
  seizableCollateral: bigint;
  repaidShares: bigint;
  estimatedProfitUsd: number;
}

export class BackrunStrategy {
  private config: BackrunConfig;
  private pendingBackruns: Map<Hash, BackrunTarget> = new Map();
  
  constructor(config: BackrunConfig) {
    this.config = config;
  }
  
  async executeBackrun(target: BackrunTarget): Promise<Hash | null> {
    console.log(`🎯 Preparing backrun for tx ${target.triggerTxHash}`);
    
    try {
      // 1. Build liquidation transaction
      const encoder = new LiquidationEncoder(
        this.config.executorAddress,
        this.config.client
      );
      
      // Add your liquidation logic here
      // This is simplified - you'd include the full liquidation flow
      encoder.morphoBlueLiquidate(
        this.config.morphoAddress,
        {
          ...target.marketParams,
          lltv: BigInt(target.marketParams.lltv),
        },
        target.borrower,
        target.seizableCollateral,
        target.repaidShares,
        "0x" as Hex, // callback data
      );
      
      const calldata = encoder.build();
      
      // 2. Calculate optimal gas price
      const gasPrice = this.calculateOptimalGasPrice(target.triggerGasPrice);
      
      // 3. Estimate gas usage
      const gasLimit = await estimateGas(this.config.client, {
        to: this.config.executorAddress,
        data: calldata,
        value: 0n,
      });
      
      // 4. Check profitability
      const gasCostWei = gasLimit * gasPrice;
      const gasCostUsd = this.weiToUsd(gasCostWei);
      
      if (target.estimatedProfitUsd - gasCostUsd < this.config.profitThresholdUsd) {
        console.log(`❌ Not profitable after gas: $${target.estimatedProfitUsd - gasCostUsd}`);
        return null;
      }
      
      // 5. Send transaction with optimized gas
      const hash = await sendTransaction(this.config.client, {
        to: this.config.executorAddress,
        data: calldata,
        gas: gasLimit * 120n / 100n, // 20% buffer
        gasPrice,
        // Use type 2 transaction for better control
        maxFeePerGas: gasPrice,
        maxPriorityFeePerGas: gasPrice / 2n, // High priority
      });
      
      console.log(`✅ Backrun transaction sent: ${hash}`);
      console.log(`   Gas price: ${gasPrice / 10n**9n} gwei`);
      console.log(`   Estimated profit: $${target.estimatedProfitUsd - gasCostUsd}`);
      
      // Track pending backrun
      this.pendingBackruns.set(hash, target);
      
      return hash;
      
    } catch (error) {
      console.error(`❌ Failed to execute backrun:`, error);
      return null;
    }
  }
  
  private calculateOptimalGasPrice(triggerGasPrice: bigint): bigint {
    // Strategy: Set gas slightly lower than trigger to ensure we're included
    // in the same block but after the trigger transaction
    
    // Base strategy: 99% of trigger gas price
    let optimalGas = (triggerGasPrice * 99n) / 100n;
    
    // But ensure high enough priority fee for inclusion
    const minGasPrice = 10n * 10n**9n; // 10 gwei minimum
    optimalGas = optimalGas > minGasPrice ? optimalGas : minGasPrice;
    
    // Cap at max gas price
    if (optimalGas > this.config.maxGasPrice) {
      optimalGas = this.config.maxGasPrice;
    }
    
    return optimalGas;
  }
  
  private weiToUsd(wei: bigint): number {
    // Simplified - would use actual ETH price
    const ethPrice = 2500; // USD
    const eth = Number(wei) / 1e18;
    return eth * ethPrice;
  }
  
  async monitorBackrunSuccess(hash: Hash): Promise<boolean> {
    // Monitor if our backrun was successful
    // Check transaction receipt and verify liquidation happened
    
    const target = this.pendingBackruns.get(hash);
    if (!target) return false;
    
    try {
      const receipt = await this.config.client.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });
      
      if (receipt.status === "success") {
        console.log(`🎉 Backrun successful for ${hash}`);
        this.pendingBackruns.delete(hash);
        return true;
      } else {
        console.log(`😔 Backrun failed for ${hash}`);
        this.pendingBackruns.delete(hash);
        return false;
      }
    } catch (error) {
      console.error(`Error monitoring backrun ${hash}:`, error);
      return false;
    }
  }
  
  // Advanced: Bundle transaction using Flashbots
  async sendBundle(target: BackrunTarget): Promise<void> {
    // This would integrate with Flashbots or similar
    // to ensure transaction ordering
    console.log("🔒 Sending via Flashbots bundle...");
    
    // Implementation would use Flashbots SDK
    // Example structure:
    /*
    const bundle = {
      transactions: [
        // Don't include trigger tx (it's already in mempool)
        // Just our backrun transaction
        signedBackrunTx,
      ],
      blockNumber: await client.getBlockNumber() + 1n,
    };
    
    await flashbotsProvider.sendBundle(bundle);
    */
  }
}