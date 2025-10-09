module.exports = {
  apps: [
    {
      name: 'ponder-indexer',
      script: 'npx',
      args: 'ponder start',
      cwd: './apps/ponder',
      env: {
        DATABASE_SCHEMA: './ponder.schema.ts'
      },
      restart_delay: 5000,
      max_restarts: 10,
      log_file: './logs/ponder.log',
      error_file: './logs/ponder-error.log',
      out_file: './logs/ponder-out.log'
    },
    {
      name: 'cbbtc-liquidation-bot',
      script: 'npx',
      args: 'tsx apps/client/src/cbbtc-usdt-bot.ts --env-file=.env',
      cwd: './',
      restart_delay: 3000,
      max_restarts: 10,
      log_file: './logs/bot.log',
      error_file: './logs/bot-error.log',
      out_file: './logs/bot-out.log',
      // 等待Ponder启动后再启动机器人
      wait_ready: true,
      listen_timeout: 30000
    }
  ]
};