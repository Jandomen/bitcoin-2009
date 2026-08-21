'use strict';

const { sha256d } = require('./hash');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const CHAR_MAP = new Map();
for (let i = 0; i < ALPHABET.length; i++) {
  CHAR_MAP.set(ALPHABET[i], i);
}

function encodeBase58(buf) {
  if (buf.length === 0) return '';
  const digits = [0];
  for (let i = 0; i < buf.length; i++) {
    let carry = buf[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let i = 0; i < buf.length && buf[i] === 0; i++) out += ALPHABET[0];
  for (let i = digits.length - 1; i >= 0; i--) {
    if (i === digits.length - 1 && digits[i] === 0) continue;
    out += ALPHABET[digits[i]];
  }
  return out;
}

function decodeBase58(str) {
  if (str.length === 0) return Buffer.alloc(0);
  const bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const val = CHAR_MAP.get(str[i]);
    if (val === undefined) throw new Error(`Caracter Base58 invalido: ${str[i]}`);
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < str.length && str[zeros] === ALPHABET[0]) zeros++;
  const out = Buffer.alloc(zeros + bytes.length);
  for (let i = 0; i < zeros; i++) out[i] = 0;
  for (let i = 0; i < bytes.length; i++) {
    out[out.length - 1 - i] = bytes[i];
  }
  return out;
}

function encodeBase58Check(payload) {
  const checksum = sha256d(payload).subarray(0, 4);
  return encodeBase58(Buffer.concat([payload, checksum]));
}

function decodeBase58Check(str) {
  const decoded = decodeBase58(str);
  if (decoded.length < 5) throw new Error('Base58Check demasiado corto');
  const payload = decoded.subarray(0, decoded.length - 4);
  const checksum = decoded.subarray(decoded.length - 4);
  const expected = sha256d(payload).subarray(0, 4);
  if (!checksum.equals(expected)) throw new Error('Checksum Base58Check invalido');
  return payload;
}

module.exports = { encodeBase58, decodeBase58, encodeBase58Check, decodeBase58Check };
