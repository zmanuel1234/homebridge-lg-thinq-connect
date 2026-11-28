// A stand-in for LG's ThinQ Connect API on localhost, answering like the real one: the
// { messageId, timestamp, response } envelope, { error: { code, message } } failures, and the
// headers LG requires checked on every request.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fixturesJson from './fixtures/washer-dryer-diagnostics.json' with { type: 'json' };

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

export interface FakeDevice {
  deviceId: string;
  deviceInfo: Record<string, unknown>;
  profile: unknown;
  state: unknown;
}

/** Our washer and dryer as captured from LG on 23 Nov 2026, with made-up device IDs. */
export function realDevices(): FakeDevice[] {
  const list = fixturesJson as unknown as { deviceInfo: Record<string, unknown>; profile: unknown; state: unknown }[];
  return list.map((d, i) => ({ deviceId: `device-${i + 1}`, ...structuredClone(d) }));
}

export class FakeLG {
  readonly token = 'test-token';
  readonly requests: Recorded[] = [];
  devices: FakeDevice[] = realDevices();
  /** Energy figures per device ID: the property names LG keeps, and watt-hours this month. */
  energy: Record<string, { properties: string[]; wh: number }> = {};
  /** The energy usage queries received. */
  energyQueries: string[] = [];
  /** Requests to matching paths fail with HTTP 503. */
  failPath: RegExp | null = null;
  /** Set to answer the device list with this instead (an odd answer from LG). */
  listingOverride: unknown = undefined;
  /** Set to make the next requests fail: [HTTP status, LG code, message]. */
  failWith: [number, string, string] | null = null;
  /** The message server LG's route answer names. */
  mqttServer = 'ssl://example-ats.iot.us-west-2.amazonaws.com:8883';
  /** Certificates issued, and devices subscribed to events and alerts. */
  readonly certificates: string[] = [];
  readonly subscribed = { event: [] as string[], push: [] as string[] };
  private server: Server | undefined;
  url = '';

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString(); });
      req.on('end', () => {
        const path = (req.url || '').replace(/^\//, '');
        const body: unknown = raw ? JSON.parse(raw) : undefined;
        this.requests.push({ method: req.method || '', path, headers: req.headers, body });
        const [status, payload] = this.answer(req, path, body);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messageId: String(req.headers['x-message-id']), timestamp: new Date().toISOString(), ...payload }));
      });
    });
    await new Promise<void>((done) => this.server!.listen(0, '127.0.0.1', done));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((done) => this.server ? this.server.close(() => done()) : done());
  }

  private answer(req: IncomingMessage, path: string, body: unknown): [number, Record<string, unknown>] {
    if (this.failPath?.test(path)) { return [503, { error: { code: '', message: 'Service unavailable' } }]; }
    if (this.failWith) {
      const [status, code, message] = this.failWith;
      return [status, { error: { code, message } }];
    }
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      return [401, { error: { code: '1218', message: 'Invalid token' } }];
    }
    for (const h of ['x-country', 'x-message-id', 'x-client-id', 'x-api-key', 'x-service-phase']) {
      if (!req.headers[h]) { return [400, { error: { code: '1101', message: `Missing ${h}` } }]; }
    }
    if (path === 'route') {
      return [200, { response: { apiServer: 'https://api-aic.lgthinq.com', mqttServer: this.mqttServer } }];
    }
    if (path === 'client' && req.method === 'POST') {
      return [200, { response: {} }];
    }
    if (path === 'client/certificate' && req.method === 'POST') {
      const sent = (body as { csr?: unknown } | undefined)?.csr;
      const csr = typeof sent === 'string' ? sent : '';
      if (!csr.startsWith('-----BEGIN CERTIFICATE REQUEST-----')) { return [400, { error: { code: '1101', message: 'Bad CSR' } }]; }
      this.certificates.push(csr);
      return [200, { response: { result: { certificatePem: `CERT-${this.certificates.length}`, subscriptions: [`app/clients/${String(req.headers['x-client-id'])}/push`] } } }];
    }
    const sub = /^(event|push)\/([^/]+)\/subscribe$/.exec(path);
    if (sub && req.method === 'POST') {
      const list = this.subscribed[sub[1] as 'event' | 'push'];
      const id = decodeURIComponent(sub[2]);
      if (list.includes(id)) { return [400, { error: { code: '1207', message: 'Already subscribed push' } }]; }
      list.push(id);
      return [200, { response: {} }];
    }
    const energy = /^devices\/energy\/([^/?]+)\/(profile|usage)(?:\?(.*))?$/.exec(path);
    if (energy) {
      const e = this.energy[decodeURIComponent(energy[1])];
      if (!e) { return [400, { error: { code: '1219', message: 'Not supported model' } }]; }
      if (energy[2] === 'profile') { return [200, { response: { result: { property: e.properties } } }]; }
      this.energyQueries.push(energy[3] || '');
      const property = new URLSearchParams(energy[3] || '').get('property') || '';
      // Two data points, to check they're added up
      return [200, { response: { result: { dataList: [{ [property]: e.wh / 2 }, { [property]: e.wh / 2, other: 5 }] } } }];
    }
    if (path === 'devices') {
      if (this.listingOverride !== undefined) { return [200, { response: this.listingOverride }]; }
      return [200, { response: this.devices.map((d) => ({ deviceId: d.deviceId, deviceInfo: d.deviceInfo })) }];
    }
    const m = /^devices\/([^/]+)\/(profile|state|control)$/.exec(path);
    const device = m && this.devices.find((d) => d.deviceId === decodeURIComponent(m[1]));
    if (!m || !device) { return [404, { error: { code: '1222', message: 'Not found' } }]; }
    if (m[2] === 'profile') { return [200, { response: device.profile }]; }
    if (m[2] === 'state') { return [200, { response: device.state }]; }
    if (req.headers['x-conditional-control'] !== 'true') {
      return [400, { error: { code: '1101', message: 'Missing x-conditional-control' } }];
    }
    return [200, { response: { accepted: body !== undefined } }];
  }
}
