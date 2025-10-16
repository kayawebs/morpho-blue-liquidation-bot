# Repository Guidelines

## Project Structure & Module Organization
- `apps/client`: Bot runtime and scripts (e.g., `src/mempool-script.ts`, `src/cbbtc-usdt-bot.ts`, `src/script.ts`).
- `apps/config`: Shared TypeScript config built to `dist`; consumed by other packages.
- `apps/ponder`: Ponder indexer + lightweight API (`ponder.config.ts`, `ponder.schema.ts`, `src/api/*`).
- Tests: `apps/client/test/vitest/*`, `apps/ponder/test/*`. Assets in `img/`.
- Infra: `ecosystem.config.cjs`, `pm2.config.cjs`, `docker-compose.yml`, `.env.example`.

## Build, Test, and Development Commands
- Install deps: `pnpm install`.
- Build shared config: `pnpm build:config` (run after changing sources in `apps/config`).
- Lint: `pnpm lint` (ESLint + Prettier checks; import ordering enforced).
- Run bots/examples: `pnpm cbbtc:start`, `pnpm mempool:start`, `pnpm liquidate`, `pnpm fund:executor`, `pnpm deploy:executor` (requires `.env`).
- Tests: `pnpm test:liquidity-venues`, `pnpm test:pricers`, `pnpm test:execution`.
- Ponder dev: `pnpm --filter @morpho-blue-liquidation-bot/ponder dev` (or `npx ponder start` in `apps/ponder`).
- Optional prod: `pm2 start ecosystem.config.cjs`.

## Coding Style & Naming Conventions
- Language: TypeScript (ESM). Node ≥ 18.14 (Node 20 recommended). `pnpm` v9+.
- Indent 2 spaces; Prettier `printWidth=100`.
- ESLint with `typescript-eslint`, `import-x`, and Prettier integration. Avoid floating promises and unused vars; keep imports ordered/grouped (see `eslint.config.js`).
- Naming: camelCase (vars/functions), PascalCase (classes/types), UPPER_SNAKE_CASE (consts). Filenames kebab-case (e.g., `cbbtc-usdt-bot.ts`). Tests end with `.test.ts`.

## Testing Guidelines
- Framework: Vitest. Place tests under `apps/*/test/vitest` and mirror features when reasonable.
- Name tests `*.test.ts`. Keep deterministic; mock network/RPC where possible.
- Run targeted suites via root scripts listed above.
- For Ponder changes, update `apps/ponder/test/*` and verify codegen/schemas if relevant.

## Commit & Pull Request Guidelines
- Use Conventional Commits (e.g., `feat: …`, `fix: …`, `chore: …`).
- PRs include: clear description, rationale, linked issues (e.g., `Closes #123`), and testing notes/output. Update docs/config when applicable.
- Ensure `pnpm lint` and relevant tests pass before requesting review.

## Security & Configuration Tips
- Copy `.env.example` to `.env`; never commit secrets. Provide RPC URLs/keys per chain as required by scripts.
- After changing config sources, run `pnpm build:config` before executing scripts.
