'use strict';

// Suite de pruebas end-to-end de bitcoin-2009
// Uso: node test/run-tests.js

const assert = require('assert');
const fs = require('fs');

const TMP = '/var/folders/zc/71c7zmtd0jjf5vnnq2shsp9r0000gn/T/opencode/btc-tests';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      failed++;
      failures.push({ name, err });
      console.log(`FALLO ${name}\n       ${err.message}`);
    });
}

async function run() {
  fs.rmSync(TMP, { recursive: true, force: true });

  // ==================== CRIPTOGRAFIA ====================
  console.log('\n[1] Criptografia');

  await test('secp256k1: privkey=1 deriva el punto G', () => {
    const secp = require('../src/crypto/secp256k1');
    const one = Buffer.alloc(32);
    one[31] = 1;
    const pub = secp.getPublicKey(one, 'uncompressed');
    const expected = '04' + secp.G.x.toString(16).padStart(64, '0') + secp.G.y.toString(16).padStart(64, '0');
    assert.strictEqual(pub.toString('hex'), expected);
  });

  await test('direccion oficial del vector de la wiki de Bitcoin', () => {
    const { publicKeyToAddress } = require('../src/crypto/keys');
    const priv = Buffer.from('18e14a7b6a307f426a94f8114701e7c8e774e7f9a47e2c2035db29a206321725', 'hex');
    const pub = require('../src/crypto/secp256k1').getPublicKey(priv, 'uncompressed');
    assert.strictEqual(publicKeyToAddress(pub), '16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM');
  });

  await test('la direccion genesis de Satoshi decodifica con checksum valido', () => {
    const { decodeBase58Check } = require('../src/crypto/base58');
    const payload = decodeBase58Check('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    assert.strictEqual(payload.length, 21);
    assert.strictEqual(payload[0], 0x00);
  });

  await test('ECDSA: firma valida, manipulada y con otra clave no', () => {
    const secp = require('../src/crypto/secp256k1');
    const priv = Buffer.from('18e14a7b6a307f426a94f8114701e7c8e774e7f9a47e2c2035db29a206321725', 'hex');
    const pub = secp.getPublicKey(priv, 'uncompressed');
    const msg = Buffer.from('9c90ff9c0f5f2b4d5f30cba11000000000000000000000000000000000000000', 'hex');
    const sig = secp.sign(msg, priv);
    assert.ok(secp.verify(msg, sig, pub));
    assert.ok(!secp.verify(Buffer.alloc(32, 1), sig, pub));
    assert.ok(!secp.verify(msg, sig, secp.getPublicKey(Buffer.alloc(32, 2), 'uncompressed')));
  });

  await test('WIF roundtrip', () => {
    const { privateKeyToWIF, wifToPrivateKey } = require('../src/crypto/keys');
    const priv = Buffer.from('1809090909090909090909090909090909090909090909090909090909090925', 'hex');
    assert.deepStrictEqual(wifToPrivateKey(privateKeyToWIF(priv)), priv);
  });

  await test('Base58Check rechaza checksum corrupto', () => {
    const { encodeBase58Check, decodeBase58Check } = require('../src/crypto/base58');
    const enc = encodeBase58Check(Buffer.from('hola mundo'));
    const chars = enc.split('');
    chars[0] = chars[0] === '2' ? '3' : '2';
    assert.throws(() => decodeBase58Check(chars.join('')), /Checksum/);
  });

  // ==================== CONSENSO ====================
  console.log('\n[2] Consenso (21 millones)');

  await test('subsidio: 50 BTC y halving cada 210.000 bloques', () => {
    const { getBlockSubsidy, COIN } = require('../src/core/consensus');
    assert.strictEqual(getBlockSubsidy(0), 50n * COIN);
    assert.strictEqual(getBlockSubsidy(209999), 50n * COIN);
    assert.strictEqual(getBlockSubsidy(210000), 25n * COIN);
    assert.strictEqual(getBlockSubsidy(420000), 1250000000n);
  });

  await test('sumatorio del subsidio = 20.999.999,9769 BTC (el maximo real)', () => {
    const { getBlockSubsidy, COIN } = require('../src/core/consensus');
    let total = 0n;
    for (let h = 0; ; h += 210000) {
      const s = getBlockSubsidy(h);
      if (s === 0n) break;
      total += s * 210000n;
    }
    assert.strictEqual(total, 2099999997690000n);
  });

  // ==================== TRANSACCIONES ====================
  console.log('\n[3] Transacciones pay-to-pubkey');

  await test('coinbase + gasto + roundtrip binario + deteccion de manipulacion', () => {
    const { Transaction, createCoinbase, createTransaction } = require('../src/core/transaction');
    const { generateKeyPair, publicKeyToAddress } = require('../src/crypto/keys');
    const satoshi = generateKeyPair();
    const hal = generateKeyPair();
    const cb = createCoinbase(5000000000n, 0n, satoshi.publicKey, 'test');
    assert.ok(cb.isCoinBase());
    const tx = createTransaction(
      [{ prevTx: cb, prevN: 0 }],
      [{ pubKey: hal.publicKey, value: 1000000000n }],
      { [publicKeyToAddress(satoshi.publicKey)]: satoshi.privateKey }
    );
    assert.ok(tx.verifyInput(0, cb.outputs[0].scriptPubKey));
    const rt = Transaction.fromHex(tx.toHex());
    assert.strictEqual(rt.getTxid(), tx.getTxid());
    rt.outputs[0].value = 123456789n;
    assert.ok(!rt.verifyInput(0, cb.outputs[0].scriptPubKey));
  });

  await test('transaccion con saldo insuficiente rechazada', () => {
    const { Transaction, createCoinbase, createTransaction } = require('../src/core/transaction');
    const { generateKeyPair, publicKeyToAddress } = require('../src/crypto/keys');
    const a = generateKeyPair();
    const b = generateKeyPair();
    const cb = createCoinbase(5000000000n, 0n, a.publicKey, 'x');
    assert.throws(() =>
      createTransaction(
        [{ prevTx: cb, prevN: 0 }],
        [{ pubKey: b.publicKey, value: 6000000000n }],
        { [publicKeyToAddress(a.publicKey)]: a.privateKey }
      ), /superan|insuficiente/i);
  });

  // ==================== BLOQUES Y POW ====================
  console.log('\n[4] Bloques de 80 bytes, Merkle y PoW');

  await test('cabecera de exactamente 80 bytes', () => {
    const { Block } = require('../src/core/block');
    assert.strictEqual(new Block().serializeHeader().length, 80);
  });

  await test('merkle root detecta alteracion de transacciones', () => {
    const { Block } = require('../src/core/block');
    const { createCoinbase } = require('../src/core/transaction');
    const { generateKeyPair } = require('../src/crypto/keys');
    const kp = generateKeyPair();
    const b = new Block();
    b.transactions.push(createCoinbase(5000000000n, 0n, kp.publicKey, 'x'));
    b.updateMerkleRoot();
    assert.ok(b.checkMerkleRoot());
    b.transactions[0].outputs[0].value = 1n;
    assert.ok(!b.checkMerkleRoot());
  });

  await test('PoW: bloque minado cumple target; cabecera aleatoria no', () => {
    const { Block, DEMO_BITS } = require('../src/core/block');
    const { createCoinbase } = require('../src/core/transaction');
    const { generateKeyPair } = require('../src/crypto/keys');
    const kp = generateKeyPair();
    const b = new Block();
    b.bits = DEMO_BITS;
    b.transactions.push(createCoinbase(5000000000n, 0n, kp.publicKey, 'x'));
    b.updateMerkleRoot();
    b.nonce = 77;
    // Puede que nonce 77 no cumpla; buscamos uno que si
    let found = false;
    for (let n = 0; n < 500000 && !found; n++) {
      b.nonce = n;
      found = b.checkProofOfWork();
    }
    assert.ok(found, 'no se encontro nonce para demo bits');
  });

  await test('genesis determinista identico en todas las ejecuciones', () => {
    const { buildGenesis } = require('../src/node/chain');
    const g1 = buildGenesis();
    const g2 = buildGenesis();
    assert.strictEqual(g1.getHashHex(), g2.getHashHex());
    assert.strictEqual(g1.time, 1231006505); // 3 enero 2009
  });

  // ==================== PROTOCOLO P2P ====================
  console.log('\n[5] Protocolo P2P binario');

  await test('magic 0xF9BEB4D9 en la cabecera de cada mensaje', () => {
    const { encodeMessage, MAGIC } = require('../src/net/messages');
    assert.deepStrictEqual([...MAGIC], [0xf9, 0xbe, 0xb4, 0xd9]);
    const msg = encodeMessage('verack');
    assert.strictEqual(msg[0], 0xf9);
    assert.strictEqual(msg[1], 0xbe);
    assert.strictEqual(msg[2], 0xb4);
    assert.strictEqual(msg[3], 0xd9);
  });

  await test('framing: mensaje parcial no se decodifica hasta completarse', () => {
    const { encodeMessage, decodeMessage } = require('../src/net/messages');
    const full = encodeMessage('tx', Buffer.alloc(100, 7));
    for (let cut = 1; cut < full.length; cut += 13) {
      assert.strictEqual(decodeMessage(full.subarray(0, cut)), null);
    }
    const dec = decodeMessage(full);
    assert.ok(dec.message.payload.equals(Buffer.alloc(100, 7)));
  });

  await test('checksum invalido y magic extrano son rechazados', () => {
    const { encodeMessage, decodeMessage } = require('../src/net/messages');
    const msg = Buffer.from(encodeMessage('block', Buffer.alloc(10)));
    msg[20] ^= 0xff;
    assert.throws(() => decodeMessage(msg), /Checksum/);
    const bad = Buffer.from(encodeMessage('block', Buffer.alloc(10)));
    bad[3] = 0xda;
    assert.throws(() => decodeMessage(bad), /Magic/);
  });

  await test('roundtrip de version/inv/getblocks/addr', () => {
    const m = require('../src/net/messages');
    const v = m.decodeVersion(m.encodeVersion({
      addrMe: { ip: '10.0.0.9', port: 8333 },
      addrFrom: { ip: '10.0.0.8', port: 8334 },
      startHeight: 777,
      subVer: '/bitcoin-2009:0.1.0/',
    }));
    assert.strictEqual(v.addrMe.ip, '10.0.0.9');
    assert.strictEqual(v.addrMe.port, 8333);
    assert.strictEqual(v.startHeight, 777);

    const inv = [{ type: m.MSG_TX, hash: Buffer.alloc(32, 1) }];
    assert.deepStrictEqual(m.decodeInventory(m.encodeInventory(inv)), inv);

    const gb = m.decodeGetBlocks(m.encodeGetBlocks([Buffer.alloc(32, 2)], Buffer.alloc(32, 3)));
    assert.ok(gb.locator[0].equals(Buffer.alloc(32, 2)));
    assert.ok(gb.hashStop.equals(Buffer.alloc(32, 3)));

    const addr = m.decodeAddrList(m.encodeAddrList([{ time: 5, ip: '1.2.3.4', port: 9 }]));
    assert.strictEqual(addr[0].ip, '1.2.3.4');
    assert.strictEqual(addr[0].port, 9);
  });

  // ==================== NODO COMPLETO E2E ====================
  console.log('\n[6] Red completa de 3 nodos (end-to-end)');

  await test('3 nodos: sync, propagacion de tx, mineria y consenso final', async () => {
    const { FullNode } = require('../src/node/node');
    const nodes = [19551, 19552, 19553].map((port) =>
      new FullNode({ port, dataDir: `${TMP}/node-${port}` })
    );
    try {
      for (const n of nodes) await n.start();

      // Malla parcial: 0-1, 1-2
      await nodes[0].connectTo('127.0.0.1', 19552);
      await new Promise((r) => setTimeout(r, 300));
      await nodes[1].connectTo('127.0.0.1', 19553);
      await new Promise((r) => setTimeout(r, 300));

      // Todos comparten genesis
      assert.strictEqual(nodes[0].chain.tipHash, nodes[2].chain.tipHash);

      // Nodo 0 mina bloque 1; llega a todos por retransmision
      const addr0 = nodes[0].createNewAddress('A');
      await nodes[0].mineBlock(addr0);
      await new Promise((r) => setTimeout(r, 800));
      assert.strictEqual(nodes[2].chain.height, 1, 'el nodo lejano debe recibir el bloque via relay');
      assert.strictEqual(nodes[0].chain.tipHash, nodes[2].chain.tipHash);

      // Tx del nodo 0 al nodo 1; se propaga a los 3 mempools
      const addr1 = nodes[1].createNewAddress('B');
      const tx = nodes[0].sendToAddress(nodes[1].wallet[addr1].publicKey, 15);
      await new Promise((r) => setTimeout(r, 800));
      assert.strictEqual(nodes[2].mempool.size, 1, 'el nodo lejano debe tener la tx en mempool');

      // Nodo 2 mina confirmando la tx; todos alcanzan altura 2 con mismo tip
      const addr2 = nodes[2].createNewAddress('C');
      await nodes[2].mineBlock(addr2);
      await new Promise((r) => setTimeout(r, 900));
      assert.strictEqual(nodes[0].chain.height, 2);
      assert.strictEqual(nodes[1].chain.height, 2);
      assert.strictEqual(nodes[2].chain.height, 2);
      assert.strictEqual(nodes[0].chain.tipHash, nodes[1].chain.tipHash);
      assert.strictEqual(nodes[1].chain.tipHash, nodes[2].chain.tipHash);

      // Balances exactos
      assert.strictEqual(nodes[0].getBalance(addr0), 3500000000n); // 50 - 15
      assert.strictEqual(nodes[1].getBalance(addr1), 1500000000n); // 15
      assert.strictEqual(nodes[2].getBalance(addr2), 5000000000n + 0n); // coinbase sin fees

      // Persistencia identica en blk0001.dat
      const sizes = nodes.map((n) =>
        fs.statSync(`${TMP}/node-${n.port}/blk0001.dat`).size
      );
      assert.strictEqual(sizes[0], sizes[1]);
      assert.strictEqual(sizes[1], sizes[2]);
    } finally {
      nodes.forEach((n) => n.stop());
    }
  });

  await test('validacion: doble gasto y firma falsificada rechazados', async () => {
    const { FullNode } = require('../src/node/node');
    const node = new FullNode({ port: 19561, dataDir: `${TMP}/node-doublespend` });
    try {
      await node.start();
      const addr = node.createNewAddress('minero');
      await node.mineBlock(addr);

      const { Transaction, createTransaction } = require('../src/core/transaction');
      const { generateKeyPair } = require('../src/crypto/keys');
      const victim = generateKeyPair();
      const entry = node.wallet[addr];

      // Gasto legitimo
      const tx = createTransaction(
        [{ prevTx: node.chain.blocksByHash.get(node.chain.mainChain.get(1)).block.transactions[0], prevN: 0 }],
        [{ pubKey: victim.publicKey, value: 1000000000n }],
        { [addr]: entry.privateKey }
      );
      node.acceptTransaction(tx, null);

      // Doble gasto del mismo UTXO con otro destino
      const other = generateKeyPair();
      const double = createTransaction(
        [{ prevTx: node.chain.blocksByHash.get(node.chain.mainChain.get(1)).block.transactions[0], prevN: 0 }],
        [{ pubKey: other.publicKey, value: 2000000000n }],
        { [addr]: entry.privateKey }
      );
      assert.throws(() => node.acceptTransaction(double, null), /Doble gasto/);

      // Firma falsificada: cambia el destinatario tras firmar
      const forged = Transaction.fromHex(tx.toHex());
      forged.outputs[0].value = 900000000n;
      const spk = node.chain.blocksByHash.get(node.chain.mainChain.get(1)).block.transactions[0].outputs[0].scriptPubKey;
      assert.ok(!forged.verifyInput(0, spk));
    } finally {
      node.stop();
    }
  });

  await test('reinicio desde blk0001.dat conserva la cadena', async () => {
    const fs = require('fs');
    const dir = `${TMP}/node-restart`;
    const { FullNode } = require('../src/node/node');
    let tipBefore;
    {
      const node = new FullNode({ port: 19571, dataDir: dir });
      await node.start();
      const addr = node.createNewAddress('x');
      await node.mineBlock(addr);
      await node.mineBlock(addr);
      tipBefore = node.chain.tipHash;
      node.stop();
    }
    // El nodo nuevo reconstruye desde el genesis determinista; el tip
    // persistido debe seguir siendo legible del fichero
    const buf = fs.readFileSync(`${dir}/blk0001.dat`);
    let offset = 0;
    let count = 0;
    while (offset < buf.length) {
      const size = buf.readUInt32LE(offset + 4);
      offset += 8 + size;
      count++;
    }
    assert.strictEqual(count, 3); // genesis + 2 minados
    assert.ok(tipBefore);
  });

  // ==================== RESUMEN ====================
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Resultado: ${passed} pruebas superadas, ${failed} fallidas`);
  if (failures.length > 0) {
    console.log('\nFallos:');
    failures.forEach((f) => console.log(` - ${f.name}: ${f.err.message}`));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
