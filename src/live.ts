// Live updates from LG: appliance state changes and alerts (cycle complete, error) pushed the
// moment they happen, instead of waiting for the next scheduled check.
//
// How LG does it (its documentation and toolkit, and Home Assistant's integration): register
// this client, have LG sign a certificate for a key made here, connect to LG's MQTT server
// (AWS IoT) with that certificate, subscribe to the topic LG names, and subscribe each appliance
// to state events and alerts. Messages are JSON: { deviceId, pushType: 'DEVICE_STATUS' with a
// partial state in `report`, or 'DEVICE_PUSH' with an alert in `pushCode` }.
//
// The key and certificate are saved in Homebridge's storage folder, readable only by Homebridge's
// user, so a restart reconnects without asking LG for a new certificate.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import type { Duplex } from 'node:stream';
import type { Logging } from 'homebridge';
import { field, type ThinQClient } from './api';
import { newIdentity as makeIdentity, type Identity } from './csr';
import { MqttClient } from './mqtt';

export type LiveClient = Pick<ThinQClient, 'messageServer' | 'registerClient' | 'issueCertificate' | 'subscribeEvents' | 'subscribePush'>;

export interface Credentials {
  privateKeyPem: string;
  certificatePem: string;
  topic: string;
}

export type ConnectFn = (server: { host: string; port: number }, creds: Credentials) => Duplex;

export interface LiveMessage {
  deviceId: string;
  pushType: string;
  report?: unknown;
  pushCode?: string;
}

export interface LiveOptions {
  client: LiveClient;
  /** The same x-client-id the API requests use: LG ties the certificate to it. */
  clientId: string;
  log: Logging;
  /** Where the key, certificate and topic are kept between restarts. */
  storageFile: string;
  onMessage(message: LiveMessage): void;
  onConnected(connected: boolean): void;
  /** For tests: how to open the connection (default TLS with the certificate). */
  connect?: ConnectFn;
  newIdentity?: () => Identity;
  keepAliveSeconds?: number;
}

/** Waits between attempts after a failure or a dropped connection, in seconds. */
const RETRY = [10, 30, 60, 300, 900];
/** Failed connections in a row before getting a new certificate. */
const NEW_CERT_AFTER = 3;
/** Event subscriptions are renewed daily, as Home Assistant does (LG lets them expire). */
const RENEW_MS = 24 * 3600 * 1000;

export const defaultConnect: ConnectFn = (server, creds) => tlsConnect({
  host: server.host,
  port: server.port,
  servername: server.host,
  key: creds.privateKeyPem,
  cert: creds.certificatePem,
});

export class LiveUpdates {
  private mqtt: MqttClient | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private renewTimer: NodeJS.Timeout | undefined;
  private failures = 0;
  private stopped = false;
  private deviceIds: string[] = [];
  connected = false;

  constructor(private readonly o: LiveOptions) {}

  /** Starts connecting; failures are logged and retried, never thrown. */
  start(deviceIds: string[]): Promise<void> {
    this.deviceIds = deviceIds;
    this.stopped = false;
    this.renewTimer = setInterval(() => { void this.subscribeDevices(true); }, RENEW_MS);
    this.renewTimer.unref?.();
    return this.attempt();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.renewTimer);
    this.mqtt?.end();
    this.mqtt = undefined;
    this.setConnected(false);
  }

  private async attempt(): Promise<void> {
    if (this.stopped) { return; }
    let stage = 'asking LG for its message server';
    try {
      const server = await this.o.client.messageServer();
      stage = 'getting a certificate from LG';
      const creds = await this.credentials();
      stage = 'subscribing the appliances';
      await this.subscribeDevices(false);
      stage = `connecting to ${server.host}`;
      const socket = (this.o.connect || defaultConnect)(server, creds);
      const mqtt = new MqttClient(socket, { clientId: this.o.clientId, cleanSession: false, keepAliveSeconds: this.o.keepAliveSeconds ?? 60 });
      mqtt.on('message', (_topic: string, payload: Buffer) => this.onPayload(payload));
      mqtt.on('close', (err?: Error) => this.onClose(mqtt, err));
      this.mqtt = mqtt;
      await mqtt.connect();
      stage = 'subscribing to LG\'s topic';
      await mqtt.subscribe(creds.topic);
      if (this.stopped) { mqtt.end(); return; }
      this.failures = 0;
      this.setConnected(true);
      this.o.log.info('Live updates from LG connected: changes show in the Home app within seconds.');
    } catch (err) {
      this.mqtt?.end();
      this.mqtt = undefined;
      this.fail(`Live updates from LG failed while ${stage}: ${(err as Error).message}`);
    }
  }

  private fail(message: string): void {
    if (this.stopped) { return; }
    this.failures++;
    if (this.failures === NEW_CERT_AFTER) {
      // A certificate LG no longer accepts looks like a failed connection: start over with a new one
      rmSync(this.o.storageFile, { force: true });
    }
    const wait = RETRY[Math.min(this.failures - 1, RETRY.length - 1)];
    const msg = `${message} Checking on a schedule meanwhile; trying again in ${wait < 60 ? `${wait} s` : `${wait / 60} min`}.`;
    if (this.failures <= 2) { this.o.log.warn(msg); } else { this.o.log.debug(msg); }
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { void this.attempt(); }, wait * 1000);
    this.retryTimer.unref?.();
  }

  private onClose(mqtt: MqttClient, err: Error | undefined): void {
    if (this.mqtt !== mqtt) { return; } // an attempt that already failed
    this.mqtt = undefined;
    const was = this.connected;
    this.setConnected(false);
    if (this.stopped) { return; }
    if (was) {
      this.fail(`Live updates from LG disconnected${err ? ` (${err.message})` : ''}.`);
    }
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) { return; }
    this.connected = value;
    this.o.onConnected(value);
  }

  private onPayload(payload: Buffer): void {
    let json: unknown;
    try {
      json = JSON.parse(payload.toString('utf8'));
    } catch {
      this.o.log.debug(`Live update that isn't JSON, ignored: ${payload.toString('utf8').slice(0, 200)}`);
      return;
    }
    const deviceId = field(json, 'deviceId');
    const pushType = field(json, 'pushType');
    if (typeof deviceId !== 'string' || typeof pushType !== 'string') {
      this.o.log.debug(`Live update without a device or type, ignored: ${JSON.stringify(json).slice(0, 200)}`);
      return;
    }
    const pushCode = field(json, 'pushCode');
    this.o.onMessage({ deviceId, pushType, report: field(json, 'report'), pushCode: typeof pushCode === 'string' ? pushCode : undefined });
  }

  /** Subscribes every appliance to state events and alerts. Failures are logged, not thrown. */
  private async subscribeDevices(renewal: boolean): Promise<void> {
    for (const id of this.deviceIds) {
      for (const [what, call] of [['state changes', this.o.client.subscribeEvents], ['alerts', this.o.client.subscribePush]] as const) {
        if (renewal && what === 'alerts') { continue; } // alerts don't expire
        try {
          await call.call(this.o.client, id);
        } catch (err) {
          this.o.log.warn(`Couldn't subscribe an appliance to live ${what}: ${(err as Error).message}`);
        }
      }
    }
  }

  /** The saved key and certificate, or new ones from LG. */
  private async credentials(): Promise<Credentials> {
    await this.o.client.registerClient();
    const saved = this.load();
    if (saved) { return saved; }
    const identity = (this.o.newIdentity || makeIdentity)();
    const { certificatePem, topic } = await this.o.client.issueCertificate(identity.csrPem);
    const creds: Credentials = { privateKeyPem: identity.privateKeyPem, certificatePem, topic };
    this.save(creds);
    return creds;
  }

  private load(): Credentials | undefined {
    if (!existsSync(this.o.storageFile)) { return undefined; }
    try {
      const data = JSON.parse(readFileSync(this.o.storageFile, 'utf8')) as unknown;
      const c = { privateKeyPem: field(data, 'privateKeyPem'), certificatePem: field(data, 'certificatePem'), topic: field(data, 'topic') };
      if (typeof c.privateKeyPem === 'string' && typeof c.certificatePem === 'string' && typeof c.topic === 'string') {
        return c as Credentials;
      }
    } catch { /* unreadable: replaced below */ }
    return undefined;
  }

  private save(creds: Credentials): void {
    try {
      mkdirSync(dirname(this.o.storageFile), { recursive: true, mode: 0o700 });
      writeFileSync(this.o.storageFile, JSON.stringify(creds), { mode: 0o600 });
      chmodSync(this.o.storageFile, 0o600);
    } catch (err) {
      this.o.log.warn(`Couldn't save the live-update certificate (a new one will be fetched next start): ${(err as Error).message}`);
    }
  }
}
