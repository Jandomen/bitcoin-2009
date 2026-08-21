'use strict';


const COIN = 100000000n;
const MAX_MONEY = 21000000n * COIN;


const HALVING_INTERVAL = 210000n;

function getBlockSubsidy(height) {
  const halvings = BigInt(height) / HALVING_INTERVAL;
  if (halvings >= 64) return 0n; 
  const subsidy = (50n * COIN) >> halvings;
  return subsidy;
}

function moneyRange(value) {
  return value >= 0n && value <= MAX_MONEY;
}

module.exports = { COIN, MAX_MONEY, HALVING_INTERVAL, getBlockSubsidy, moneyRange };
