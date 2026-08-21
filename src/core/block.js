'use strict';

const { sha256d } = require('../crypto/hash');
const { Transaction } = require('./transaction');


const HEADER_SIZE = 80;

const DIFFICULTY_ONE_BITS = 0x1d00ffff;


const DEMO_BITS = 0x1f00ffff;

function compactToTarget(nBits) {
  const exponent = nBits >> 24;
  const mantissa = BigInt(nBits & 0x007fffff);
  if (nBits & 0x00800000) throw new Error('Signo negativo en nBits no soportado');
  if (exponent <= 3) {
    return mantissa >> BigInt(8 * (3 - exponent));
  }
  return mantissa << BigInt(8 * (exponent - 3));
}

function targetToCompact(target) {
  if (target === 0n) return 0;
  let size = (target.toString(16).length + 1) >> 1;
  let mantissa;
  if (size <= 3) {
    mantissa = Number(target) << (8 * (3 - size));
  } else {
    mantissa = Number(target >> BigInt(8 * (size - 3)));
  }
  if (mantissa & 0x00800000) {
    mantissa >>= 8;
    size++;
  }
  return (size << 24) | mantissa;
}

function getDifficulty(nBits) {
  const target = compactToTarget(nBits);
  const maxTarget = compactToTarget(DIFFICULTY_ONE_BITS);
  return Number(maxTarget) / (Number(target) + 1);
}

class Block {
  constructor() {
    this.version = 1;
    this.prevBlockHash = Buffer.alloc(32);
    this.merkleRoot = Buffer.alloc(32);
    this.time = Math.floor(Date.now() / 1000);
    this.bits = DIFFICULTY_ONE_BITS;
    this.nonce = 0;
    this.transactions = [];
  }

  serializeHeader() {
    const buf = Buffer.alloc(HEADER_SIZE);
    buf.writeInt32LE(this.version, 0);
    this.prevBlockHash.copy(buf, 4);
    this.merkleRoot.copy(buf, 36);
    buf.writeUInt32LE(this.time >>> 0, 68);
    buf.writeUInt32LE(this.bits >>> 0, 72);
    buf.writeUInt32LE(this.nonce >>> 0, 76);
    return buf;
  }

  static deserializeHeader(buf) {
    const block = new Block();
    block.version = buf.readInt32LE(0);
    block.prevBlockHash = Buffer.from(buf.subarray(4, 36));
    block.merkleRoot = Buffer.from(buf.subarray(36, 68));
    block.time = buf.readUInt32LE(68);
    block.bits = buf.readUInt32LE(72);
    block.nonce = buf.readUInt32LE(76);
    return block;
  }

  serialize() {
    const { writeVarint } = require('./transaction');
    let buf = this.serializeHeader();
    buf = writeVarint(this.transactions.length, buf);
    for (const tx of this.transactions) {
      buf = Buffer.concat([buf, tx.serialize()]);
    }
    return buf;
  }

  static deserialize(buf) {
    const { readVarint } = require('./transaction');
    const block = Block.deserializeHeader(buf);
    let offset = HEADER_SIZE;
    const count = readVarint(buf, offset);
    offset += count.size;
    for (let i = 0; i < Number(count.value); i++) {
      const remaining = buf.subarray(offset);
      const tx = deserializeTxFrom(remaining);
      offset += tx.serialize().length;
      block.transactions.push(tx);
    }
    return block;
  }

  getHash() {
    return sha256d(this.serializeHeader());
  }

  getHashHex() {
    return Buffer.from(this.getHash()).reverse().toString('hex');
  }

  computeMerkleRoot() {
    if (this.transactions.length === 0) throw new Error('Bloque sin transacciones');
    let level = this.transactions.map((tx) => tx.getHash());
    while (level.length > 1) {
      if (level.length % 2 === 1) level.push(level[level.length - 1]);
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        next.push(sha256d(Buffer.concat([level[i], level[i + 1]])));
      }
      level = next;
    }
    return level[0];
  }

  updateMerkleRoot() {
    this.merkleRoot = this.computeMerkleRoot();
  }

  checkMerkleRoot() {
    return this.computeMerkleRoot().equals(this.merkleRoot);
  }

  checkProofOfWork() {
    const hash = this.getHash();
    const target = compactToTarget(this.bits);
    return hashToBigInt(hash) <= target;
  }
}

function hashToBigInt(hash) {
  return BigInt('0x' + Buffer.from(hash).reverse().toString('hex'));
}

function deserializeTxFrom(buf) {
  const { readVarint } = require('./transaction');
  let offset = 4; // version
  let count = readVarint(buf, offset);
  offset += count.size;
  for (let i = 0; i < Number(count.value); i++) {
    offset += 36; // prevout
    const sl = readVarint(buf, offset);
    offset += sl.size + Number(sl.value);
    offset += 4; // sequence
  }
  count = readVarint(buf, offset);
  offset += count.size;
  for (let i = 0; i < Number(count.value); i++) {
    offset += 8; // value
    const sl = readVarint(buf, offset);
    offset += sl.size + Number(sl.value);
  }
  offset += 4; // locktime
  return Transaction.deserialize(buf.subarray(0, offset));
}

module.exports = {
  Block,
  HEADER_SIZE,
  DIFFICULTY_ONE_BITS,
  DEMO_BITS,
  compactToTarget,
  targetToCompact,
  getDifficulty,
  hashToBigInt,
};
