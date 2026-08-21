'use strict';

const secp256k1 = require('../crypto/secp256k1');

const OP_0 = 0x00;
const OP_CHECKSIG = 0xac;
const OP_DUP = 0x76;
const OP_HASH160 = 0xa9;
const OP_EQUALVERIFY = 0x88;
const OP_NOP = 0x61;

function createPayToPubKeyScript(pubKey) {
  if (pubKey.length > 75) throw new Error('Clave publica demasiado larga para push directo');
  return Buffer.concat([Buffer.from([pubKey.length]), pubKey, Buffer.from([OP_CHECKSIG])]);
}

function createSignatureScript(sigDer, hashtype = 0x01) {
  const sigWithHash = Buffer.concat([sigDer, Buffer.from([hashtype])]);
  return Buffer.concat([Buffer.from([sigWithHash.length]), sigWithHash]);
}

function parseScript(script) {
  const elements = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i];
    if (op >= 0x01 && op <= 0x4b) {
      elements.push({ opcode: op, data: script.subarray(i + 1, i + 1 + op) });
      i += 1 + op;
    } else {
      elements.push({ opcode: op, data: null });
      i += 1;
    }
  }
  return elements;
}


function evaluateScript(scriptSig, scriptPubKey, txHashForSig) {
  const stack = [];

  function run(script) {
    const elements = parseScript(script);
    for (const el of elements) {
      switch (el.opcode) {
        case OP_DUP:
          if (stack.length === 0) return false;
          stack.push(stack[stack.length - 1]);
          break;
        case OP_HASH160:
        case OP_EQUALVERIFY:
        case OP_CHECKSIG:
        case OP_NOP:
        case OP_0:
          stack.push({ opcode: el.opcode, data: el.data });
          break;
        default:
          if (el.opcode >= 0x01 && el.opcode <= 0x4b) {
            stack.push({ opcode: 'push', data: el.data });
          } else {
            return false; 
          }
      }
    }
    return true;
  }

  if (!run(scriptSig)) return false;
  if (!run(scriptPubKey)) return false;

  
  const ops = [...stack];
  while (ops.length >= 3) {
    const a = ops.shift();
    const b = ops.shift();
    const c = ops.shift();
    if (
      c.opcode === OP_CHECKSIG &&
      b.opcode === 'push' &&
      a.opcode === 'push'
    ) {
      const sigWithHash = a.data;
      const pubKey = b.data;
      if (!sigWithHash || sigWithHash.length < 2) return false;
      const sigDer = sigWithHash.subarray(0, -1);
      try {
        if (!secp256k1.verify(txHashForSig, sigDer, pubKey)) return false;
      } catch {
        return false;
      }
      ops.unshift({ opcode: 'true', data: null });
    } else if (
      c.opcode === OP_DUP &&
      b.opcode === OP_HASH160
    ) {
      ops.unshift(c, b, a);
      break;
    } else {
      return false;
    }
  }

  const last = ops[ops.length - 1];
  return !!last && last.opcode === 'true';
}

module.exports = {
  OP_0,
  OP_CHECKSIG,
  OP_DUP,
  OP_HASH160,
  OP_EQUALVERIFY,
  OP_NOP,
  createPayToPubKeyScript,
  createSignatureScript,
  parseScript,
  evaluateScript,
};
