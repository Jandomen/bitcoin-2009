#!/usr/bin/env node
'use strict';

const { startCLI } = require('../src/cli');

function parseArgs(argv) {
  const options = {
    port: 19001,
    dataDir: null,
    connect: [],
    autoMine: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      options.port = parseInt(argv[++i], 10);
    } else if (arg === '--datadir' || arg === '-d') {
      options.dataDir = argv[++i];
    } else if (arg === '--connect' || arg === '-c') {
      options.connect.push(argv[++i]);
    } else if (arg === '--automine') {
      options.autoMine = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Uso: bitcoin2009 [opciones]

Opciones:
  --port, -p <n>        Puerto de escucha P2P (defecto: 19001)
  --datadir, -d <ruta>  Directorio de datos con blk0001.dat
  --connect, -c ip:port Conecta a un peer al arrancar (repetible)
  --automine            Mina automaticamente al haber transacciones
  --help, -h            Muestra esta ayuda`);
      process.exit(0);
    }
  }
  if (!options.dataDir) {
    options.dataDir = `./data/node-${options.port}`;
  }
  return options;
}

const options = parseArgs(process.argv);
console.log('=== bitcoin-2009 ===');
console.log(`Nodo en puerto ${options.port} | datos: ${options.dataDir}`);
console.log("Escribe 'help' para ver los comandos.\n");

const { node } = startCLI(options);

(async () => {
  await node.start();
  for (const target of options.connect) {
    const [ip, port] = target.split(':');
    try {
      await node.connectTo(ip, parseInt(port, 10));
      console.log(`Conectado a ${target}`);
    } catch (err) {
      console.log(`No se pudo conectar a ${target}: ${err.message}`);
    }
  }
})();
