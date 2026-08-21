'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');
const { sha256d } = require('../crypto/hash');
const { compactToTarget, hashToBigInt } = require('./block');


function mineBlock(block, options = {}) {
  const target = compactToTarget(block.bits);
  const numWorkers = options.threads || Math.max(1, os.cpus().length - 1);

  if (numWorkers === 1 || !isMainThread) {
    return mineRange(block, target, 0, 0xffffffff);
  }

  return new Promise((resolve, reject) => {
    let solved = false;
    let done = 0;
    const workers = [];

    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker(__filename, {
        workerData: {
          header: block.serializeHeader(),
          targetHex: target.toString(16),
          start: i,
          step: numWorkers,
        },
      });
      worker.on('message', (msg) => {
        if (msg.type === 'solved' && !solved) {
          solved = true;
          block.nonce = msg.nonce;
          workers.forEach((w) => w.terminate());
          resolve({ nonce: msg.nonce, hashes: msg.hashes });
        }
      });
      worker.on('error', reject);
      worker.on('exit', () => {
        done++;
        if (done === numWorkers && !solved) {
          reject(new Error('Espacio de nonces agotado'));
        }
      });
      workers.push(worker);
    }
  });
}

function mineRange(block, target, start, step) {
  const header = Buffer.from(block.serializeHeader());
  let nonce = start >>> 0;
  let hashes = 0;
  while (nonce <= 0xffffffff) {
    header.writeUInt32LE(nonce, 76);
    hashes++;
    if (hashToBigInt(sha256d(header)) <= target) {
      return { nonce, hashes };
    }
    nonce += step;
  }
  return null;
}

if (!isMainThread) {
  const { header, targetHex, start, step } = workerData;
  const target = BigInt('0x' + targetHex);
  const fakeBlock = { serializeHeader: () => header };
  const result = mineRange(fakeBlock, target, start, step);
  parentPort.postMessage(
    result
      ? { type: 'solved', nonce: result.nonce, hashes: result.hashes }
      : { type: 'exhausted', hashes: 0 }
  );
}

module.exports = { mineBlock };
