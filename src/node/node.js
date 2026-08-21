'use strict';

const os = require('os');
const { EventEmitter } = require('events');

const { P2PNetwork, PROTOCOL_VERSION } = require('../net/p2p');
const {
  MSG_TX,
  MSG_BLOCK,
  encodeInventory,
  decodeInventory,
  encodeGetBlocks,
  decodeGetBlocks,
  encodeAddrList,
} = require('../net/messages');
const { ChainState, buildGenesis } = require('./chain');
const { Transaction, createCoinbase, createTransaction } = require('../core/transaction');
const { Block } = require('../core/block');
const { DEMO_BITS } = require('../core/block');
const { mineBlock } = require('../core/pow');
const { getBlockSubsidy } = require('../core/consensus');
const { generateKeyPair, publicKeyToAddress } = require('../crypto/keys');

class FullNode extends EventEmitter {
  constructor({ port, dataDir, seedPeers = [], autoMine = false, bits }) {
    super();
    this.port = port;
    this.autoMine = autoMine;
    // Target de minado de nuevos bloques (dificultad ajustable;
    // el original de 2009 usaba 0x1d00ffff = dificultad 1)
    this.bits = bits ?? DEMO_BITS;
    this.network = new P2PNetwork({ listenPort: port });
    this.chain = new ChainState(dataDir);
    this.mempool = new Map(); // txidRaw hex -> Transaction
    this.wallet = {};         // address -> privateKey Buffer
    this.knownTxs = new Set(); // anti-duplicados de retransmision
    this.mining = false;
    this.blocksMined = 0;

    // Carga la cadena desde blk0001.dat o crea el genesis determinista
    const loaded = this.chain.loadFromDisk();
    if (loaded > 0) {
      // Los logs se emiten cuando existan listeners; guarda para start()
      this._loadedFromDisk = loaded;
    }
    if (this.chain.height === -1) {
      this.chain.initializeGenesis(buildGenesis());
    }

    this._setupHandlers();
    this.seedPeers = seedPeers;
  }

  _setupHandlers() {
    this.network.on('versionRequest', (peer) => {
      peer.sendVersion({
        addrMe: { ip: '127.0.0.1', port: this.port },
        addrFrom: { ip: '127.0.0.1', port: this.port },
        startHeight: this.chain.height,
      });
      peer.send('verack');
    });

    this.network.on('message', (peer, command, payload) => {
      try {
        this._handleMessage(peer, command, payload);
      } catch (err) {
        this.emit('log', `error procesando ${command}: ${err.message}`);
      }
    });

    this.network.on('peerConnected', (peer) => {
      this.emit('log', `conexion entrante/saliente establecida`);
    });

    this.network.on('peerDisconnected', (peer) => {
      this.emit('log', `peer desconectado (${this.network.peerCount} activos)`);
    });
  }

  async start() {
    await this.network.start();
    if (this._loadedFromDisk) {
      this.emit('log', `cargados ${this._loadedFromDisk} bloques desde blk0001.dat`);
    }
    for (const warning of this.chain.loadWarnings || []) {
      this.emit('log', `⚠️  auto-reparacion: ${warning}`);
    }
    this.emit('log', `nodo escuchando en puerto ${this.port}, altura ${this.chain.height}`);
  }

  connectTo(ip, port) {
    return this.network.connect(ip, port).then((peer) => {
      peer.sendVersion({
        addrMe: { ip: '127.0.0.1', port: this.port },
        addrFrom: { ip: '127.0.0.1', port: this.port },
        startHeight: this.chain.height,
      });
      return peer;
    });
  }

  _handleMessage(peer, command, payload) {
    switch (command) {
      case 'verack':
        // Handshake completo: sincroniza bloques con getblocks
        peer.send('getblocks', encodeGetBlocks(this.chain.getLocator(), Buffer.alloc(32)));
        break;

      case 'inv': {
        const vectors = decodeInventory(payload);
        const wanted = [];
        for (const v of vectors) {
          const key = v.hash.toString('hex');
          if (v.type === MSG_TX && !this.mempool.has(key) && !this.knownTxs.has(key)) {
            wanted.push(v);
          } else if (v.type === MSG_BLOCK && !this.chain.blocksByHash.has(key)) {
            wanted.push(v);
          }
        }
        if (wanted.length > 0) peer.send('getdata', encodeInventory(wanted));
        break;
      }

      case 'getdata': {
        const vectors = decodeInventory(payload);
        for (const v of vectors) {
          const key = v.hash.toString('hex');
          if (v.type === MSG_TX) {
            const tx = this.mempool.get(key);
            if (tx) peer.send('tx', tx.serialize());
          } else if (v.type === MSG_BLOCK) {
            const entry = this.chain.blocksByHash.get(key);
            if (entry) peer.send('block', entry.block.serialize());
          }
        }
        break;
      }

      case 'getblocks': {
        const { locator, hashStop } = decodeGetBlocks(payload);
        // Busca el primer hash conocido del localizador
        let startHash = null;
        for (const h of locator) {
          if (this.chain.blocksByHash.has(h.toString('hex'))) {
            startHash = h.toString('hex');
            break;
          }
        }
        const blocks = startHash
          ? this.chain.blocksAfter(startHash)
          : [this.chain.blocksByHash.get(this.chain.mainChain.get(0)).block];
        if (blocks.length > 0) {
          peer.send('inv', encodeInventory(
            blocks.map((b) => ({ type: MSG_BLOCK, hash: b.getHash() }))
          ));
        }
        break;
      }

      case 'tx':
        this.acceptTransaction(Transaction.deserialize(payload), peer);
        break;

      case 'block':
        this.acceptBlock(Block.deserialize(payload), peer);
        break;

      case 'getaddr':
        peer.send('addr', encodeAddrList([]));
        break;

      default:
        // version/verack/addr se manejan en p2p.js o se ignoran
        break;
    }
  }

  // ---- Wallet ----
  createNewAddress(label) {
    const kp = generateKeyPair();
    const address = publicKeyToAddress(kp.publicKey);
    this.wallet[address] = { privateKey: kp.privateKey, publicKey: kp.publicKey, label };
    return address;
  }

  getBalance(address) {
    const entry = this.wallet[address];
    if (!entry) throw new Error('Direccion desconocida para este nodo');
    // Saldo sobre el conjunto efectivo: cadena + cambios pendientes - gastos pendientes
    const script = require('../core/script');
    const target = script.createPayToPubKeyScript(entry.publicKey);
    let balance = 0n;
    for (const [, utxo] of this._effectiveUtxoSet()) {
      if (utxo.scriptPubKey.equals(target)) balance += utxo.value;
    }
    return balance;
  }

  getTotalBalance() {
    let total = 0n;
    for (const address of Object.keys(this.wallet)) {
      total += this.getBalance(address);
    }
    return total;
  }

  // Conjunto UTXO efectivo: cadena + salidas no confirmadas de la mempool,
  // menos outpoints ya gastados por transacciones pendientes.
  _effectiveUtxoSet() {
    const utxos = new Map(); // "txid:n" -> { value, scriptPubKey }
    for (const [key, u] of this.chain.utxos) {
      utxos.set(key, { value: u.value, scriptPubKey: u.scriptPubKey });
    }
    for (const tx of this.mempool.values()) {
      for (const input of tx.inputs) {
        utxos.delete(input.prevTxId.toString('hex') + ':' + input.prevN);
      }
      const txid = tx.getHash().toString('hex');
      tx.outputs.forEach((out, n) => {
        const key = txid + ':' + n;
        if (!utxos.has(key)) {
          utxos.set(key, { value: out.value, scriptPubKey: out.scriptPubKey, unconfirmed: true });
        }
      });
    }
    return utxos;
  }

  // Validacion contra cadena + mempool (permite txs encadenadas)
  _validateAgainstState(tx) {
    tx.checkStructure();
    const effective = this._effectiveUtxoSet();
    let totalIn = 0n;
    for (let i = 0; i < tx.inputs.length; i++) {
      const input = tx.inputs[i];
      const key = input.prevTxId.toString('hex') + ':' + input.prevN;
      const utxo = effective.get(key);
      if (!utxo) throw new Error('Input gasta UTXO inexistente o ya gastado');
      if (!tx.verifyInput(i, utxo.scriptPubKey)) {
        throw new Error(`Firma invalida en input ${i}`);
      }
      totalIn += utxo.value;
    }
    const totalOut = tx.outputs.reduce((acc, o) => acc + o.value, 0n);
    if (totalOut > totalIn) throw new Error('Outputs superan inputs');
    return { fee: totalIn - totalOut };
  }

  // ---- Transacciones ----
  sendToAddress(toPubKey, amountBtc) {
    const amount = BigInt(Math.round(amountBtc * 100000000));
    const inputs = [];
    let gathered = 0n;
    // Solo direcciones con clave privada pueden gastar
    const spendable = Object.entries(this.wallet).filter(([, e]) => e.privateKey);
    const script = require('../core/script');
    const effective = this._effectiveUtxoSet();
    for (const [address, entry] of spendable) {
      const target = script.createPayToPubKeyScript(entry.publicKey);
      for (const [key, utxo] of effective) {
        if (!utxo.scriptPubKey.equals(target)) continue;
        const [txidHex, nStr] = key.split(':');
        inputs.push({
          prevTx: this.findTxByHash(Buffer.from(txidHex, 'hex')),
          prevN: Number(nStr),
        });
        gathered += utxo.value;
        if (gathered >= amount) break;
      }
      if (gathered >= amount) break;
    }
    if (gathered < amount) throw new Error('Saldo insuficiente');

    const keysByAddress = {};
    for (const [addr, entry] of spendable) {
      keysByAddress[addr] = entry.privateKey;
    }

    const tx = createTransaction(inputs, [{ pubKey: toPubKey, value: amount }], keysByAddress);
    this.acceptTransaction(tx, null);
    return tx;
  }

  findTxByHash(hashRaw) {
    const hex = hashRaw.toString('hex');
    for (const blockEntry of this.chain.blocksByHash.values()) {
      for (const tx of blockEntry.block.transactions) {
        if (tx.getHash().toString('hex') === hex) return tx;
      }
    }
    for (const tx of this.mempool.values()) {
      if (tx.getHash().toString('hex') === hex) return tx;
    }
    throw new Error('Transaccion no encontrada localmente');
  }

  acceptTransaction(tx, fromPeer) {
    const key = tx.getHash().toString('hex');
    if (this.mempool.has(key) || this.knownTxs.has(key)) return false;

    this._checkMempoolConflicts(tx); // doble gasto en espera de confirmacion
    this._validateAgainstState(tx); // lanza si invalida
    this.mempool.set(key, tx);
    this.knownTxs.add(key);

    this.emit('txAccepted', tx);
    this.network.broadcast('inv', encodeInventory([{ type: MSG_TX, hash: tx.getHash() }]), fromPeer);

    if (this.autoMine && !this.mining) {
      setImmediate(() => this.mineBlock());
    }
    return true;
  }

  // Rechaza transacciones que gastan un outpoint ya reservado en mempool
  _checkMempoolConflicts(tx) {
    const spent = new Set(
      tx.inputs.map((i) => i.prevTxId.toString('hex') + ':' + i.prevN)
    );
    for (const pending of this.mempool.values()) {
      for (const input of pending.inputs) {
        const key = input.prevTxId.toString('hex') + ':' + input.prevN;
        if (spent.has(key)) {
          throw new Error(
            'Doble gasto: ese outpoint ya esta en la mempool esperando confirmacion. ' +
            'Mina un bloque (mine) para confirmar las transacciones pendientes'
          );
        }
      }
    }
  }

  // ---- Mineria ----
  async mineBlock(minerAddress = null) {
    if (this.mining) return null;
    this.mining = true;
    try {
      let address = minerAddress;
      if (!address) {
        // Mina a una direccion propia con clave privada (no watch-only)
        const spendable = Object.keys(this.wallet).filter((a) => this.wallet[a].privateKey);
        address = spendable[0] ?? this.createNewAddress('minero');
      }
      const pubKey = this.wallet[address].publicKey;

      let fees = 0n;
      for (const tx of this.mempool.values()) {
        fees += this._txFeeEstimate(tx);
      }

      const block = new Block();
      block.bits = this.bits;
      block.prevBlockHash = this.chain.tipHash ? Buffer.from(this.chain.tipHash, 'hex') : Buffer.alloc(32);
      block.transactions.push(createCoinbase(getBlockSubsidy(this.chain.height + 1), fees, pubKey, `minado por nodo:${this.port}`));
      for (const tx of this.mempool.values()) {
        block.transactions.push(tx);
      }
      block.updateMerkleRoot();

      const t0 = Date.now();
      const result = await mineBlock(block);
      const elapsed = Date.now() - t0;

      this.chain.acceptBlock(block);
      // Limpia la mempool de las tx incluidas
      for (const tx of block.transactions.slice(1)) {
        this.mempool.delete(tx.getHash().toString('hex'));
      }
      this.blocksMined++;

      this.emit('blockMined', { block, elapsed, hashes: result.hashes });
      this.network.broadcast('inv', encodeInventory([{ type: MSG_BLOCK, hash: block.getHash() }]));
      return block;
    } finally {
      this.mining = false;
    }
  }

  _txFeeEstimate(tx) {
    // Recalcula fee consultando UTXOs; si falla, asume 0
    try {
      let totalIn = 0n;
      for (let i = 0; i < tx.inputs.length; i++) {
        const input = tx.inputs[i];
        // Busca en la cadena
        const prevTx = this.findTxByHash(input.prevTxId);
        totalIn += prevTx.outputs[input.prevN].value;
      }
      const totalOut = tx.outputs.reduce((a, o) => a + o.value, 0n);
      return totalIn - totalOut;
    } catch {
      return 0n;
    }
  }

  acceptBlock(block, fromPeer) {
    const result = this.chain.acceptBlock(block);
    if (result.connected) {
      // Retira de mempool las tx ya confirmadas
      for (const tx of block.transactions.slice(1)) {
        this.mempool.delete(tx.getHash().toString('hex'));
        this.knownTxs.add(tx.getHash().toString('hex'));
      }
      this.emit('blockAccepted', { block, height: result.height, fromPeer: !!fromPeer });
      this.network.broadcast('inv', encodeInventory([{ type: MSG_BLOCK, hash: block.getHash() }]), fromPeer);
      if (this.autoMine && !this.mining && this.mempool.size > 0) {
        setImmediate(() => this.mineBlock());
      }
    }
    return result;
  }

  stop() {
    this.network.stop();
  }
}

module.exports = { FullNode };
