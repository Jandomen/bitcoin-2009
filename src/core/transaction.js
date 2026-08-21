'use strict';

const { sha256d } = require('../crypto/hash');
const secp256k1 = require('../crypto/secp256k1');
const script = require('./script');
const { moneyRange } = require('./consensus');

function writeVarint(n, buf) {
  if (n < 0xfd) {
    const b = Buffer.alloc(1);
    b.writeUInt8(n);
    return Buffer.concat([buf, b]);
  } else if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b.writeUInt8(0xfd);
    b.writeUInt16LE(n, 1);
    return Buffer.concat([buf, b]);
  } else if (n <= 0xffffffff) {
    const b = Buffer.alloc(5);
    b.writeUInt8(0xfe);
    b.writeUInt32LE(n, 1);
    return Buffer.concat([buf, b]);
  }
  const b = Buffer.alloc(9);
  b.writeUInt8(0xff);
  b.writeBigUInt64LE(BigInt(n), 1);
  return Buffer.concat([buf, b]);
}

function readVarint(buf, offset) {
  const prefix = buf[offset];
  if (prefix < 0xfd) return { value: prefix, size: 1 };
  if (prefix === 0xfd) return { value: buf.readUInt16LE(offset + 1), size: 3 };
  if (prefix === 0xfe) return { value: buf.readUInt32LE(offset + 1), size: 5 };
  return { value: buf.readBigUInt64LE(offset + 1), size: 9 };
}

class Transaction {
  constructor() {
    this.version = 1;
    this.inputs = [];   
    this.outputs = []; 
    this.lockTime = 0;
  }

  isCoinBase() {
    return (
      this.inputs.length === 1 &&
      this.inputs[0].prevTxId.equals(Buffer.alloc(32)) &&
      this.inputs[0].prevN === 0xffffffff
    );
  }

  serialize() {
    let buf = Buffer.alloc(4);
    buf.writeInt32LE(this.version);
    buf = writeVarint(this.inputs.length, buf);
    for (const input of this.inputs) {
      buf = Buffer.concat([buf, input.prevTxId]);
      const outIdx = Buffer.alloc(4);
      outIdx.writeUInt32LE(input.prevN >>> 0);
      buf = Buffer.concat([buf, outIdx]);
      buf = writeVarint(input.scriptSig.length, buf);
      buf = Buffer.concat([buf, input.scriptSig]);
      const seq = Buffer.alloc(4);
      seq.writeUInt32LE(input.sequence >>> 0);
      buf = Buffer.concat([buf, seq]);
    }
    buf = writeVarint(this.outputs.length, buf);
    for (const output of this.outputs) {
      const val = Buffer.alloc(8);
      val.writeBigInt64LE(output.value);
      buf = Buffer.concat([buf, val]);
      buf = writeVarint(output.scriptPubKey.length, buf);
      buf = Buffer.concat([buf, output.scriptPubKey]);
    }
    const lt = Buffer.alloc(4);
    lt.writeUInt32LE(this.lockTime >>> 0);
    return Buffer.concat([buf, lt]);
  }

  static deserialize(buf) {
    const tx = new Transaction();
    let offset = 0;
    tx.version = buf.readInt32LE(offset);
    offset += 4;

    let count = readVarint(buf, offset);
    offset += count.size;
    const nInputs = Number(count.value);
    for (let i = 0; i < nInputs; i++) {
      const prevTxId = Buffer.from(buf.subarray(offset, offset + 32));
      offset += 32;
      const prevN = buf.readUInt32LE(offset);
      offset += 4;
      const sl = readVarint(buf, offset);
      offset += sl.size;
      const scriptSig = Buffer.from(buf.subarray(offset, offset + Number(sl.value)));
      offset += Number(sl.value);
      const sequence = buf.readUInt32LE(offset);
      offset += 4;
      tx.inputs.push({ prevTxId, prevN, scriptSig, sequence });
    }

    count = readVarint(buf, offset);
    offset += count.size;
    const nOutputs = Number(count.value);
    for (let i = 0; i < nOutputs; i++) {
      const value = buf.readBigInt64LE(offset);
      offset += 8;
      const sl = readVarint(buf, offset);
      offset += sl.size;
      const scriptPubKey = Buffer.from(buf.subarray(offset, offset + Number(sl.value)));
      offset += Number(sl.value);
      tx.outputs.push({ value, scriptPubKey });
    }

    tx.lockTime = buf.readUInt32LE(offset);
    return tx;
  }

  getHash() {
    return sha256d(this.serialize());
  }

  getTxid() {
    return Buffer.from(this.getHash()).reverse().toString('hex');
  }

  static fromHex(hex) {
    return Transaction.deserialize(Buffer.from(hex, 'hex'));
  }

  toHex() {
    return this.serialize().toString('hex');
  }


  sighash(inputIndex, spentScriptPubKey, hashtype = 0x01) {
    const copy = new Transaction();
    copy.version = this.version;
    copy.lockTime = this.lockTime;
    copy.inputs = this.inputs.map((input, i) => ({
      ...input,
      scriptSig: i === inputIndex ? spentScriptPubKey : Buffer.alloc(0),
    }));
    copy.outputs = this.outputs;
    const preimage = Buffer.concat([
      copy.serialize(),
      Buffer.from([hashtype, 0x00, 0x00, 0x00]),
    ]);
    return sha256d(preimage);
  }

  signInput(inputIndex, privKey, spentScriptPubKey) {
    const hash = this.sighash(inputIndex, spentScriptPubKey);
    const sigDer = secp256k1.sign(hash, privKey);
    this.inputs[inputIndex].scriptSig = script.createSignatureScript(sigDer);
  }

  verifyInput(inputIndex, spentScriptPubKey) {
    const input = this.inputs[inputIndex];
    const hash = this.sighash(inputIndex, spentScriptPubKey);
    return script.evaluateScript(input.scriptSig, spentScriptPubKey, hash);
  }

  checkStructure() {
    if (this.inputs.length === 0) throw new Error('Transaccion sin inputs');
    if (this.outputs.length === 0) throw new Error('Transaccion sin outputs');
    for (const output of this.outputs) {
      if (!moneyRange(output.value)) throw new Error('Valor fuera de rango');
    }
    if (this.isCoinBase()) {
      const s = this.inputs[0].scriptSig;
      if (s.length < 2 || s.length > 100) {
        throw new Error('scriptSig de coinbase fuera de rango (2-100 bytes)');
      }
    } else {
      const seen = new Set();
      for (const input of this.inputs) {
        const key = input.prevTxId.toString('hex') + ':' + input.prevN;
        if (seen.has(key)) throw new Error('Input duplicado');
        seen.add(key);
        if (input.prevTxId.length !== 32) throw new Error('prevTxId invalido');
      }
    }
    return true;
  }
}

function createCoinbase(subsidy, fees, pubKey, message = '') {
  const tx = new Transaction();
  const msgBuf = Buffer.from(message, 'utf8');
  const scriptSig = Buffer.concat([
    Buffer.from([Math.min(msgBuf.length, 75)]),
    msgBuf.subarray(0, 75),
  ]);
  tx.inputs.push({
    prevTxId: Buffer.alloc(32),
    prevN: 0xffffffff,
    scriptSig,
    sequence: 0xffffffff,
  });
  tx.outputs.push({
    value: subsidy + fees,
    scriptPubKey: script.createPayToPubKeyScript(pubKey),
  });
  return tx;
}


function createTransaction(inputs, recipients, keysByAddress) {
  const tx = new Transaction();
  let totalIn = 0n;

  for (const input of inputs) {
    const prevTxId = input.prevTx.getHash();
    tx.inputs.push({
      prevTxId,
      prevN: input.prevN,
      scriptSig: Buffer.alloc(0),
      sequence: 0xffffffff,
    });
    totalIn += input.prevTx.outputs[input.prevN].value;
  }

  let totalOut = 0n;
  for (const recipient of recipients) {
    const spk = recipient.pubKey
      ? script.createPayToPubKeyScript(recipient.pubKey)
      : null;
    if (!spk) throw new Error('Se requiere pubKey (pay-to-pubkey puro, estilo 2009)');
    tx.outputs.push({ value: recipient.value, scriptPubKey: spk });
    totalOut += recipient.value;
  }

  if (totalOut > totalIn) throw new Error('Outputs superan a los inputs');

  const change = totalIn - totalOut;
  if (change > 0n) {
    const firstPriv = keysByAddress[Object.keys(keysByAddress)[0]];
    const changePub = secp256k1.getPublicKey(firstPriv, 'uncompressed');
    tx.outputs.push({ value: change, scriptPubKey: script.createPayToPubKeyScript(changePub) });
  }

  inputs.forEach((input, i) => {
    const spk = input.prevTx.outputs[input.prevN].scriptPubKey;
    const addr = findAddressForScript(spk, keysByAddress);
    if (!addr) throw new Error('No hay clave privada para uno de los inputs');
    tx.signInput(i, keysByAddress[addr], spk);
  });

  return tx;
}

function findAddressForScript(scriptPubKey, keysByAddress) {
  const { publicKeyToAddress } = require('../crypto/keys');
  for (const [addr, priv] of Object.entries(keysByAddress)) {
    const pub = secp256k1.getPublicKey(priv, 'uncompressed');
    const candidate = script.createPayToPubKeyScript(pub);
    if (candidate.equals(scriptPubKey)) return addr;
  }
  return null;
}

module.exports = {
  Transaction,
  createCoinbase,
  createTransaction,
  writeVarint,
  readVarint,
};
