import type { IMarket, IMarketParams } from "@morpho-org/blue-sdk";
import { 
  type Client, 
  type Transport, 
  type Chain, 
  type Account,
  type Hash,
  type Transaction,
  type Address,
  type Hex,
  parseTransaction,
  decodeFunctionData,
} from "viem";
import { watchPendingTransactions } from "viem/actions";

export interface MempoolMonitorConfig {
  client: Client<Transport, Chain, Account>;
  morphoAddress: Address;
  oracleAddresses: Set<Address>;
  onLiquidationOpportunity: (opportunity: LiquidationOpportunity) => Promise<void>;
}

export interface LiquidationOpportunity {
  marketId: Hex;
  borrower: Address;
  triggerTxHash: Hash;
  triggerGasPrice: bigint;
  estimatedSeizableCollateral: bigint;
  type: "standard" | "pre-liquidation";
}

export class MempoolMonitor {
  private client: Client<Transport, Chain, Account>;
  private morphoAddress: Address;
  private oracleAddresses: Set<Address>;
  private onLiquidationOpportunity: (opportunity: LiquidationOpportunity) => Promise<void>;
  private unsubscribe?: () => void;
  
  // Cache for fast lookups
  private positionCache: Map<string, CachedPosition> = new Map();
  private marketCache: Map<Hex, IMarket> = new Map();
  
  constructor(config: MempoolMonitorConfig) {
    this.client = config.client;
    this.morphoAddress = config.morphoAddress;
    this.oracleAddresses = config.oracleAddresses;
    this.onLiquidationOpportunity = config.onLiquidationOpportunity;
  }
  
  async start() {
    console.log("🔍 Starting mempool monitoring...");
    
    // Start watching pending transactions
    this.unsubscribe = watchPendingTransactions(this.client, {
      onTransactions: async (hashes) => {
        await Promise.all(hashes.map(hash => this.handlePendingTransaction(hash)));
      },
      poll: true,
      pollingInterval: 50, // 50ms for ultra-low latency
    });
  }
  
  stop() {
    if (this.unsubscribe) {
      this.unsubscribe();
      console.log("🛑 Stopped mempool monitoring");
    }
  }
  
  private async handlePendingTransaction(hash: Hash) {
    try {
      const tx = await this.client.request({
        method: "eth_getTransactionByHash",
        params: [hash],
      });
      
      if (!tx) return;
      
      // Check if this transaction could trigger liquidations
      if (await this.couldTriggerLiquidation(tx)) {
        await this.predictLiquidations(tx);
      }
    } catch (error) {
      // Transaction might have been dropped or replaced
      // This is normal in mempool monitoring
    }
  }
  
  private async couldTriggerLiquidation(tx: Transaction): Promise<boolean> {
    // 1. Check if it's an oracle price update
    if (tx.to && this.oracleAddresses.has(tx.to)) {
      return true;
    }
    
    // 2. Check if it's a Morpho interaction that could affect positions
    if (tx.to === this.morphoAddress) {
      const functionSelector = tx.input?.slice(0, 10);
      const liquidationAffectingFunctions = [
        "0x5c19a95c", // borrow
        "0xb6b55f25", // withdraw
        "0x69328dec", // withdrawCollateral
        "0xf5298aca", // repay
        "0x6a627842", // supply
        "0x47e7ef24", // supplyCollateral
      ];
      
      if (functionSelector && liquidationAffectingFunctions.includes(functionSelector)) {
        return true;
      }
    }
    
    return false;
  }
  
  private async predictLiquidations(tx: Transaction) {
    // This is where we predict what positions will become liquidatable
    // after this transaction is mined
    
    // For oracle updates, we need to:
    // 1. Decode the new price
    // 2. Calculate which positions will breach LLTV
    // 3. Prepare liquidation transactions
    
    if (tx.to && this.oracleAddresses.has(tx.to)) {
      await this.handleOracleUpdate(tx);
    }
  }
  
  private async handleOracleUpdate(tx: Transaction) {
    // Decode oracle update to get new price
    // This will vary based on the oracle implementation
    // For Chainlink:
    try {
      const decoded = decodeFunctionData({
        abi: [
          {
            name: "updateAnswer",
            type: "function",
            inputs: [{ name: "_answer", type: "int256" }],
            outputs: [],
          },
        ],
        data: tx.input as Hex,
      });
      
      const newPrice = BigInt(decoded.args[0]);
      
      // Check all positions that use this oracle
      await this.checkPositionsWithNewPrice(tx.to!, newPrice, tx);
    } catch {
      // Not an oracle update we can decode
    }
  }
  
  private async checkPositionsWithNewPrice(
    oracleAddress: Address,
    newPrice: bigint,
    triggerTx: Transaction
  ) {
    // This would check cached positions to see which become liquidatable
    // For now, this is a placeholder for the actual implementation
    console.log(`🎯 Oracle ${oracleAddress} updating to price ${newPrice}`);
    console.log(`📊 Checking positions affected by this price change...`);
  }
}

interface CachedPosition {
  user: Address;
  marketId: Hex;
  collateral: bigint;
  borrowShares: bigint;
  lastUpdated: number;
}