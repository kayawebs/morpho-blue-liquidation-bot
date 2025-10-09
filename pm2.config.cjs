module.exports = {
  apps: [
    {
      name: 'ponder-indexer',
      script: './start-ponder.sh',
      cwd: '/home/ubuntu/morpho-blue-liquidation-bot',
      interpreter: '/bin/bash',
      restart_delay: 5000,
      max_restarts: 10,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true
    },
    {
      name: 'cbbtc-liquidation-bot', 
      script: './start-bot.sh',
      cwd: '/home/ubuntu/morpho-blue-liquidation-bot',
      interpreter: '/bin/bash',
      restart_delay: 10000, // 等待Ponder先启动
      max_restarts: 10,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true
    }
  ]
};