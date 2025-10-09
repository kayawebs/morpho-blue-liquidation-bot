# Repository Guidelines

## Project Structure & Module Organization
- `apps/client`: Bot runtime and scripts (e.g., `src/mempool-script.ts`, `src/cbbtc-usdt-bot.ts`, `src/script.ts`).
- `apps/config`: Shared TypeScript config built to `dist`; consumed by other packages.
- `apps/ponder`: Ponder indexer + lightweight API (`ponder.config.ts`, `ponder.schema.ts`, `src/api/*`).
- Tests: `apps/client/test/vitest/*` and `apps/ponder/test/*`. Assets in `img/`.
- Infra: `ecosystem.config.cjs`, `pm2.config.cjs`, `docker-compose.yml`, `.env.example`.

## Build, Test, and Development Commands
- Install: `pnpm install`
- Build config: `pnpm build:config`
- Lint: `pnpm lint`
- Run (examples):
  - `pnpm cbbtc:start` (bot example; requires `.env`)
  - `pnpm mempool:start` (mempool monitor)
  - `pnpm liquidate` / `pnpm fund:executor` / `pnpm deploy:executor`
- Tests: `pnpm test:liquidity-venues`, `pnpm test:pricers`, `pnpm test:execution`
- Ponder: `pnpm --filter @morpho-blue-liquidation-bot/ponder dev` (or `npx ponder start` in `apps/ponder`)
- Prod (optional): `pm2 start ecosystem.config.cjs`

## Coding Style & Naming Conventions
- Language: TypeScript (ESM). Indent 2 spaces. Prettier `printWidth=100`.
- Lint: ESLint with `typescript-eslint`, `import-x`, and Prettier integration. Pre-commit runs `lint-staged`.
- Naming: camelCase (vars/functions), PascalCase (classes/types), UPPER_SNAKE_CASE (consts). Prefer kebab-case filenames (e.g., `cbbtc-usdt-bot.ts`); tests end with `.test.ts`.
- Imports: keep ordered/grouped (see `eslint.config.js`); avoid floating promises and unused vars.

## Testing Guidelines
- Framework: Vitest. Place tests near package tests folders (`apps/*/test/vitest`). Name as `*.test.ts`.
- Run targeted suites via root scripts (see above). Keep tests deterministic; mock network/RPC when possible.
- If adding Ponder logic, add or update tests under `apps/ponder/test` and verify codegen/schemas if relevant.

## Commit & Pull Request Guidelines
- Use Conventional Commits (e.g., `feat: …`, `fix: …`, `chore: …`).
- PRs should include: clear description, linked issues (`Closes #123`), rationale, and testing notes/output. Update docs/config where applicable.
- Ensure `pnpm lint` and relevant tests pass before requesting review.

## Security & Configuration Tips
- Copy `.env.example` to `.env`; never commit secrets. Provide RPC URLs and keys per chain as required by scripts.
- Node >= 18.14 (Node 20 recommended). Use `pnpm` v9+.
- After changing config sources, run `pnpm build:config` before executing scripts.
