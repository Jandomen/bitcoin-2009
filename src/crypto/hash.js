'use strict';

const crypto = require('crypto');

const oneShot = typeof crypto.hash === 'function';

function sha256(buf) {
  if (oneShot) return crypto.hash('sha256', buf, 'buffer');
  return crypto.createHash('sha256').update(buf).digest();
}

function sha256d(buf) {
  return sha256(sha256(buf));
}

function ripemd160(buf) {
  if (oneShot) return crypto.hash('ripemd160', buf, 'buffer');
  return crypto.createHash('ripemd160').update(buf).digest();
}

function hash160(buf) {
  return ripemd160(sha256(buf));
}

module.exports = { sha256, sha256d, ripemd160, hash160 };
