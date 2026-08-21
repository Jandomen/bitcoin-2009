'use strict';

const fs = require('fs');
const path = require('path');
const { Block, DEMO_BITS, compactToTarget } = require('../core/block');
const { createCoinbase } = require('../core/transaction');
const { getBlockSubsidy } = require('../core/consensus');
const secp256k1 = require('../crypto/secp256k1');

// Clave fija del genesis: todos los nodos generan exactamente el mismo bloque
const GENESIS_PRIVKEY = Buffer.from(
  '0909090909090909090909090909090909090909090909090909090909090909', 'hex'
);
const GENESIS_TIME = 1231006505; // 3 de enero de 2009 18:15:05 UTC
const GENESIS_NONCE = 171288;
const GENESIS_MESSAGE = 'The Times 03/Jan/2009 Chancellor on brink of second bailout for banks';

function buildGenesis() {
  const pub = secp256k1.getPublicKey(GENESIS_PRIVKEY, 'uncompressed');
  const block = new Block();
  block.time = GENESIS_TIME;
  block.bits = DEMO_BITS;
  block.nonce = GENESIS_NONCE;
  block.transactions.push(
    createCoinbase(getBlockSubsidy(0), 0n, pub, GENESIS_MESSAGE)
  );
  block.updateMerkleRoot();
  if (!block.checkProofOfWork()) throw new Error('Genesis no cumple PoW');
  return block;
}

// Estado de la cadena: bloques, UTXOs y validacion completa
class ChainState {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.blocksByHash = new Map();   // hashHex -> { block, height }
    this.mainChain = new Map();      // height -> hashHex
    this.utxos = new Map();          // "txidRaw:n" -> { value, scriptPubKey, height }
    this.tipHash = null;
    this.height = -1;

    if (dataDir) {
      fs.mkdirSync(dataDir, { recursive: true });
      this.blkFile = path.join(dataDir, 'blk0001.dat');
    }
  }

  get tip() {
    return this.tipHash ? this.blocksByHash.get(this.tipHash) : null;
  }

  utxoKey(txidRaw, n) {
    return txidRaw.toString('hex') + ':' + n;
  }

  // Aplica los outputs de una tx al conjunto UTXO
  applyTxOutputs(tx, height) {
    const txid = tx.getHash();
    tx.outputs.forEach((out, i) => {
      if (out.value > 0n) {
        this.utxos.set(this.utxoKey(txid, i), {
          value: out.value,
          scriptPubKey: out.scriptPubKey,
          height,
        });
      }
    });
  }

  // Consume los inputs de una tx del conjunto UTXO. Devuelve el total.
  consumeTxInputs(tx) {
    let total = 0n;
    for (const input of tx.inputs) {
      const key = this.utxoKey(input.prevTxId, input.prevN);
      const utxo = this.utxos.get(key);
      if (!utxo) throw new Error(`UTXO inexistente ${key.slice(0, 16)}...`);
      this.utxos.delete(key);
      total += utxo.value;
    }
    return total;
  }

  // Validacion de una transaccion contra el estado actual
  validateTransaction(tx) {
    tx.checkStructure();
    if (tx.isCoinBase()) throw new Error('Coinbase no puede ir en la mempool');
    let totalIn = 0n;
    for (let i = 0; i < tx.inputs.length; i++) {
      const input = tx.inputs[i];
      const key = this.utxoKey(input.prevTxId, input.prevN);
      const utxo = this.utxos.get(key);
      if (!utxo) throw new Error(`Input gasta UTXO inexistente`);
      if (!tx.verifyInput(i, utxo.scriptPubKey)) {
        throw new Error(`Firma invalida en input ${i}`);
      }
      totalIn += utxo.value;
    }
    const totalOut = tx.outputs.reduce((acc, o) => acc + o.value, 0n);
    if (totalOut > totalIn) throw new Error('Outputs superan inputs');
    return { fee: totalIn - totalOut };
  }

  // Validacion de un bloque completo contra el estado actual.
  // No muta el estado salvo que se llame connectBlock despues.
  validateBlock(block) {
    if (!block.checkProofOfWork()) throw new Error('PoW invalido');
    if (!block.checkMerkleRoot()) throw new Error('Merkle root invalida');
    if (block.transactions.length === 0) throw new Error('Bloque vacio');

    const prevHeight = this.blocksByHash.get(block.prevBlockHash.toString('hex'))?.height;
    if (prevHeight === undefined) throw new Error('Bloque anterior desconocido');
    const height = prevHeight + 1;

    // Subsidio correcto
    const coinbase = block.transactions[0];
    if (!coinbase.isCoinBase()) throw new Error('Primera tx no es coinbase');
    let fees = 0n;
    for (let i = 1; i < block.transactions.length; i++) {
      fees += this.validateTransaction(block.transactions[i]).fee;
    }
    const expected = getBlockSubsidy(height) + fees;
    const actual = coinbase.outputs.reduce((a, o) => a + o.value, 0n);
    if (actual !== expected) {
      throw new Error(`Coinbase invalida: paga ${actual}, permitido ${expected}`);
    }
    return height;
  }

  // Conecta un bloque ya validado: muta UTXOs e indices
  connectBlock(block, height) {
    const consumed = []; // [key, utxo] para restaurar si algo falla
    const created = [];  // keys de UTXOs nuevos
    try {
      for (let i = 1; i < block.transactions.length; i++) {
        const tx = block.transactions[i];
        for (const input of tx.inputs) {
          const key = this.utxoKey(input.prevTxId, input.prevN);
          const utxo = this.utxos.get(key);
          if (!utxo) throw new Error(`UTXO inexistente ${key.slice(0, 16)}...`);
          consumed.push([key, utxo]);
          this.utxos.delete(key);
        }
        const txid = tx.getHash();
        tx.outputs.forEach((out, n) => {
          if (out.value > 0n) {
            const key = this.utxoKey(txid, n);
            this.utxos.set(key, {
              value: out.value,
              scriptPubKey: out.scriptPubKey,
              height,
            });
            created.push(key);
          }
        });
      }
      const cbTxid = block.transactions[0].getHash();
      block.transactions[0].outputs.forEach((out, n) => {
        if (out.value > 0n) {
          const key = this.utxoKey(cbTxid, n);
          this.utxos.set(key, {
            value: out.value,
            scriptPubKey: out.scriptPubKey,
            height,
          });
          created.push(key);
        }
      });
    } catch (err) {
      for (const [key, utxo] of consumed) this.utxos.set(key, utxo);
      for (const key of created) this.utxos.delete(key);
      throw err;
    }

    const hashHex = block.getHash().toString('hex');
    this.blocksByHash.set(hashHex, { block, height });
    this.mainChain.set(height, hashHex);
    this.tipHash = hashHex;
    this.height = height;

    // Persistencia estilo original: [magic][size][block] en blk0001.dat
    this._persist(block);
    return height;
  }

  _persist(block) {
    if (!this.blkFile) return;
    const raw = block.serialize();
    const record = Buffer.alloc(8);
    const { MAGIC } = require('../net/messages');
    MAGIC.copy(record, 0);
    record.writeUInt32LE(raw.length, 4);
    fs.appendFileSync(this.blkFile, Buffer.concat([record, raw]));
  }

  // Registra el genesis en los indices, UTXO y fichero de bloques
  initializeGenesis(genesis) {
    const hashHex = genesis.getHash().toString('hex');
    this.blocksByHash.set(hashHex, { block: genesis, height: 0 });
    this.mainChain.set(0, hashHex);
    this.tipHash = hashHex;
    this.height = 0;
    this.applyTxOutputs(genesis.transactions[0], 0);
    // Solo se escribe si el fichero no existe ya (evita duplicados al reiniciar)
    if (this.blkFile && !fs.existsSync(this.blkFile)) {
      this._persist(genesis);
    }
  }

  acceptBlock(block) {
    const existing = this.blocksByHash.get(block.getHash().toString('hex'));
    if (existing) return { connected: false, reason: 'ya conocido' };
    const height = this.validateBlock(block);
    this.connectBlock(block, height);
    return { connected: true, height };
  }

  // Localizador de bloques para getblocks (maximo ~10 hashes como el original)
  getLocator() {
    const locator = [];
    const genesisHex = this.mainChain.get(0);
    let step = 1;
    let h = this.height;
    while (h >= 0) {
      locator.push(Buffer.from(this.mainChain.get(h), 'hex'));
      if (locator.length >= 10) step *= 2;
      h -= step;
    }
    // El genesis siempre va al final
    if (!locator.some((l) => l.toString('hex') === genesisHex)) {
      locator.push(Buffer.from(genesisHex, 'hex'));
    }
    return locator;
  }

  // Bloques posteriores a un hash del localizador (para responder getblocks)
  blocksAfter(hashHex, max = 500) {
    const known = this.blocksByHash.get(hashHex);
    const startHeight = known ? known.height + 1 : 0;
    const result = [];
    for (let h = startHeight; h <= this.height && result.length < max; h++) {
      result.push(this.blocksByHash.get(this.mainChain.get(h)).block);
    }
    return result;
  }

  // Balance de una direccion escaneando UTXOs pay-to-pubkey
  getBalance(pubKey) {
    const script = require('../core/script');
    const target = script.createPayToPubKeyScript(pubKey);
    let balance = 0n;
    for (const [, utxo] of this.utxos) {
      if (utxo.scriptPubKey.equals(target)) balance += utxo.value;
    }
    return balance;
  }

  // UTXOs gastables por una clave
  getUtxosFor(pubKey) {
    const script = require('../core/script');
    const target = script.createPayToPubKeyScript(pubKey);
    const result = [];
    for (const [key, utxo] of this.utxos) {
      if (utxo.scriptPubKey.equals(target)) {
        const [txidHex, nStr] = key.split(':');
        result.push({ txidRaw: Buffer.from(txidHex, 'hex'), n: Number(nStr), ...utxo });
      }
    }
    return result;
  }
}

module.exports = { ChainState, buildGenesis, GENESIS_PRIVKEY, GENESIS_TIME, GENESIS_MESSAGE };
