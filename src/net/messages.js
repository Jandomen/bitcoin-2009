'use strict';

const { sha256d } = require('../crypto/hash');
const { Transaction } = require('../core/transaction');
const { Block, HEADER_SIZE } = require('../core/block');

// Magic de mainnet: F9 BE B4 D9 (los bytes de inicio del genesis)
const MAGIC = Buffer.from([0xf9, 0xbe, 0xb4, 0xd9]);

// Tipos de inventario
const MSG_TX = 1;
const MSG_BLOCK = 2;

const MAX_PAYLOAD = 32 * 1024 * 1024;

function padCommand(cmd) {
  const buf = Buffer.alloc(12);
  Buffer.from(cmd, 'ascii').copy(buf, 0, 0, Math.min(cmd.length, 12));
  return buf;
}

function readCommand(buf) {
  const end = buf.indexOf(0x00);
  return buf.subarray(0, end === -1 ? 12 : end).toString('ascii');
}

// Estructura: [magic:4][command:12][length:4][checksum:4][payload]
// El checksum se anadio en la version 31402 (oct 2010); lo incluimos por robustez.
function encodeMessage(command, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(24);
  MAGIC.copy(header, 0);
  padCommand(command).copy(header, 4);
  header.writeUInt32LE(payload.length, 16);
  if (payload.length > 0) {
    header.writeUInt32LE(sha256d(payload).readUInt32LE(0), 20);
  }
  return Buffer.concat([header, payload]);
}

// Decodifica el primer mensaje completo del buffer.
// Devuelve { message: {command, payload}, rest } o null si falta datos.
function decodeMessage(buffer) {
  if (buffer.length < 24) return null;
  if (!buffer.subarray(0, 4).equals(MAGIC)) {
    throw new Error('Magic invalido: no es un mensaje de nuestra red');
  }
  const length = buffer.readUInt32LE(16);
  if (length > MAX_PAYLOAD) throw new Error('Payload demasiado grande');
  if (buffer.length < 24 + length) return null;
  const payload = buffer.subarray(24, 24 + length);
  if (length > 0) {
    const checksum = buffer.readUInt32LE(20);
    const expected = sha256d(payload).readUInt32LE(0);
    if (checksum !== expected) throw new Error('Checksum invalido');
  }
  return {
    message: {
      command: readCommand(buffer.subarray(4, 16)),
      payload,
    },
    rest: buffer.subarray(24 + length),
  };
}

// ---- Codificacion de direcciones (26 bytes estilo pre-BIP155) ----
// [services:8][ip:16 (IPv6 con IPv4-mapped)][port:2]
function encodeAddr(ip, port, services = 1n) {
  const buf = Buffer.alloc(26);
  buf.writeBigUInt64LE(services, 0);
  // IPv4-mapped IPv6 ::ffff:a.b.c.d
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !(p >= 0 && p <= 255))) {
    throw new Error(`IP invalida: ${ip}`);
  }
  Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff,
    parts[0], parts[1], parts[2], parts[3]]).copy(buf, 8);
  buf.writeUInt16BE(port, 24);
  return buf;
}

function decodeAddr(buf, offset = 0) {
  const services = buf.readBigUInt64LE(offset);
  const ipStart = offset + 8;
  // IPv4-mapped: los bytes 10 y 11 de la IP son ff ff
  const isV4Mapped = buf[ipStart + 10] === 0xff && buf[ipStart + 11] === 0xff;
  let ip;
  if (isV4Mapped) {
    ip = [
      buf[ipStart + 12], buf[ipStart + 13], buf[ipStart + 14], buf[ipStart + 15],
    ].join('.');
  } else {
    const hex = buf.subarray(ipStart, ipStart + 16).toString('hex');
    ip = hex.match(/.{4}/g).join(':');
  }
  const port = buf.readUInt16BE(offset + 24);
  return { services, ip, port };
}

// ---- version ----
// [nVersion:4][services:8][timestamp:8][addrMe:26][addrFrom:26][nonce:8]
// [subVer varint str][startHeight:4]
function encodeVersion({ version, services, timestamp, addrMe, addrFrom, nonce, subVer, startHeight }) {
  let buf = Buffer.alloc(4 + 8 + 8);
  buf.writeInt32LE(version, 0);
  buf.writeBigUInt64LE(services ?? 1n, 4);
  buf.writeBigInt64LE(timestamp ?? BigInt(Math.floor(Date.now() / 1000)), 12);
  buf = Buffer.concat([buf, encodeAddr(addrMe.ip, addrMe.port)]);
  buf = Buffer.concat([buf, encodeAddr(addrFrom.ip, addrFrom.port)]);
  const n = Buffer.alloc(8);
  n.writeBigUInt64LE(nonce ?? BigInt(Date.now()), 0);
  buf = Buffer.concat([buf, n]);
  const sv = Buffer.from(subVer ?? '/bitcoin-2009:0.1.0/', 'utf8');
  const { writeVarint } = require('../core/transaction');
  buf = writeVarint(sv.length, buf);
  buf = Buffer.concat([buf, sv]);
  const sh = Buffer.alloc(4);
  sh.writeInt32LE(startHeight ?? 0, 0);
  return Buffer.concat([buf, sh]);
}

function decodeVersion(payload) {
  const { readVarint } = require('../core/transaction');
  let offset = 0;
  const version = payload.readInt32LE(offset); offset += 4;
  const services = payload.readBigUInt64LE(offset); offset += 8;
  const timestamp = payload.readBigInt64LE(offset); offset += 8;
  const addrMe = decodeAddr(payload, offset); offset += 26;
  const addrFrom = decodeAddr(payload, offset); offset += 26;
  const nonce = payload.readBigUInt64LE(offset); offset += 8;
  const svLen = readVarint(payload, offset); offset += svLen.size;
  const subVer = payload.subarray(offset, offset + Number(svLen.value)).toString('utf8'); offset += Number(svLen.value);
  const startHeight = payload.readInt32LE(offset);
  return { version, services, timestamp, addrMe, addrFrom, nonce, subVer, startHeight };
}

// ---- inv / getdata ----
// [count varint][ (type:4)(hash:32) x count ]
function encodeInventory(vectors) {
  const { writeVarint } = require('../core/transaction');
  let buf = writeVarint(vectors.length, Buffer.alloc(0));
  for (const v of vectors) {
    const item = Buffer.alloc(36);
    item.writeUInt32LE(v.type, 0);
    v.hash.copy(item, 4);
    buf = Buffer.concat([buf, item]);
  }
  return buf;
}

function decodeInventory(payload) {
  const { readVarint } = require('../core/transaction');
  const count = readVarint(payload, 0);
  let offset = count.size;
  const vectors = [];
  for (let i = 0; i < Number(count.value); i++) {
    vectors.push({
      type: payload.readUInt32LE(offset),
      hash: Buffer.from(payload.subarray(offset + 4, offset + 36)),
    });
    offset += 36;
  }
  return vectors;
}

// ---- getblocks ----
// [version:4][locator count varint][hashes...][hashStop:32]
function encodeGetBlocks(locatorHashes, hashStop) {
  const { writeVarint } = require('../core/transaction');
  let buf = Buffer.alloc(4);
  buf.writeInt32LE(1, 0);
  buf = writeVarint(locatorHashes.length, buf);
  for (const h of locatorHashes) {
    buf = Buffer.concat([buf, h]);
  }
  const stop = hashStop ?? Buffer.alloc(32);
  return Buffer.concat([buf, stop]);
}

function decodeGetBlocks(payload) {
  const { readVarint } = require('../core/transaction');
  let offset = 4;
  const count = readVarint(payload, offset);
  offset += count.size;
  const locator = [];
  for (let i = 0; i < Number(count.value); i++) {
    locator.push(Buffer.from(payload.subarray(offset, offset + 32)));
    offset += 32;
  }
  const hashStop = Buffer.from(payload.subarray(offset, offset + 32));
  return { version: payload.readInt32LE(0), locator, hashStop };
}

// ---- addr ----
// [count varint][ (time:4)(addr:26) x count ]
function encodeAddrList(entries) {
  const { writeVarint } = require('../core/transaction');
  let buf = writeVarint(entries.length, Buffer.alloc(0));
  for (const e of entries) {
    const t = Buffer.alloc(4);
    t.writeUInt32LE(e.time ?? Math.floor(Date.now() / 1000), 0);
    buf = Buffer.concat([buf, t, encodeAddr(e.ip, e.port)]);
  }
  return buf;
}

function decodeAddrList(payload) {
  const { readVarint } = require('../core/transaction');
  const count = readVarint(payload, 0);
  let offset = count.size;
  const entries = [];
  for (let i = 0; i < Number(count.value); i++) {
    const time = payload.readUInt32LE(offset);
    entries.push({ time, ...decodeAddr(payload, offset + 4) });
    offset += 30;
  }
  return entries;
}

module.exports = {
  MAGIC,
  MSG_TX,
  MSG_BLOCK,
  HEADER_SIZE,
  encodeMessage,
  decodeMessage,
  encodeVersion,
  decodeVersion,
  encodeInventory,
  decodeInventory,
  encodeGetBlocks,
  decodeGetBlocks,
  encodeAddrList,
  decodeAddrList,
  encodeAddr,
  decodeAddr,
};
