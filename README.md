# ₿ bitcoin-2009

> 🕰️ **Viaja al 3 de enero de 2009** y ejecuta Bitcoin tal como nació: pay-to-pubkey,
> bloques de 80 bytes, PoW SHA-256d y el protocolo P2P binario original con magic `0xF9BEB4D9`.
>
> 📦 **Cero dependencias** — solo Node.js puro (ECDSA secp256k1 implementado desde cero).

---

## ✨ ¿Qué reproduce del original?

| 🧩 Elemento | 📜 Implementación |
|---|---|
| 🏠 Direcciones | Base58Check, versión `0x00` → empiezan por `1` |
| 💸 Transacciones | pay-to-pubkey con script simplificado (`<sig> <pubkey> OP_CHECKSIG`) |
| 🧱 Bloques | cabecera de exactamente **80 bytes**: version · prev · merkle · time · nBits · nonce |
| ⛏️ PoW | SHA-256d sobre la cabecera contra el target compacto (nBits) |
| 🪙 Subsidio | **50 BTC**, halving cada 210.000 bloques → máx. real **20.999.999,9769 BTC** |
| 📖 Génesis | determinista, con *"The Times 03/Jan/2009 Chancellor on brink of second bailout for banks"* y timestamp real `1231006505` |
| 🌐 Red P2P | binaria: `version` · `verack` · `inv` · `getdata` · `getblocks` · `tx` · `block` · `addr` |
| 💾 Persistencia | `blk0001.dat` en formato red: `[magic][tamaño][bloque]` |

⚠️ *Diferencias conscientes*: ECDSA en JS puro (BigInt) en vez de OpenSSL, checksum en los
mensajes P2P (llegó en la v31402 de 2010) y dificultad minera ajustable para que la demo sea ágil.
Proyecto **educativo** — no uses estas monedas para nada serio 😄

---

## 📋 Requisitos

| ✅ Necesitas | 📝 Detalle |
|---|---|
| 🟢 **Node.js ≥ 18** | Única dependencia real. Compruébalo con `node --version` |
| 💻 macOS · Linux · Windows | Funciona en cualquier sistema donde corra Node |
| 🌐 Puertos libres | Cada nodo usa un puerto TCP propio (por defecto `19001`, `19002`...) |
| 📦 Nada más | **Sin `npm install`**: cero paquetes externos, todo es JS puro |

### 🛠️ Cómo empezar

```bash
# 1️⃣ Consigue el proyecto (clona o descarga la carpeta)
git clone <este-repo> && cd bitcoin-2009

# 2️⃣ Verifica tu Node (≥ 18)
node --version

# 3️⃣ ¡Listo! No hace falta instalar nada 🎉
npm run demo
```

> 💡 Si tu Node es antiguo (< 18): instálalo desde [nodejs.org](https://nodejs.org)
> o con `brew install node` (macOS) / `apt install nodejs` (Debian/Ubuntu).

---

## 🚀 Inicio rápido

```bash
npm run demo     # 🎬 demo automática con 3 nodos
npm test         # 🧪 suite completa: 21 pruebas end-to-end
```

---

## 🎬 Demo automática

```bash
npm run demo
```

La demo recrea la historia en 6 actos:

1. 🟢 Tres nodos arrancan con el mismo génesis del 3/enero/2009
2. 🤝 Se conectan por P2P (`version → verack → getblocks`)
3. ⛏️ **Satoshi mina el bloque 1** → los otros lo reciben retransmitido
4. 💸 **Satoshi envía 10 BTC a Hal Finney** (como el 12/enero/2009, la primera tx de la historia)
5. 🟣 **Hal mina el bloque 2** confirmando la transacción
6. 💾 Los tres escriben un `blk0001.dat` idéntico byte a byte

---

## 💻 Manual: levanta tu propia red

Abre **dos o más terminales** y arranca un nodo en cada una:

```bash
# Terminal 1 — el nodo de Satoshi
node bin/bitcoin2009.js --port 19001

# Terminal 2 — el nodo de Hal, conectado al primero
node bin/bitcoin2009.js --port 19002 --connect 127.0.0.1:19001
```

🎛️ Opciones disponibles:

| Flag | Descripción |
|---|---|
| `--port, -p <n>` | Puerto P2P de escucha (por defecto `19001`) |
| `--datadir, -d <ruta>` | Carpeta donde vive tu `blk0001.dat` |
| `--connect, -c ip:puerto` | Conecta a un peer al arrancar (repetible) |
| `--automine` | Mina automáticamente cuando haya transacciones pendientes |

Dentro de cada nodo escribe `help` para ver todos los comandos.

---

## 👛 Paso 1 · Crea tu wallet

```
getnewaddress Satoshi
→ 1MNuSynvRRLrKAGtoriW4mWJMgbB9P1wK6 (Satoshi)

listaddresses          # 📋 tus direcciones y saldos
dumpwallet             # 🔑 exporta las claves privadas en WIF (¡guárdalas!)
```

Como en 2009, cada dirección tiene su clave pública asociada:

```
getpubkey 1MNuSynvRRLrKAGtoriW4mWJMgbB9P1wK6
→ 04f4e3c1...   # 🔍 necesaria para pagarte (pay-to-pubkey puro)
```

---

## ⛏️ Paso 2 · Minera monedas nuevas

Los bitcoins nuevos **nacen de la coinbase** del bloque que tú minas:

```
mine           # ⛏️ mina 1 bloque (50 BTC para ti + fees)
mine 10        # 💪 mina 10 bloques seguidos
```

Salida típica:

```
[minado] bloque 0000d7f5ebeec83dcf02... en 57ms
Minados 1 bloques. Altura actual: 1
```

💡 Arranca con `--automine` y tu nodo minará solo cada vez que llegue una transacción,
igual que hacían los mineros de 2009 mientras chateaban en el foro.

---

## 💸 Paso 3 · Envía bitcoins

```
sendtoaddress <destino> <cantidad>
```

El destino puede ser:

- 🏠 Una **dirección registrada en tu wallet** (propia o importada)
- 🔑 La **clave pública en hex** del destinatario (estilo pay-to-pubkey de 2009)

### 🧪 Ejemplo completo entre dos nodos

```bash
# ── En el nodo de HAL (terminal 2) ──
getnewaddress Hal Finney
→ 1HjgthFYZ81PYUJ3ASNLopCbkGFvcnhVMC
getpubkey 1HjgthFYZ81PYUJ3ASNLopCbkGFvcnhVMC
→ 04a19c8d...      # 📋 cópiala y pásasela a Satoshi (en 2009 era por email 😉)

# ── En el nodo de SATOSHI (terminal 1) ──
sendtoaddress 04a19c8d... 10
→ Enviado. txid: cd5261fd6674821e02cb19171a529be7f890baf0854a949a9f487bb665df155b
```

📡 La transacción entra en tu mempool y **se retransmite por toda la red**
(`inv → getdata → tx`). Cuando alguien mina, queda confirmada:

```
# ── En cualquier nodo ──
mine            # ⛏️ confirma las transacciones pendientes
```

---

## 🔍 Paso 4 · Explora la cadena

```
getbalance                  # 💰 saldo total del wallet
getbalance 1Hjgth...        # 💰 saldo de una dirección concreta
getblockcount               # 📏 altura de la cadena
getblock 2                  # 🧱 detalles del bloque 2 (hash, merkle, nonce, txs...)
getblock 0000d7f5ebeec83d   # 🧱 ...o búscalo por hash
getrawtransaction <txid>    # 📄 la transacción en hexadecimal crudo
getmempoolinfo              # ⏳ transacciones esperando confirmación
getinfo                     # ℹ️ resumen completo del nodo
peers                       # 🌐 quién está conectado a ti
```

---

## 🌐 Cómo funciona la red

```
┌──────────┐   version/verack   ┌──────────┐
│  NODO 1  │◄──────────────────►│  NODO 2  │
│ :19001   │                    │ :19002   │
└──────────┘                    └────┬─────┘
     ▲                               │ version/verack
     │        ┌──────────┐           │
     └────────┤  NODO 3  ├───────────┘
              │ :19003   │
              └──────────┘
```

- 🤝 Al conectarse: `version` → `verack` → `getblocks` (sincroniza lo que le falte)
- 📣 Nueva tx o bloque: se anuncia con `inv`; quien no lo tenga pide `getdata`
- 🧭 Un nodo nuevo se pone al día con `getblocks` usando localizador de hashes
- ✅ Todos los nodos validan todo: PoW, Merkle, firmas ECDSA, doble gasto y subsidio exacto

---

## 🧪 Pruebas

```bash
npm test
```

21 pruebas que cubren criptografía (vectores oficiales de Bitcoin), consenso de los
21 millones, transacciones, bloques, protocolo binario y una red completa de 3 nodos
sincronizada con balances exactos. ✅

---

## 📁 Estructura

```
src/
├── crypto/        🔐 secp256k1.js · base58.js · hash.js · keys.js
├── core/          🧱 transaction.js · block.js · script.js · consensus.js
├── net/           🌐 messages.js (codec binario) · p2p.js (TCP + framing)
├── node/          🖥️ chain.js (UTXO, validación) · node.js (mempool, relay, minería)
├── cli.js         ⌨️ REPL interactivo por nodo
└── demo.js        🎬 enero de 2009, otra vez
```

---

<div align="center">

₿ *Chancellor on brink of second bailout for banks* — 03/Jan/2009

</div>
