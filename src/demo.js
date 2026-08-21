'use strict';

// Demo automatica: recrea los primeros dias de Bitcoin (enero de 2009).
// 3 nodos se descubren por P2P, Satoshi mina, envia 10 BTC a Hal Finney
// (como el 12 de enero de 2009, la primera transaccion de la historia),
// y un tercer nodo retransmite todo.

const { FullNode } = require('./node/node');
const { publicKeyToAddress } = require('./crypto/keys');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
};

function banner(text) {
  const line = '='.repeat(64);
  console.log(`\n${COLORS.cyan}${line}\n  ${text}\n${line}${COLORS.reset}\n`);
}

function tag(name, color) {
  return `${color}[${name}]${COLORS.reset}`;
}

async function main() {
  console.log(`
${COLORS.yellow}   ____  _            _  __     ___   ___
  | __ )| | ___   ___| |/ /    |_ _| |_ _|
  |  _ \\| |/ _ \\ / __| ' / _____| |   | |
  | |_) | | (_) | (__| . \\ |_____| |   | |
  |____/|_|\\___/ \\___|_|\\_\\      |___| |___|

  Recreacion del protocolo original - enero de 2009
${COLORS.reset}`);

  banner('Acto I: Tres nodos arrancan con el genesis del 3 de enero de 2009');

  const tmpBase = '/var/folders/zc/71c7zmtd0jjf5vnnq2shsp9r0000gn/T/opencode';
  const mkNode = (port, name, color) => {
    const node = new FullNode({ port, dataDir: `${tmpBase}/demo-${port}` });
    node.on('log', (m) => console.log(`${tag(name, color)} ${COLORS.dim}${m}${COLORS.reset}`));
    node.on('txAccepted', (tx) =>
      console.log(`${tag(name, color)} tx ${tx.getTxid().slice(0, 16)}... entra en mempool`));
    node.on('blockAccepted', ({ height, fromPeer }) =>
      console.log(`${tag(name, color)} bloque aceptado en altura ${height}${fromPeer ? ' (retransmitido por la red)' : ''}`));
    return node;
  };

  const satoshi = mkNode(19501, 'satoshi ', COLORS.green);
  const hal = mkNode(19502, 'hal     ', COLORS.magenta);
  const phil = mkNode(19503, 'phil    ', COLORS.yellow); // Phil Champagne, el tercero de la ronda

  await satoshi.start();
  await hal.start();
  await phil.start();

  const satAddr = satoshi.createNewAddress('Satoshi Nakamoto');
  const halAddr = hal.createNewAddress('Hal Finney');
  const philAddr = phil.createNewAddress('Phil');

  console.log(`${tag('satoshi', COLORS.green)} direccion: ${satAddr}`);
  console.log(`${tag('hal', COLORS.magenta)} direccion: ${halAddr}`);
  console.log(`${tag('phil', COLORS.yellow)} direccion: ${philAddr}`);
  console.log(`\nGenesis compartido: ${satoshi.chain.tipHash.slice(0, 24)}...`);
  console.log(`"The Times 03/Jan/2009 Chancellor on brink of second bailout for banks"`);

  banner('Acto II: La red se conecta (version -> verack -> getblocks)');

  // Topologia: satoshi <-> hal, hal <-> phil (los bloques llegan a todos)
  await satoshi.connectTo('127.0.0.1', 19502);
  await sleep(400);
  await hal.connectTo('127.0.0.1', 19503);
  await sleep(400);
  console.log(`peers: satoshi=${satoshi.network.peerCount} hal=${hal.network.peerCount} phil=${phil.network.peerCount}`);
  console.log(`altura sincronizada: satoshi=${satoshi.chain.height} hal=${hal.chain.height} phil=${phil.chain.height}`);

  banner('Acto III: Satoshi mina el bloque 1 (50 BTC)');

  await satoshi.mineBlock(satAddr);
  await sleep(800);
  console.log(`alturas: satoshi=${satoshi.chain.height} hal=${hal.chain.height} phil=${phil.chain.height}`);
  console.log(`mismo tip en los 3 nodos: ${
    satoshi.chain.tipHash === hal.chain.tipHash && hal.chain.tipHash === phil.chain.tipHash
      ? 'SI' : 'NO'}`);

  banner('Acto IV: La primera transaccion de la historia (10 BTC a Hal Finney)');

  console.log(`${tag('satoshi', COLORS.green)} "Hal, enviandote 10 BTC..."`);
  const halPub = hal.wallet[halAddr].publicKey;
  const tx = satoshi.sendToAddress(halPub, 10);
  console.log(`${tag('satoshi', COLORS.green)} txid: ${tx.getTxid()}`);
  await sleep(800);
  console.log(`\nmempool: satoshi=${satoshi.mempool.size} hal=${hal.mempool.size} phil=${phil.mempool.size} (la tx se propago a toda la red)`);

  banner('Acto V: Hal mina el bloque 2 confirmando la transaccion');

  await hal.mineBlock(halAddr);
  await sleep(1000);
  console.log(`alturas finales: satoshi=${satoshi.chain.height} hal=${hal.chain.height} phil=${phil.chain.height}`);
  console.log(`consenso en el mismo tip: ${
    satoshi.chain.tipHash === hal.chain.tipHash && hal.chain.tipHash === phil.chain.tipHash
      ? 'SI' : 'NO'}`);

  console.log(`
${tag('satoshi', COLORS.green)} balance: ${(Number(satoshi.getBalance(satAddr)) / 1e8).toFixed(8)} BTC
${tag('hal', COLORS.magenta)} balance: ${(Number(hal.getBalance(halAddr)) / 1e8).toFixed(8)} BTC  (50 minados + 10 recibidos)
${tag('phil', COLORS.yellow)} balance: ${(Number(phil.getBalance(philAddr)) / 1e8).toFixed(8)} BTC`);

  banner('Acto VI: Persistencia en blk0001.dat');

  for (const [name, node] of [['satoshi', satoshi], ['hal', hal], ['phil', phil]]) {
    const fs = require('fs');
    const stat = fs.statSync(`${tmpBase}/demo-${node.port}/blk0001.dat`);
    console.log(`${name.padEnd(8)} blk0001.dat: ${stat.size} bytes, ${node.chain.height + 1} bloques`);
  }

  banner('Fin de la demo - enero de 2009, tal como empezo todo');

  satoshi.stop();
  hal.stop();
  phil.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error('DEMO FALLO:', err);
  process.exit(1);
});
