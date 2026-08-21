'use strict';

const crypto = require('crypto');

const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const A = 0n;
const B = 7n;
const GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

const ZERO = { x: null, y: null, inf: true };

function mod(a, m = P) {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function modInverse(a, m = P) {
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return mod(old_s, m);
}

function pointAdd(p1, p2) {
  if (p1.inf) return p2;
  if (p2.inf) return p1;
  if (p1.x === p2.x && p1.y !== p2.y) return ZERO;
  if (p1.x === p2.x && p1.y === p2.y) {
    const lam = mod(3n * p1.x * p1.x * modInverse(2n * p1.y));
    const x = mod(lam * lam - 2n * p1.x);
    const y = mod(lam * (p1.x - x) - p1.y);
    return { x, y, inf: false };
  }
  const lam = mod((p2.y - p1.y) * modInverse(p2.x - p1.x));
  const x = mod(lam * lam - p1.x - p2.x);
  const y = mod(lam * (p1.x - x) - p1.y);
  return { x, y, inf: false };
}

function pointMul(k, point) {
  let result = ZERO;
  let addend = point;
  while (k > 0n) {
    if (k & 1n) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    k >>= 1n;
  }
  return result;
}

function isValidPoint(point) {
  if (point.inf) return false;
  if (point.x < 0n || point.x >= P || point.y < 0n || point.y >= P) return false;
  const left = mod(point.y * point.y);
  const right = mod(point.x * point.x * point.x + A * point.x + B);
  return left === right;
}

const G = { x: GX, y: GY, inf: false };

function generatePrivateKey() {
  while (true) {
    const buf = crypto.randomBytes(32);
    const k = BigInt('0x' + buf.toString('hex'));
    if (k > 0n && k < N) return buf;
  }
}

function privateKeyToBigInt(privBuf) {
  const k = BigInt('0x' + privBuf.toString('hex'));
  if (!(k > 0n && k < N)) throw new Error('Clave privada fuera de rango');
  return k;
}

function getPublicKey(privBuf, format = 'uncompressed') {
  const k = privateKeyToBigInt(privBuf);
  const pub = pointMul(k, G);
  if (!isValidPoint(pub)) throw new Error('Punto publico invalido');
  const xHex = pub.x.toString(16).padStart(64, '0');
  const yHex = pub.y.toString(16).padStart(64, '0');
  if (format === 'compressed') {
    const prefix = pub.y % 2n === 0n ? '02' : '03';
    return Buffer.from(prefix + xHex, 'hex');
  }
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(xHex + yHex, 'hex')]);
}

function decodePublicKey(pubBuf) {
  if (pubBuf.length === 33) {
    const prefix = pubBuf[0];
    if (prefix !== 0x02 && prefix !== 0x03) throw new Error('Prefijo comprimido invalido');
    const x = BigInt('0x' + pubBuf.subarray(1).toString('hex'));
    let y = mod((x * x * x + B) ** ((P + 1n) / 4n));
    const wantOdd = prefix === 0x03;
    if ((y % 2n === 0n) === wantOdd) y = P - y;
    const point = { x, y, inf: false };
    if (!isValidPoint(point)) throw new Error('Clave publica comprimida invalida');
    return point;
  }
  if (pubBuf.length === 65 && pubBuf[0] === 0x04) {
    const x = BigInt('0x' + pubBuf.subarray(1, 33).toString('hex'));
    const y = BigInt('0x' + pubBuf.subarray(33).toString('hex'));
    const point = { x, y, inf: false };
    if (!isValidPoint(point)) throw new Error('Clave publica no comprimida invalida');
    return point;
  }
  throw new Error('Formato de clave publica desconocido');
}

function derEncodeInt(value) {
  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const bytes = Buffer.from(hex, 'hex');
  const needsPad = bytes[0] & 0x80;
  const body = needsPad ? Buffer.concat([Buffer.from([0x00]), bytes]) : bytes;
  return Buffer.concat([Buffer.from([0x02, body.length]), body]);
}

function derDecodeInt(buf, offset) {
  if (buf[offset] !== 0x02) throw new Error('DER: se esperaba INTEGER');
  const len = buf[offset + 1];
  return BigInt('0x' + buf.subarray(offset + 2, offset + 2 + len).toString('hex'));
}

function sign(hashBuf, privBuf) {
  if (hashBuf.length !== 32) throw new Error('El hash debe ser de 32 bytes');
  const d = privateKeyToBigInt(privBuf);
  const z = BigInt('0x' + hashBuf.toString('hex'));
  while (true) {
    const k = privateKeyToBigInt(crypto.randomBytes(32));
    const R = pointMul(k, G);
    const r = mod(R.x, N);
    if (r === 0n) continue;
    const kInv = modInverse(k, N);
    let s = mod(kInv * (z + r * d), N);
    if (s === 0n) continue;
    const sigBody = Buffer.concat([derEncodeInt(r), derEncodeInt(s)]);
    return Buffer.concat([Buffer.from([0x30, sigBody.length]), sigBody]);
  }
}

function verify(hashBuf, sigDer, pubBuf) {
  try {
    if (hashBuf.length !== 32) return false;
    if (sigDer[0] !== 0x30) return false;
    const totalLen = sigDer[1];
    if (sigDer[2] !== 0x02) return false;
    const rLen = sigDer[3];
    if (sigDer[4 + rLen] !== 0x02) return false;
    const sLen = sigDer[5 + rLen];
    if (4 + rLen + 2 + sLen !== 2 + totalLen) return false;

    const r = derDecodeInt(sigDer, 2);
    const s = derDecodeInt(sigDer, 4 + rLen);
    if (!(r > 0n && r < N && s > 0n && s < N)) return false;

    const Q = decodePublicKey(pubBuf);
    const z = BigInt('0x' + hashBuf.toString('hex'));

    const w = modInverse(s, N);
    const u1 = mod(z * w, N);
    const u2 = mod(r * w, N);
    const X = pointAdd(pointMul(u1, G), pointMul(u2, Q));
    if (X.inf) return false;
    return mod(X.x, N) === r;
  } catch {
    return false;
  }
}

module.exports = {
  P, N, A, B, G,
  generatePrivateKey,
  getPublicKey,
  decodePublicKey,
  sign,
  verify,
};
