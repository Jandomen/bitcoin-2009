'use strict';

const readline = require('readline');
const { FullNode } = require('./node/node');
const { publicKeyToAddress, privateKeyToWIF, validateAddress } = require('./crypto/keys');
const { getDifficulty } = require('./core/block');
const script = require('./core/script');

function fmtBtc(sats) {
  return (Number(sats) / 1e8).toFixed(8);
}

function startCLI(options) {
  const node = new FullNode(options);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '',
  });

  const log = (msg) => {
    process.stdout.write(`\r\x1b[K${msg}\n`);
    rl.prompt(true);
  };

  node.on('log', log);
  node.on('txAccepted', (tx) => log(`[tx] ${tx.getTxid().slice(0, 20)}... aceptada en mempool`));
  node.on('blockMined', ({ block, elapsed }) =>
    log(`[minado] bloque ${block.getHashHex().slice(0, 20)}... en ${elapsed}ms`)
  );
  node.on('blockAccepted', ({ block, height, fromPeer }) =>
    log(`[bloque] altura ${height} ${fromPeer ? '(via P2P)' : ''} ${block.getHashHex().slice(0, 20)}...`)
  );

  const COMMANDS = {
    help() {
      return [
        'Comandos disponibles:',
        '  help                          - esta ayuda',
        '  getinfo                       - informacion del nodo',
        '  getnewaddress [etiqueta]      - genera direccion nueva',
        '  listaddresses                 - direcciones del wallet',
        '  getpubkey <direccion>         - clave publica de una direccion propia',
        '  importpubkey <hex> [nombre]   - importa clave publica ajena',
        '  getbalance                    - saldo total del wallet',
        '  getbalance <direccion>        - saldo de una direccion',
        '  sendtoaddress <destino> <btc> - envia (destino = direccion conocida o pubkey hex)',
        '  getblockcount                 - altura de la cadena',
        '  getblock <altura|hash>        - detalles de un bloque',
        '  getrawtransaction <txid>      - transaccion en hexadecimal',
        '  getmempoolinfo                - estado de la mempool',
        '  mine [n]                      - mina n bloques (1 por defecto)',
        '  connect <ip:puerto>           - conecta a otro nodo',
        '  peers                         - lista de conexiones',
        '  dumpwallet                    - exporta claves privadas (WIF)',
        '  exit                          - salir',
      ].join('\n');
    },

    getinfo() {
      return [
        `version       : /bitcoin-2009:0.1.0/`,
        `puerto        : ${node.port}`,
        `altura        : ${node.chain.height}`,
        `mejor bloque  : ${node.chain.tipHash.slice(0, 24)}...`,
        `dificultad    : ${getDifficulty(node.bits)}`,
        `conexiones    : ${node.network.peerCount}`,
        `mempool       : ${node.mempool.size} tx`,
        `bloques minados: ${node.blocksMined}`,
      ].join('\n');
    },

    getnewaddress(label = '') {
      const address = node.createNewAddress(label);
      return `${address}${label ? ` (${label})` : ''}`;
    },

    listaddresses() {
      const entries = Object.entries(node.wallet);
      if (entries.length === 0) return '(sin direcciones; usa getnewaddress)';
      return entries
        .map(([addr, e]) => `${addr}  ${fmtBtc(node.getBalance(addr))} BTC${e.label ? `  (${e.label})` : ''}`)
        .join('\n');
    },

    getpubkey(address) {
      const entry = node.wallet[address];
      if (!entry) throw new Error('Direccion no encontrada en este wallet');
      return entry.publicKey.toString('hex');
    },

    importpubkey(hex, name = '') {
      const pubKey = Buffer.from(hex, 'hex');
      const address = publicKeyToAddress(pubKey);
      node.wallet[address] = { privateKey: null, publicKey: pubKey, label: name || 'importada', watchOnly: true };
      return `Importada como ${address}`;
    },

    getbalance(address) {
      if (address) {
        return `${fmtBtc(node.getBalance(address))} BTC`;
      }
      return `${fmtBtc(node.getTotalBalance())} BTC`;
    },

    sendtoaddress(dest, amountStr) {
      if (!dest || !amountStr) throw new Error('Uso: sendtoaddress <destino> <btc>');
      const amount = parseFloat(amountStr);
      if (!(amount > 0)) throw new Error('Cantidad invalida');
      let pubKey;
      const entry = node.wallet[dest];
      if (entry?.publicKey) {
        pubKey = entry.publicKey;
      } else if (/^[0-9a-f]{66}$/i.test(dest)) {
        pubKey = Buffer.from(dest, 'hex');
      } else {
        throw new Error('Destino desconocido. Usa una direccion propia o una clave publica hex (pay-to-pubkey estilo 2009)');
      }
      const tx = node.sendToAddress(pubKey, amount);
      return `Enviado. txid: ${tx.getTxid()}`;
    },

    getblockcount() {
      return String(node.chain.height);
    },

    getblock(arg) {
      let entry;
      if (/^\d+$/.test(arg)) {
        const hash = node.chain.mainChain.get(Number(arg));
        if (!hash) throw new Error('Altura fuera de rango');
        entry = node.chain.blocksByHash.get(hash);
      } else {
        entry = node.chain.blocksByHash.get(arg);
      }
      if (!entry) throw new Error('Bloque no encontrado');
      const b = entry.block;
      return [
        `hash     : ${b.getHashHex()}`,
        `altura   : ${entry.height}`,
        `version  : ${b.version}`,
        `anterior : ${Buffer.from(b.prevBlockHash).reverse().toString('hex').slice(0, 32)}...`,
        `merkle   : ${Buffer.from(b.merkleRoot).reverse().toString('hex')}`,
        `tiempo   : ${new Date(b.time * 1000).toISOString()}`,
        `nBits    : 0x${b.bits.toString(16)}`,
        `nonce    : ${b.nonce}`,
        `txs      : ${b.transactions.length}`,
        ...b.transactions.map((tx, i) =>
          i === 0
            ? `  [coinbase] ${tx.inputs[0].scriptSig.subarray(1).toString('utf8').slice(0, 60)}`
            : `  [tx] ${tx.getTxid()}`
        ),
      ].join('\n');
    },

    getrawtransaction(txid) {
      const key = txid;
      const mem = node.mempool.get(key);
      if (mem) return mem.toHex();
      for (const { block } of node.chain.blocksByHash.values()) {
        for (const tx of block.transactions) {
          if (tx.getTxid() === txid) return tx.toHex();
        }
      }
      throw new Error('Transaccion no encontrada');
    },

    getmempoolinfo() {
      return `${node.mempool.size} transacciones esperando confirmacion`;
    },

    async mine(nStr) {
      const n = Math.min(parseInt(nStr || '1', 10), 100);
      for (let i = 0; i < n; i++) {
        await node.mineBlock();
      }
      return `Minados ${n} bloques. Altura actual: ${node.chain.height}`;
    },

    async connect(target) {
      const [ip, portStr] = target.split(':');
      await node.connectTo(ip, parseInt(portStr, 10));
      return `Conectando a ${target}...`;
    },

    peers() {
      const peers = [...node.network.peers].filter((p) => p.handshaked);
      if (peers.length === 0) return '(sin conexiones)';
      return peers
        .map((p) => `${p.socket.remoteAddress}:${p.socket.remotePort} (${p.direction})`)
        .join('\n');
    },

    dumpwallet() {
      return Object.entries(node.wallet)
        .filter(([, e]) => e.privateKey)
        .map(([addr, e]) => `${addr} -> ${privateKeyToWIF(e.privateKey)}`)
        .join('\n') || '(wallet vacia)';
    },

    exit() {
      rl.close();
    },
  };

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return rl.prompt();
    const [cmd, ...args] = trimmed.split(/\s+/);
    const fn = COMMANDS[cmd];
    try {
      if (!fn) {
        console.log(`Comando desconocido: ${cmd}. Escribe 'help'.`);
      } else {
        const result = await fn(...args);
        if (result !== undefined) console.log(result);
      }
    } catch (err) {
      console.log(`error: ${err.message}`);
    }
    rl.prompt();
  });

  rl.prompt();

  const shutdown = () => {
    console.log('\nCerrando nodo...');
    node.stop();
    process.exit(0);
  };
  rl.on('close', shutdown);
  process.on('SIGINT', shutdown);

  return { node, rl };
}

module.exports = { startCLI };
