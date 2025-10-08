import { type IMarket, type IMarketParams, MarketUtils } from "@morpho-org/blue-sdk";
import type { Address, Client, Hex } from "viem";
import { multicall, readContract } from "viem/actions";
import { morphoBlueAbi } from "../../../ponder/abis/MorphoBlue.js";

export interface CachedPosition {
  user: Address;
  marketId: Hex;
  marketParams: IMarketParams;
  collateral: bigint;
  borrowShares: bigint;
  supplyShares: bigint;
  lastUpdated: number;
  lltv: bigint;
  currentLTV?: bigint; // Calculated based on current price
}

export interface CachedMarket extends IMarket {
  cachedAt: number;
  positions: Map<Address, CachedPosition>;
}

export class PositionStateCache {
  private markets: Map<Hex, CachedMarket> = new Map();
  private client: Client;
  private morphoAddress: Address;
  private updateInterval: number = 30_000; // 30 seconds
  private updateTimer?: NodeJS.Timeout;
  
  constructor(client: Client, morphoAddress: Address) {
    this.client = client;
    this.morphoAddress = morphoAddress;
  }
  
  async initialize(marketIds: Hex[]) {
    console.log(`📦 Initializing cache for ${marketIds.length} markets...`);
    
    // Load all markets in parallel
    await Promise.all(marketIds.map(id => this.loadMarket(id)));
    
    // Start periodic updates
    this.startPeriodicUpdates();
    
    console.log("✅ Position cache initialized");
  }
  
  private async loadMarket(marketId: Hex) {
    try {
      // Fetch market data
      const [market, marketParams] = await multicall(this.client, {
        contracts: [
          {
            address: this.morphoAddress,
            abi: morphoBlueAbi,
            functionName: "market",
            args: [marketId],
          },
          {
            address: this.morphoAddress,
            abi: morphoBlueAbi,
            functionName: "idToMarketParams",
            args: [marketId],
          },
        ],
      });
      
      if (market.status !== "success" || marketParams.status !== "success") {
        console.error(`Failed to load market ${marketId}`);
        return;
      }
      
      const cachedMarket: CachedMarket = {
        params: marketParams.result as IMarketParams,
        totalSupplyAssets: market.result.totalSupplyAssets,
        totalSupplyShares: market.result.totalSupplyShares,
        totalBorrowAssets: market.result.totalBorrowAssets,
        totalBorrowShares: market.result.totalBorrowShares,
        lastUpdate: market.result.lastUpdate,
        fee: market.result.fee,
        cachedAt: Date.now(),
        positions: new Map(),
      };
      
      this.markets.set(marketId, cachedMarket);
      
      // Load positions for this market (would need event logs or indexer)
      // For now, this is a placeholder
      await this.loadPositionsForMarket(marketId, cachedMarket);
      
    } catch (error) {
      console.error(`Error loading market ${marketId}:`, error);
    }
  }
  
  private async loadPositionsForMarket(marketId: Hex, market: CachedMarket) {
    // In production, you'd get this from:
    // 1. Historical event logs
    // 2. Or maintain a separate database
    // 3. Or use a limited set of known addresses
    
    // For now, we'll just prepare the structure
    // Real implementation would fetch actual positions
  }
  
  async getPosition(marketId: Hex, user: Address): Promise<CachedPosition | undefined> {
    const market = this.markets.get(marketId);
    if (!market) return undefined;
    
    // Check if we have cached position
    let position = market.positions.get(user);
    
    // If not cached or stale, fetch fresh
    if (!position || Date.now() - position.lastUpdated > 5000) {
      position = await this.fetchPosition(marketId, user, market.params);
      if (position) {
        market.positions.set(user, position);
      }
    }
    
    return position;
  }
  
  private async fetchPosition(
    marketId: Hex,
    user: Address,
    marketParams: IMarketParams
  ): Promise<CachedPosition | undefined> {
    try {
      const position = await readContract(this.client, {
        address: this.morphoAddress,
        abi: morphoBlueAbi,
        functionName: "position",
        args: [marketId, user],
      });
      
      return {
        user,
        marketId,
        marketParams,
        collateral: position.collateral,
        borrowShares: position.borrowShares,
        supplyShares: position.supplyShares,
        lastUpdated: Date.now(),
        lltv: BigInt(marketParams.lltv),
      };
    } catch (error) {
      console.error(`Error fetching position for ${user} in market ${marketId}:`, error);
      return undefined;
    }
  }
  
  async predictLiquidatablePositions(
    oracleAddress: Address,
    newPrice: bigint
  ): Promise<CachedPosition[]> {
    const liquidatable: CachedPosition[] = [];
    
    // Check all markets that use this oracle
    for (const [marketId, market] of this.markets) {
      if (market.params.oracle !== oracleAddress) continue;
      
      // Check all positions in this market
      for (const [user, position] of market.positions) {
        const ltv = this.calculateLTV(position, newPrice, market);
        
        if (ltv > position.lltv) {
          position.currentLTV = ltv;
          liquidatable.push(position);
        }
      }
    }
    
    return liquidatable;
  }
  
  private calculateLTV(
    position: CachedPosition,
    collateralPrice: bigint,
    market: CachedMarket
  ): bigint {
    // Simplified LTV calculation
    // Real implementation needs proper price scaling and market mechanics
    if (position.collateral === 0n) return 0n;
    
    const borrowAssets = (position.borrowShares * market.totalBorrowAssets) / 
                         (market.totalBorrowShares || 1n);
    
    const collateralValue = position.collateral * collateralPrice;
    
    if (collateralValue === 0n) return 0n;
    
    return (borrowAssets * 10000n) / collateralValue; // Basis points
  }
  
  private startPeriodicUpdates() {
    this.updateTimer = setInterval(async () => {
      console.log("🔄 Updating position cache...");
      for (const marketId of this.markets.keys()) {
        await this.loadMarket(marketId);
      }
    }, this.updateInterval);
  }
  
  stop() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }
  }
}