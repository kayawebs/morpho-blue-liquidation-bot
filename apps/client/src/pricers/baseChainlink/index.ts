import {
  formatUnits,
  type Account,
  type Address,
  type Chain,
  type Client,
  type Transport,
} from "viem";
import { readContract } from "viem/actions";
import { base } from "viem/chains";

import type { Pricer } from "../pricer";

// Chainlink Aggregator ABI for direct price feed reading
const CHAINLINK_AGGREGATOR_ABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Base链的价格预言机地址映射
const BASE_PRICE_FEEDS: Record<Address, Address> = {
  // cbBTC/USD (composite oracle for cbBTC/USDC market)
  "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf": "0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9", // cbBTC composite oracle
  
  // Individual price feeds
  "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F": "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F", // BTC/USD
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B", // USDC/USD
  "0x4200000000000000000000000000000000000006": "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", // ETH/USD
};

interface CachedPrice {
  price: number;
  fetchTimestamp: number;
  decimals: number;
}

export class BaseChainlinkPricer implements Pricer {
  private readonly CACHE_TIMEOUT_MS = 30_000; // 30 seconds
  private priceCache = new Map<Address, CachedPrice>();

  async price(
    client: Client<Transport, Chain, Account>,
    asset: Address,
  ): Promise<number | undefined> {
    // Only work on Base chain
    if (client.chain.id !== base.id) {
      return undefined;
    }

    // Check if we have a price feed for this asset
    const priceFeedAddress = BASE_PRICE_FEEDS[asset.toLowerCase() as Address];
    if (!priceFeedAddress) {
      return undefined;
    }

    // Check cache first
    const cachedPrice = this.priceCache.get(priceFeedAddress);
    if (cachedPrice && Date.now() - cachedPrice.fetchTimestamp < this.CACHE_TIMEOUT_MS) {
      return cachedPrice.price;
    }

    try {
      // Read price from Chainlink aggregator
      const [roundData, decimals] = await Promise.all([
        readContract(client, {
          address: priceFeedAddress,
          abi: CHAINLINK_AGGREGATOR_ABI,
          functionName: "latestRoundData",
        }),
        readContract(client, {
          address: priceFeedAddress,
          abi: CHAINLINK_AGGREGATOR_ABI,
          functionName: "decimals",
        }),
      ]);

      // Extract price from round data
      const [, rawPrice, , updatedAt] = roundData;

      // Ensure price is positive and recent (within last hour)
      if (rawPrice <= 0n) {
        console.warn(`Invalid price from oracle ${priceFeedAddress}: ${rawPrice}`);
        return undefined;
      }

      const now = Math.floor(Date.now() / 1000);
      if (now - Number(updatedAt) > 3600) { // 1 hour
        console.warn(`Stale price from oracle ${priceFeedAddress}, updated ${now - Number(updatedAt)}s ago`);
        return undefined;
      }

      // Convert to proper decimal representation
      const price = Number(formatUnits(rawPrice, decimals));

      // Cache the result
      this.priceCache.set(priceFeedAddress, { 
        price, 
        fetchTimestamp: Date.now(),
        decimals: Number(decimals)
      });

      return price;
    } catch (error) {
      console.error(`Error fetching Base Chainlink price for ${asset} from ${priceFeedAddress}:`, error);
      return undefined;
    }
  }

  // 专用方法：获取cbBTC/USDC价格比率
  async getCbBtcUsdcPrice(client: Client<Transport, Chain, Account>): Promise<number | undefined> {
    // cbBTC/USDC市场的复合预言机直接返回比率
    const cbBtcUsdcOracle = "0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9";
    
    try {
      const [roundData, decimals] = await Promise.all([
        readContract(client, {
          address: cbBtcUsdcOracle,
          abi: CHAINLINK_AGGREGATOR_ABI,
          functionName: "latestRoundData",
        }),
        readContract(client, {
          address: cbBtcUsdcOracle,
          abi: CHAINLINK_AGGREGATOR_ABI,
          functionName: "decimals",
        }),
      ]);

      const [, rawPrice, , updatedAt] = roundData;

      if (rawPrice <= 0n) {
        return undefined;
      }

      // Check freshness (within last 30 minutes for composite oracle)
      const now = Math.floor(Date.now() / 1000);
      if (now - Number(updatedAt) > 1800) { // 30 minutes
        console.warn(`Stale cbBTC/USDC price, updated ${now - Number(updatedAt)}s ago`);
        return undefined;
      }

      return Number(formatUnits(rawPrice, decimals));
    } catch (error) {
      console.error("Error fetching cbBTC/USDC price:", error);
      return undefined;
    }
  }

  // 检测价格变化（用于清算触发）
  async detectPriceChange(
    client: Client<Transport, Chain, Account>,
    asset: Address,
    thresholdPercent: number = 1.0 // 1% default threshold
  ): Promise<{ oldPrice?: number; newPrice?: number; changePercent?: number } | undefined> {
    const priceFeedAddress = BASE_PRICE_FEEDS[asset.toLowerCase() as Address];
    if (!priceFeedAddress) {
      return undefined;
    }

    const cached = this.priceCache.get(priceFeedAddress);
    const newPrice = await this.price(client, asset);

    if (!cached || !newPrice) {
      return undefined;
    }

    const changePercent = Math.abs((newPrice - cached.price) / cached.price * 100);
    
    if (changePercent >= thresholdPercent) {
      return {
        oldPrice: cached.price,
        newPrice,
        changePercent,
      };
    }

    return undefined;
  }
}