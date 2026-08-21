'use strict';

const readline = require('readline');
const { FullNode } = require('./node/node');
const { PROTOCOL_VERSION } = require('./net/p2p');
const { publicKeyToAddress, privateKeyToWIF, validateAddress } = require('./crypto/keys');
const { getDifficulty } = require('./core/block');
const script = require('./core/script');

function fmtBtc(sats) {
  return (Number(sats) / 1e8).toFixed(8);
}

function startCLI(options) {
  const node = new FullNode(options);
  const startedAt = Date.now();
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
  node.on('txAccepted', (tx) => log(`💸 [tx] ${tx.getTxid().slice(0, 20)}... aceptada en mempool`));
  node.on('blockMined', ({ block, elapsed }) =>
    log(`⛏️  [minado] bloque ${block.getHashHex().slice(0, 20)}... en ${elapsed}ms`)
  );
  node.on('blockAccepted', ({ block, height, fromPeer }) =>
    log(`🧱 [bloque] altura ${height} ${fromPeer ? '(via P2P)' : ''} ${block.getHashHex().slice(0, 20)}...`)
  );

  // Monitor en tiempo real del protocolo P2P (se activa con 'watch')
  let watching = false;
  const describeMessage = (command, payload) => {
    try {
      switch (command) {
        case 'version': {
          const v = require('./net/messages').decodeVersion(payload);
          return `${v.subVer} altura=${v.startHeight}`;
        }
        case 'inv':
        case 'getdata':
          return `${require('./net/messages').decodeInventory(payload).length} objeto(s)`;
        case 'getblocks':
          return `localizador de ${require('./net/messages').decodeGetBlocks(payload).locator.length} hashes`;
        case 'tx':
        case 'block':
          return `${payload.length} bytes`;
        default:
          return '';
      }
    } catch {
      return '';
    }
  };
  node.network.on('message', (peer, command, payload) => {
    if (!watching) return;
    const dir = peer.direction === 'outbound' ? '→' : '←';
    const who = `${peer.socket.remoteAddress}:${peer.socket.remotePort}`;
    const detail = describeMessage(command, payload);
    log(`📡 ${dir} ${command.padEnd(10)} ${who}${detail ? '  ' + detail : ''}`);
  });

  const COMMANDS = {
    help() {
      return [
        'Comandos disponibles:',
        '  help                          - esta ayuda',
        '  getinfo                       - informacion del nodo',
        '  getnewaddress [etiqueta]      - genera direccion nueva',
        '  listaddresses                 - direcciones del wallet',
        '  getaddressinfo <direccion>    - todos los datos de una direccion tuya',
        '  validateaddress <direccion>   - comprueba si una direccion es valida',
        '  getpubkey <direccion>         - clave publica de una direccion propia',
        '  importpubkey <hex> [nombre]   - importa clave publica ajena',
        '  importprivkey <wif> [nombre]  - recupera una direccion desde su WIF',
        '  getbalance                    - saldo total del wallet',
        '  getbalance <direccion>        - saldo de una direccion',
        '  sendtoaddress <destino> <btc> - envia (destino = direccion conocida o pubkey hex)',
        '  getblockcount                 - altura de la cadena',
        '  printchain                    - el libro contable: todos los bloques y movimientos',
        '  getblock <altura|hash>        - detalles de un bloque',
        '  getrawtransaction <txid>      - transaccion en hexadecimal',
        '  gettransaction <txid>         - estado y confirmaciones de una tx',
        '  listtransactions [n]          - ultimas transacciones con confirmaciones',
        '  getmempoolinfo                - estado de la mempool',
        '  mine [n]                      - mina n bloques (1 por defecto)',
        '  connect <ip:puerto>           - conecta a otro nodo',
        '  peers                         - lista de conexiones',
        '  dumpwallet                    - exporta claves privadas (WIF)',
        '  clear                         - limpia la pantalla',
        '  watch                         - monitor P2P en tiempo real (on/off)',
        '  exit                          - salir',
      ].join('\n');
    },

    getinfo() {
      const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
      const hh = String(Math.floor(uptimeSec / 3600)).padStart(2, '0');
      const mm = String(Math.floor((uptimeSec % 3600) / 60)).padStart(2, '0');
      const ss = String(uptimeSec % 60).padStart(2, '0');
      const tip = node.chain.blocksByHash.get(node.chain.tipHash)?.block;
      return [
        `ℹ️  Nodo bitcoin-2009`,
        `─────────────────────────────`,
        `version        : /bitcoin-2009:0.1.0/ (protocolo ${PROTOCOL_VERSION})`,
        `puerto P2P     : ${node.port}`,
        `uptime         : ${hh}:${mm}:${ss}`,
        `datadir        : ${options.dataDir || './data'}`,
        `altura         : ${node.chain.height}`,
        `mejor bloque   : ${node.chain.tipHash.slice(0, 32)}...`,
        `tiempo del tip : ${tip ? new Date(tip.time * 1000).toISOString().replace('T', ' ').slice(0, 16) : '-'}`,
        `dificultad     : ${getDifficulty(node.bits)}`,
        `conexiones     : ${node.network.peerCount}`,
        `mempool        : ${node.mempool.size} tx`,
        `bloques minados: ${node.blocksMined}`,
        `wallet         : ${Object.keys(node.wallet).length} direccion(es)`,
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

    validateaddress(address) {
      const valid = validateAddress(address);
      if (!valid) return `${address} -> INVALIDA`;
      const entry = node.wallet[address];
      return [
        `direccion : ${address}`,
        `valida    : si`,
        `es tuya   : ${entry ? 'si' : 'no'}`,
        entry?.label ? `etiqueta  : ${entry.label}` : null,
      ].filter(Boolean).join('\n');
    },

    getaddressinfo(address) {
      const entry = node.wallet[address];
      if (!entry) throw new Error('Direccion desconocida para este nodo');
      const lines = [
        `direccion  : ${address}`,
        `etiqueta   : ${entry.label || '(sin etiqueta)'}`,
        `saldo      : ${fmtBtc(node.getBalance(address))} BTC`,
        `pubkey     : ${entry.publicKey ? entry.publicKey.toString('hex') : '(no disponible)'}`,
      ];
      if (entry.privateKey) {
        lines.push(`wif        : ${privateKeyToWIF(entry.privateKey)}  (¡mantenla privada!)`);
      } else {
        lines.push('wif        : (solo lectura, no tienes la clave privada)');
      }
      return lines.join('\n');
    },

    importpubkey(hex, name = '') {
      const pubKey = Buffer.from(hex, 'hex');
      const address = publicKeyToAddress(pubKey);
      node.wallet[address] = { privateKey: null, publicKey: pubKey, label: name || 'importada', watchOnly: true };
      return `Importada como ${address}`;
    },

    importprivkey(wif, name = '') {
      const { wifToPrivateKey } = require('./crypto/keys');
      const secp = require('./crypto/secp256k1');
      const privateKey = wifToPrivateKey(wif);
      const publicKey = secp.getPublicKey(privateKey, 'uncompressed');
      const address = publicKeyToAddress(publicKey);
      if (node.wallet[address]) return `Esa clave ya estaba registrada como ${address}`;
      node.wallet[address] = { privateKey, publicKey, label: name || 'recuperada' };
      const saldo = fmtBtc(node.getBalance(address));
      return [
        `🔑 Clave importada: ${address}${name ? ` (${name})` : ''}`,
        `   Saldo visible en esta cadena: ${saldo} BTC`,
      ].join('\n');
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
      } else if (/^[0-9a-f]{130}$/i.test(dest)) {
        // Clave publica sin comprimir: 04 + X(32 bytes) + Y(32 bytes)
        pubKey = Buffer.from(dest, 'hex');
      } else if (/^[0-9a-f]{66}$/i.test(dest)) {
        // Clave publica comprimida: 02/03 + X(32 bytes)
        pubKey = Buffer.from(dest, 'hex');
      } else {
        throw new Error(
          'No conozco esa direccion: cada nodo solo ve su propio wallet.\n' +
          '  En pay-to-pubkey (2009) necesitas la clave publica del destinatario:\n' +
          '  1. En SU nodo: getpubkey <su-direccion>\n' +
          '  2. Aqui: sendtoaddress <esa-pubkey-130-hex> <btc>\n' +
          '  o registrala antes: importpubkey <pubkey> <nombre>'
        );
      }
      const tx = node.sendToAddress(pubKey, amount);
      return `Enviado. txid: ${tx.getTxid()}`;
    },

    getblockcount() {
      return String(node.chain.height);
    },

    printchain() {
      const lines = [`Libro contable completo (${node.chain.height + 1} bloques):`, ''];
      for (let h = 0; h <= node.chain.height; h++) {
        const entry = node.chain.blocksByHash.get(node.chain.mainChain.get(h));
        const b = entry.block;
        lines.push(`🧱 Bloque #${h}  ${b.getHashHex().slice(0, 20)}...  ${new Date(b.time * 1000).toISOString().slice(0, 16).replace('T', ' ')}`);
        for (const tx of b.transactions) {
          if (tx.isCoinBase()) {
            const msg = tx.inputs[0].scriptSig.subarray(1).toString('utf8').slice(0, 50);
            const total = tx.outputs.reduce((a, o) => a + o.value, 0n);
            lines.push(`   ⛏️  coinbase → ${fmtBtc(total)} BTC  "${msg}"`);
          } else {
            for (const out of tx.outputs) {
              // Destino pay-to-pubkey: el hex de la clave publica
              const el = script.parseScript(out.scriptPubKey)[0];
              const dest = el?.data
                ? `${publicKeyToAddress(el.data)}`
                : '(desconocido)';
              lines.push(`   💸 ${tx.getTxid().slice(0, 16)}... → ${dest}  ${fmtBtc(out.value)} BTC`);
            }
          }
        }
        lines.push('');
      }
      return lines.join('\n');
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

    listtransactions(nStr = '10') {
      const n = parseInt(nStr, 10) || 10;
      const rows = [];
      for (const tx of node.mempool.values()) {
        rows.push({ tx, conf: 0, height: null });
      }
      for (const { block, height } of node.chain.blocksByHash.values()) {
        for (const tx of block.transactions) {
          if (!tx.isCoinBase()) {
            rows.push({ tx, conf: node.chain.height - height + 1, height });
          }
        }
      }
      if (rows.length === 0) return '(sin transacciones todavia)';
      const fmt = (r) => {
        const total = r.tx.outputs.reduce((a, o) => a + o.value, 0n);
        const estado = r.conf === 0 ? '⏳ pendiente' : r.conf >= 6 ? '✅ 🏰 irreversible' : '✅ confirmada';
        return `${r.tx.getTxid().slice(0, 20)}...  ${fmtBtc(total)} BTC  ${estado} (${r.conf} conf)`;
      };
      return rows.slice(-n).map(fmt).join('\n');
    },

    gettransaction(txid) {
      if (!txid) throw new Error('Uso: gettransaction <txid>');
      // En la mempool: 0 confirmaciones
      const mem = node.mempool.get(txid);
      if (mem) {
        return [
          `txid           : ${txid}`,
          `estado         : ⏳ pendiente (mempool)`,
          `confirmaciones : 0`,
          ...mem.outputs.map((o, i) => {
            const el = script.parseScript(o.scriptPubKey)[0];
            const dest = el?.data ? publicKeyToAddress(el.data) : '(?)';
            return `salida[${i}]     : ${dest}  ${fmtBtc(o.value)} BTC`;
          }),
        ].join('\n');
      }
      // En la cadena
      for (const { block, height } of node.chain.blocksByHash.values()) {
        const tx = block.transactions.find((t) => t.getTxid() === txid);
        if (tx) {
          const confirmations = node.chain.height - height + 1;
          return [
            `txid           : ${txid}`,
            `bloque         : #${height} ${block.getHashHex().slice(0, 20)}...`,
            `estado         : ✅ confirmada`,
            `confirmaciones : ${confirmations}${confirmations >= 6 ? ' (irreversible 🏰)' : ''}`,
            ...tx.outputs.map((o, i) => {
              const el = script.parseScript(o.scriptPubKey)[0];
              const dest = el?.data ? publicKeyToAddress(el.data) : '(?)';
              return `salida[${i}]     : ${dest}  ${fmtBtc(o.value)} BTC`;
            }),
          ].join('\n');
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
      if (!target) throw new Error('Uso: connect <ip:puerto> o connect <puerto> (ej: connect 19002)');
      let ip, portStr;
      if (/^\d+$/.test(target)) {
        ip = '127.0.0.1';
        portStr = target;
      } else {
        [ip, portStr] = target.split(':');
      }
      const port = parseInt(portStr, 10);
      if (!ip || !(port >= 0 && port < 65536)) {
        throw new Error(`Direccion invalida: "${target}". Ejemplos: connect 19002 | connect 127.0.0.1:19002`);
      }
      await node.connectTo(ip, port);
      return `Conectando a ${ip}:${port}...`;
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

    clear() {
      process.stdout.write('\x1b[2J\x1b[H');
    },

    watch() {
      watching = !watching;
      return watching
        ? '📡 Monitor P2P activado: veras cada mensaje de la red en vivo'
        : 'Monitor P2P desactivado';
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
