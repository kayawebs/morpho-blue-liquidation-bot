module.exports = {
  apps: [
    {
      name: 'ponder-indexer',
      script: 'npx',
      args: 'ponder start',
      cwd: './apps/ponder',
      env: {
        DATABASE_SCHEMA: './ponder.schema.ts',
        // Limit indexing to the worker market only (fast mode)
        FAST_ONLY_MARKETS: '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836'
      },
      restart_delay: 5000,
      max_restarts: 10,
      log_file: './logs/ponder.log',
      error_file: './logs/ponder-error.log',
      out_file: './logs/ponder-out.log'
    },
    {
      name: 'worker-base-cbbtc-usdc',
      script: 'pnpm',
      args: 'worker:base:cbbtc_usdc',
      cwd: './',
      restart_delay: 3000,
      max_restarts: 10,
      log_file: './logs/worker.log',
      error_file: './logs/worker-error.log',
      out_file: './logs/worker-out.log',
      wait_ready: false
    }
  ]
};
