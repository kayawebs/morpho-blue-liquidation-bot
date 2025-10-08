import { chainConfig } from "@morpho-blue-liquidation-bot/config";
import { base } from "viem/chains";
import { createWalletClient, createPublicClient, http, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

async function fundExecutor() {
  const config = chainConfig(base.id);
  
  const client = createWalletClient({
    chain: base,
    transport: http(config.rpcUrl),
    account: privateKeyToAccount(config.liquidationPrivateKey),
  });
  
  const publicClient = createPublicClient({
    chain: base,
    transport: http(config.rpcUrl),
  });
  
  console.log("💰 Funding Executor Contract");
  console.log(`Executor: ${config.executorAddress}`);
  console.log(`Wallet: ${client.account.address}`);
  
  // 检查钱包余额
  const walletBalance = await publicClient.getBalance({ address: client.account.address });
  console.log(`💳 Wallet balance: ${formatEther(walletBalance)} ETH`);
  
  if (walletBalance < parseEther("0.002")) {
    console.error("❌ Insufficient wallet balance! Need at least 0.002 ETH");
    console.error("💡 Please add more ETH to your wallet for gas fees and executor funding");
    process.exit(1);
  }
  
  // 检查executor当前余额
  const executorBalance = await publicClient.getBalance({ address: config.executorAddress });
  console.log(`🏦 Executor current balance: ${formatEther(executorBalance)} ETH`);
  
  // 决定充值金额 - 使用钱包余额的80%，保留一些用于gas
  const maxFund = (walletBalance * 80n) / 100n;
  const fundAmount = maxFund > parseEther("0.01") ? parseEther("0.003") : maxFund; // 最少0.003 ETH
  
  if (executorBalance >= parseEther("0.002")) { // 如果已经有0.002 ETH就够了
    console.log("✅ Executor already has sufficient balance!");
    console.log(`Current: ${formatEther(executorBalance)} ETH >= Required: 0.002 ETH`);
    return;
  }
  
  console.log(`\n📤 Sending ${formatEther(fundAmount)} ETH to executor...`);
  console.log("💡 This will leave enough ETH in wallet for gas fees");
  console.log("⏳ Please wait...");
  
  try {
    const hash = await client.sendTransaction({
      to: config.executorAddress,
      value: fundAmount,
    });
    
    console.log(`✅ Transaction sent: ${hash}`);
    console.log("⏳ Waiting for confirmation...");
    
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    
    if (receipt.status === "success") {
      const newBalance = await publicClient.getBalance({ address: config.executorAddress });
      console.log("🎉 Funding successful!");
      console.log(`💰 Executor new balance: ${formatEther(newBalance)} ETH`);
      console.log(`📊 Gas used: ${receipt.gasUsed}`);
      console.log(`💸 Gas cost: ${formatEther(receipt.gasUsed * receipt.effectiveGasPrice)} ETH`);
    } else {
      console.error("❌ Transaction failed!");
      process.exit(1);
    }
    
  } catch (error) {
    console.error("❌ Error funding executor:", error);
    process.exit(1);
  }
}

// 支持命令行参数
const amount = process.argv[2];
if (amount && amount !== "0.05") {
  console.log(`💡 Custom amount: ${amount} ETH`);
  // 这里可以扩展支持自定义金额
}

fundExecutor().catch(console.error);