// A stand-in MQTT server on localhost (plain TCP; the real one is LG's AWS IoT over TLS).
// It answers CONNECT, SUBSCRIBE and PINGREQ, records PUBACKs, and lets a test publish to clients.
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { PacketReader, packet } from '../src/mqtt';

export interface BrokerClient {
  socket: Socket;
  clientId: string;
  cleanSession: boolean;
  keepAlive: number;
  topics: string[];
}

export class FakeBroker {
  readonly clients: BrokerClient[] = [];
  readonly pubacks: number[] = [];
  pings = 0;
  /** CONNACK return code to answer with (0 = accepted). */
  connackCode = 0;
  /** Don't answer at all (to test timeouts). */
  silent = false;
  /** Refuse subscriptions (SUBACK 0x80). */
  refuseSubscribe = false;
  private server: Server | undefined;
  port = 0;
  private nextId = 1;

  async start(): Promise<this> {
    this.server = createServer((socket) => this.onClient(socket));
    await new Promise<void>((done) => this.server!.listen(0, '127.0.0.1', done));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  stop(): Promise<void> {
    this.clients.forEach((c) => c.socket.destroy());
    return new Promise((done) => this.server ? this.server.close(() => done()) : done());
  }

  /** Sends a message to every client subscribed to the topic. QoS 1 unless told otherwise. */
  publish(topic: string, payload: string | object, qos: 0 | 1 = 1): void {
    const t = Buffer.from(topic);
    const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    for (const c of this.clients.filter((x) => x.topics.includes(topic) && !x.socket.destroyed)) {
      const id = this.nextId++;
      const parts = [Buffer.from([t.length >> 8, t.length & 0xff]), t];
      if (qos) { parts.push(Buffer.from([id >> 8, id & 0xff])); }
      parts.push(body);
      c.socket.write(packet(3, qos << 1, Buffer.concat(parts)));
    }
  }

  /** Drops every connection, as a server going away would. */
  dropAll(): void {
    this.clients.forEach((c) => c.socket.destroy());
  }

  private onClient(socket: Socket): void {
    const reader = new PacketReader();
    let client: BrokerClient | undefined;
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      for (const p of reader.push(chunk)) {
        if (this.silent) { continue; }
        if (p.type === 1) {
          const nameLen = p.body.readUInt16BE(0);
          const flags = p.body[2 + nameLen + 1];
          const keepAlive = p.body.readUInt16BE(2 + nameLen + 2);
          const idLen = p.body.readUInt16BE(2 + nameLen + 4);
          const clientId = p.body.subarray(2 + nameLen + 6, 2 + nameLen + 6 + idLen).toString();
          client = { socket, clientId, cleanSession: (flags & 0x02) !== 0, keepAlive, topics: [] };
          this.clients.push(client);
          socket.write(packet(2, 0, Buffer.from([0, this.connackCode])));
        } else if (p.type === 8) {
          const id = p.body.readUInt16BE(0);
          const len = p.body.readUInt16BE(2);
          const topic = p.body.subarray(4, 4 + len).toString();
          if (!this.refuseSubscribe) { client?.topics.push(topic); }
          socket.write(packet(9, 0, Buffer.from([id >> 8, id & 0xff, this.refuseSubscribe ? 0x80 : 1])));
        } else if (p.type === 4) {
          this.pubacks.push(p.body.readUInt16BE(0));
        } else if (p.type === 12) {
          this.pings++;
          socket.write(packet(13, 0, Buffer.alloc(0)));
        } else if (p.type === 14) {
          socket.end();
        }
      }
    });
  }
}
