# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Morpho Blue Liquidation Bot Overview

A liquidation bot for the Morpho Blue protocol that detects and executes liquidatable positions. The bot uses RPC-only calls, supports multi-chain deployments, and integrates with various liquidity venues and pricers.

## Core Architecture

### Three-Package Monorepo Structure

1. **apps/config** - Central configuration for chains, liquidity venues, and pricers
2. **apps/ponder** - Event indexing service that tracks Morpho Blue positions and market data
3. **apps/client** - Main bot logic that queries Ponder, evaluates positions, and executes liquidations through an Executor contract

### Execution Flow
1. Ponder indexes blockchain events to track positions and market states
2. Client polls Ponder API for liquidatable positions
3. Bot evaluates profitability using configured pricers
4. Liquidations are executed via the Executor contract using configured liquidity venues

## Key Commands

```bash
# Install dependencies (using pnpm)
pnpm install

# Deploy executor contract (required before running bot)
pnpm deploy:executor

# Run the liquidation bot
pnpm liquidate

# Claim profits from executor
pnpm skim --chainId <chainId> --token <tokenAddress> --recipient <address>

# Run tests
pnpm test:liquidity-venues  # Test liquidity venue implementations
pnpm test:pricers           # Test pricer implementations  
pnpm test:execution         # Test liquidation execution

# Linting and type checking
pnpm lint                   # Run ESLint on all packages
pnpm typecheck             # Run TypeScript type checking (in client package)

# Build config package (required before running bot or tests)
pnpm build:config
```

## Configuration

### Chain Configuration (apps/config/src/config.ts)
Each chain requires:
- Morpho contract address and start block
- AdaptiveCurveIRM contract details
- MetaMorpho factory addresses
- PreLiquidation factory details (optional)
- Wrapped native token address
- Whitelisted vaults/markets
- Profit checking settings

### Environment Variables (.env)
For each chain ID:
```
RPC_URL_<chainId>=<rpc_url>
EXECUTOR_ADDRESS_<chainId>=<executor_address>
LIQUIDATION_PRIVATE_KEY_<chainId>=<private_key>
```

Optional:
```
PONDER_SERVICE_URL=<external_ponder_url>
POSTGRES_DATABASE_URL=<postgres_url>
```

## Extending the Bot

### Adding Liquidity Venues
1. Create venue class in `apps/client/src/liquidityVenues/` implementing `LiquidityVenue` interface
2. Add chain-specific config in `apps/config/src/liquidityVenues/` if needed
3. Import and add to `liquidityVenues` array in `apps/client/src/index.ts`

### Adding Pricers
1. Create pricer class in `apps/client/src/pricers/` implementing `Pricer` interface
2. Add chain-specific config in `apps/config/src/pricers/` if needed
3. Import and add to `pricers` array in `apps/client/src/index.ts`

### Adding New Chains
1. Add chain config in `apps/config/src/config.ts`
2. Set environment variables for the chain
3. Deploy executor contract: `pnpm deploy:executor`
4. If using Docker postgres, may need to reset database or use new port

## Important Classes and Interfaces

- `LiquidationBot` (apps/client/src/bot.ts) - Main bot orchestration
- `LiquidityVenue` interface - Token conversion logic for liquidations
- `Pricer` interface - USD pricing for profit calculations
- `LiquidationEncoder` - Builds executor contract calls
- Ponder API endpoints in `apps/ponder/src/api/` - Query liquidatable positions

## Testing Approach

Tests use Vitest with specific test files for:
- Individual liquidity venues (apps/client/test/vitest/liquidityVenues/)
- Individual pricers (apps/client/test/vitest/pricers/)
- Bot execution logic (apps/client/test/vitest/bot/)

Run tests after building config: `pnpm build:config && vitest <test-name>`