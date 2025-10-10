module.exports = {
  apps: [
    {
      name: 'ponder-indexer',
      script: 'node',
      args: 'scripts/ponder-fast.mjs',
      cwd: './',
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
      env: {},
      restart_delay: 3000,
      max_restarts: 10,
      log_file: './logs/worker.log',
      error_file: './logs/worker-error.log',
      out_file: './logs/worker-out.log',
      wait_ready: false
    }
  ]
};
