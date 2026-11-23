// A minimal MQTT 3.1.1 client: just what LG's live updates need. Connect, subscribe to one
// topic, receive messages (QoS 0 and 1, acknowledged), keep the connection alive, disconnect.
// No publishing, no retained or will messages, no reconnecting (the caller decides when).

import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';

const enum Type {
  CONNECT = 1, CONNACK = 2, PUBLISH = 3, PUBACK = 4, SUBSCRIBE = 8, SUBACK = 9,
  PINGREQ = 12, PINGRESP = 13, DISCONNECT = 14,
}

const CONNACK_ERRORS: Record<number, string> = {
  1: 'unacceptable protocol version', 2: 'client ID rejected', 3: 'server unavailable',
  4: 'bad user name or password', 5: 'not authorized',
};

function remainingLength(n: number): Buffer {
  const bytes: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) { b |= 0x80; }
    bytes.push(b);
  } while (n > 0);
  return Buffer.from(bytes);
}

const str = (s: string): Buffer => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([b.length >> 8, b.length & 0xff]), b]);
};

export function packet(type: number, flags: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), remainingLength(body.length), body]);
}

/** Splits a byte stream into MQTT packets. */
export class PacketReader {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): { type: number; flags: number; body: Buffer }[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: { type: number; flags: number; body: Buffer }[] = [];
    for (;;) {
      if (this.buf.length < 2) { break; }
      let len = 0;
      let mult = 1;
      let i = 1;
      let complete = false;
      for (; i < 5 && i < this.buf.length; i++) {
        len += (this.buf[i] & 0x7f) * mult;
        mult *= 128;
        if (!(this.buf[i] & 0x80)) { complete = true; break; }
      }
      if (!complete) {
        if (i >= 5) { throw new Error('malformed MQTT packet length'); }
        break;
      }
      const start = i + 1;
      if (this.buf.length < start + len) { break; }
      out.push({ type: this.buf[0] >> 4, flags: this.buf[0] & 0x0f, body: this.buf.subarray(start, start + len) });
      this.buf = this.buf.subarray(start + len);
    }
    return out;
  }
}

export interface MqttOptions {
  clientId: string;
  keepAliveSeconds?: number;
  cleanSession?: boolean;
  /** How long to wait for CONNACK, SUBACK and PINGRESP. */
  timeoutMs?: number;
}

/**
 * Events: 'message' (topic, payload Buffer), 'close' (Error | undefined: why, if not asked to).
 */
export class MqttClient extends EventEmitter {
  private readonly reader = new PacketReader();
  private nextId = 1;
  private pingTimer: NodeJS.Timeout | undefined;
  private pongTimer: NodeJS.Timeout | undefined;
  private waiting = new Map<string, { resolve: (body: Buffer) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  private closing = false;
  private readonly keepAlive: number;
  private readonly timeoutMs: number;

  constructor(private readonly socket: Duplex, private readonly options: MqttOptions) {
    super();
    this.keepAlive = options.keepAliveSeconds ?? 60;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err: Error) => this.shutdown(err));
    socket.on('close', () => this.shutdown(this.closing ? undefined : new Error('connection closed by the server')));
  }

  get connected(): boolean {
    return !this.closed;
  }

  /** Sends CONNECT and waits for the server to accept it. Resolves with "session present". */
  async connect(): Promise<boolean> {
    const flags = this.options.cleanSession === false ? 0x00 : 0x02;
    const body = Buffer.concat([str('MQTT'), Buffer.from([4, flags, this.keepAlive >> 8, this.keepAlive & 0xff]), str(this.options.clientId)]);
    const ack = this.expect('connack', () => this.write(packet(Type.CONNECT, 0, body)));
    const reply = await ack;
    const code = reply[1];
    if (code !== 0) {
      const err = new Error(`MQTT server refused the connection: ${CONNACK_ERRORS[code] || `code ${code}`}`);
      this.shutdown(err);
      throw err;
    }
    this.schedulePing();
    return (reply[0] & 0x01) === 1;
  }

  /** Subscribes to a topic at QoS 1 and waits for the server to grant it. */
  async subscribe(topic: string): Promise<void> {
    const id = this.packetId();
    const body = Buffer.concat([Buffer.from([id >> 8, id & 0xff]), str(topic), Buffer.from([1])]);
    const reply = await this.expect(`suback:${id}`, () => this.write(packet(Type.SUBSCRIBE, 0x02, body)));
    if (reply[2] === 0x80) { throw new Error(`MQTT server refused the subscription to ${topic}`); }
  }

  /** Disconnects politely. */
  end(): void {
    if (this.closed) { return; }
    this.closing = true;
    try { this.write(packet(Type.DISCONNECT, 0, Buffer.alloc(0))); } catch { /* already gone */ }
    this.socket.end();
    this.shutdown(undefined);
  }

  private packetId(): number {
    const id = this.nextId;
    this.nextId = this.nextId >= 0xffff ? 1 : this.nextId + 1;
    return id;
  }

  private write(data: Buffer): void {
    if (this.closed) { throw new Error('MQTT connection is closed'); }
    this.socket.write(data);
  }

  private expect(key: string, send: () => void): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(key);
        const err = new Error(`no ${key.split(':')[0].toUpperCase()} from the MQTT server within ${this.timeoutMs / 1000} s`);
        reject(err);
        this.shutdown(err);
      }, this.timeoutMs);
      this.waiting.set(key, { resolve, reject, timer });
      try { send(); } catch (err) { clearTimeout(timer); this.waiting.delete(key); reject(err as Error); }
    });
  }

  private settle(key: string, body: Buffer): void {
    const w = this.waiting.get(key);
    if (!w) { return; }
    clearTimeout(w.timer);
    this.waiting.delete(key);
    w.resolve(body);
  }

  private onData(chunk: Buffer): void {
    let packets: { type: number; flags: number; body: Buffer }[];
    try {
      packets = this.reader.push(chunk);
    } catch (err) {
      this.shutdown(err as Error);
      return;
    }
    for (const p of packets) {
      switch (p.type) {
        case Type.CONNACK: this.settle('connack', p.body); break;
        case Type.SUBACK: this.settle(`suback:${p.body.readUInt16BE(0)}`, p.body); break;
        case Type.PINGRESP: clearTimeout(this.pongTimer); break;
        case Type.PUBLISH: this.onPublish(p.flags, p.body); break;
        default: break;
      }
    }
  }

  private onPublish(flags: number, body: Buffer): void {
    const qos = (flags >> 1) & 0x03;
    const topicLen = body.readUInt16BE(0);
    const topic = body.subarray(2, 2 + topicLen).toString('utf8');
    let offset = 2 + topicLen;
    if (qos > 0) {
      const id = body.readUInt16BE(offset);
      offset += 2;
      // QoS 1: acknowledge so the server doesn't send it again. (LG doesn't use QoS 2.)
      try { this.write(packet(Type.PUBACK, 0, Buffer.from([id >> 8, id & 0xff]))); } catch { /* closing */ }
    }
    this.emit('message', topic, body.subarray(offset));
  }

  private schedulePing(): void {
    clearTimeout(this.pingTimer);
    if (!this.keepAlive) { return; }
    this.pingTimer = setTimeout(() => {
      if (this.closed) { return; }
      this.pongTimer = setTimeout(() => this.shutdown(new Error('no answer from the MQTT server to a keep-alive')), this.timeoutMs);
      this.pongTimer.unref?.();
      try { this.write(packet(Type.PINGREQ, 0, Buffer.alloc(0))); } catch { /* closing */ }
      this.schedulePing();
    }, this.keepAlive * 1000);
    this.pingTimer.unref?.();
  }

  private shutdown(err: Error | undefined): void {
    if (this.closed) { return; }
    this.closed = true;
    clearTimeout(this.pingTimer);
    clearTimeout(this.pongTimer);
    for (const [key, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(err || new Error('MQTT connection closed'));
      this.waiting.delete(key);
    }
    this.socket.destroy();
    this.emit('close', err);
  }
}
