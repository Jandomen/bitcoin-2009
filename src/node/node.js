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

    // Genesis determinista
    const genesis = buildGenesis();
    if (this.chain.height === -1) {
      this.chain.initializeGenesis(genesis);
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
    let balance = this.chain.getBalance(entry.publicKey);
    // Suma tambien salidas de mempool hacia nosotros
    for (const tx of this.mempool.values()) {
      for (const out of tx.outputs) {
        if (out.scriptPubKey.equals(require('../core/script').createPayToPubKeyScript(entry.publicKey))) {
          balance += out.value;
        }
      }
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

  // ---- Transacciones ----
  sendToAddress(toPubKey, amountBtc) {
    const amount = BigInt(Math.round(amountBtc * 100000000));
    const inputs = [];
    let gathered = 0n;
    for (const address of Object.keys(this.wallet)) {
      const entry = this.wallet[address];
      for (const utxo of this.chain.getUtxosFor(entry.publicKey)) {
        inputs.push({ prevTx: this.findTxByHash(utxo.txidRaw), prevN: utxo.n });
        gathered += utxo.value;
        if (gathered >= amount) break;
      }
      if (gathered >= amount) break;
    }
    if (gathered < amount) throw new Error('Saldo insuficiente');

    const keysByAddress = {};
    for (const [addr, entry] of Object.entries(this.wallet)) {
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

    this.chain.validateTransaction(tx); // lanza si invalida
    this._checkMempoolConflicts(tx); // doble gasto en espera de confirmacion
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
          throw new Error('Doble gasto: el outpoint ya esta en la mempool');
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
        address = Object.keys(this.wallet)[0] ?? this.createNewAddress('minero');
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
