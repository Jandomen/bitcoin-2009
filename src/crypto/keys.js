'use strict';

const secp256k1 = require('./secp256k1');
const { encodeBase58Check, decodeBase58Check } = require('./base58');
const { hash160 } = require('./hash');

const ADDRESS_VERSION = Buffer.from([0x00]);

function generateKeyPair() {
  const privateKey = secp256k1.generatePrivateKey();
  const publicKey = secp256k1.getPublicKey(privateKey, 'uncompressed');
  return { privateKey, publicKey };
}

function publicKeyToAddress(publicKey) {
  const payload = Buffer.concat([ADDRESS_VERSION, hash160(publicKey)]);
  return encodeBase58Check(payload);
}

function addressToPubKeyHash(address) {
  const payload = decodeBase58Check(address);
  if (payload.length !== 21) throw new Error('Longitud de direccion invalida');
  if (payload[0] !== 0x00) throw new Error('Version de direccion no soportada');
  return payload.subarray(1);
}

function validateAddress(address) {
  try {
    addressToPubKeyHash(address);
    return true;
  } catch {
    return false;
  }
}

function privateKeyToWIF(privateKey) {
  const payload = Buffer.concat([Buffer.from([0x80]), privateKey]);
  return encodeBase58Check(payload);
}

function wifToPrivateKey(wif) {
  const payload = decodeBase58Check(wif);
  if (payload.length !== 33 || payload[0] !== 0x80) {
    throw new Error('WIF invalido');
  }
  return payload.subarray(1);
}

module.exports = {
  generateKeyPair,
  publicKeyToAddress,
  addressToPubKeyHash,
  validateAddress,
  privateKeyToWIF,
  wifToPrivateKey,
};
