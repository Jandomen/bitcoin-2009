'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const {
  encodeMessage,
  decodeMessage,
  encodeVersion,
  decodeVersion,
} = require('./messages');

const PROTOCOL_VERSION = 31900; // version de enero de 2010, compatible con la estructura original
const HANDSHAKE_TIMEOUT = 10000;

// Gestion de una conexion saliente o entrante
class Peer extends EventEmitter {
  constructor(socket, direction) {
    super();
    this.socket = socket;
    this.direction = direction; // 'outbound' | 'inbound'
    this.buffer = Buffer.alloc(0);
    this.handshaked = false;
    this.versionInfo = null;
    this.nonce = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this.emit('error', err));
    socket.on('close', () => this.emit('close'));
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      let decoded;
      try {
        decoded = decodeMessage(this.buffer);
      } catch (err) {
        this.emit('protocolError', err);
        this.socket.destroy();
        return;
      }
      if (!decoded) break;
      this.buffer = decoded.rest;
      const { command, payload } = decoded.message;

      if (command === 'version') {
        this.versionInfo = decodeVersion(payload);
        if (!this.handshaked && this.direction === 'inbound') {
          // El nodo entrante responde con su version
          this.emit('needVersion');
        } else if (!this.handshaked) {
          this.send('verack');
        }
      } else if (command === 'verack') {
        this.handshaked = true;
      }

      this.emit('message', { command, payload });
    }
  }

  send(command, payload = Buffer.alloc(0)) {
    if (this.socket.destroyed) return false;
    this.socket.write(encodeMessage(command, payload));
    return true;
  }

  sendVersion(params) {
    this.send('version', encodeVersion({
      version: PROTOCOL_VERSION,
      ...params,
    }));
  }

  disconnect() {
    this.socket.destroy();
  }
}

// Servidor TCP + cliente. Protocolo binario fiel.
class P2PNetwork extends EventEmitter {
  constructor({ listenPort, magicName }) {
    super();
    this.listenPort = listenPort;
    this.peers = new Set();
    this.server = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        const peer = new Peer(socket, 'inbound');
        peer.on('needVersion', () => this.emit('versionRequest', peer));
        this._attachPeer(peer);
        this.emit('peerConnected', peer);
      });
      this.server.once('error', reject);
      this.server.listen(this.listenPort, () => resolve());
    });
  }

  _attachPeer(peer) {
    this.peers.add(peer);
    peer.on('message', ({ command, payload }) => {
      this.emit('message', peer, command, payload);
    });
    peer.on('close', () => {
      this.peers.delete(peer);
      this.emit('peerDisconnected', peer);
    });
    peer.on('protocolError', (err) => this.emit('peerProtocolError', peer, err));
  }

  connect(ip, port) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: ip, port });
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timeout conectando a ${ip}:${port}`));
      }, HANDSHAKE_TIMEOUT);

      socket.once('connect', () => {
        clearTimeout(timeout);
        const peer = new Peer(socket, 'outbound');
        peer.on('needVersion', () => this.emit('versionRequest', peer));
        this._attachPeer(peer);
        this.emit('peerConnected', peer);
        resolve(peer);
      });
      socket.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  broadcast(command, payload, exclude = null) {
    for (const peer of this.peers) {
      if (peer !== exclude && peer.handshaked) {
        peer.send(command, payload);
      }
    }
  }

  get peerCount() {
    return [...this.peers.values()].filter((p) => p.handshaked).length;
  }

  stop() {
    for (const peer of this.peers) peer.disconnect();
    if (this.server) this.server.close();
  }
}

module.exports = { P2PNetwork, Peer, PROTOCOL_VERSION };
