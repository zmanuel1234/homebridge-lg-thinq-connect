import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { once } from 'node:events';
import { MqttClient, PacketReader, packet } from '../src/mqtt';
import { FakeBroker } from './fake-broker';

async function setup(t: { after(fn: () => unknown): void }, options: { keepAliveSeconds?: number; timeoutMs?: number } = {}) {
  const broker = await new FakeBroker().start();
  const socket = connect(broker.port, '127.0.0.1');
  const client = new MqttClient(socket, { clientId: 'test-client', cleanSession: false, ...options });
  t.after(async () => { client.end(); await broker.stop(); });
  return { broker, client };
}

test('packet reader: lengths over 127, packets split across chunks and joined in one', () => {
  const big = packet(3, 0, Buffer.alloc(300, 1));
  assert.deepEqual([...big.subarray(0, 3)], [0x30, 0xac, 0x02], '300 = 0xac 0x02');
  const r = new PacketReader();
  assert.deepEqual(r.push(big.subarray(0, 2)), []);
  assert.deepEqual(r.push(big.subarray(2, 100)), []);
  const both = Buffer.concat([big.subarray(100), packet(13, 0, Buffer.alloc(0))]);
  const out = r.push(both);
  assert.deepEqual(out.map((p) => [p.type, p.body.length]), [[3, 300], [13, 0]]);
  assert.throws(() => new PacketReader().push(Buffer.from([0x30, 0xff, 0xff, 0xff, 0xff, 0x01])), /malformed/);
});

test('connect: client ID, persistent session and keep-alive sent; subscribe granted', async (t) => {
  const { broker, client } = await setup(t, { keepAliveSeconds: 45 });
  assert.equal(await client.connect(), false);
  assert.deepEqual(broker.clients.map((c) => [c.clientId, c.cleanSession, c.keepAlive]), [['test-client', false, 45]]);
  await client.subscribe('app/clients/test-client/push');
  assert.deepEqual(broker.clients[0].topics, ['app/clients/test-client/push']);
});

test('messages: delivered with their topic, QoS 1 acknowledged', async (t) => {
  const { broker, client } = await setup(t);
  await client.connect();
  await client.subscribe('t');
  const got = once(client, 'message');
  broker.publish('t', { deviceId: 'd', pushType: 'DEVICE_STATUS' });
  const [topic, payload] = await got as [string, Buffer];
  assert.equal(topic, 't');
  assert.deepEqual(JSON.parse(payload.toString()), { deviceId: 'd', pushType: 'DEVICE_STATUS' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(broker.pubacks, [1]);
  const qos0 = once(client, 'message');
  broker.publish('t', 'plain', 0);
  assert.equal(((await qos0)[1] as Buffer).toString(), 'plain');
});

test('refusals: a rejected connection and a rejected subscription', async (t) => {
  const a = await setup(t);
  a.broker.connackCode = 5;
  await assert.rejects(a.client.connect(), /refused the connection: not authorized/);
  assert.equal(a.client.connected, false);
  const b = await setup(t);
  b.broker.refuseSubscribe = true;
  await b.client.connect();
  await assert.rejects(b.client.subscribe('t'), /refused the subscription to t/);
});

test('no answer: connecting times out and the connection closes with the reason', async (t) => {
  const { broker, client } = await setup(t, { timeoutMs: 50 });
  broker.silent = true;
  const closed = once(client, 'close');
  await assert.rejects(client.connect(), /no CONNACK from the MQTT server within 0.05 s/);
  assert.match(String((await closed)[0]), /no CONNACK/);
});

test('keep-alive: pings the server; the server going away closes with a reason', async (t) => {
  const { broker, client } = await setup(t, { keepAliveSeconds: 1 });
  await client.connect();
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(broker.pings >= 1);
  const closed = once(client, 'close');
  broker.dropAll();
  assert.match(String((await closed)[0]), /closed by the server/);
});

test('end: a polite disconnect closes without an error', async (t) => {
  const { client } = await setup(t);
  await client.connect();
  const closed = once(client, 'close');
  client.end();
  assert.equal((await closed)[0], undefined);
  assert.equal(client.connected, false);
});

test('a malformed packet closes the connection with the reason; a listener\'s error stays in the listener', async () => {
  const { Duplex } = await import('node:stream');
  const sock = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
  const m = new MqttClient(sock, { clientId: 'x', keepAliveSeconds: 0 });
  const closed = once(m, 'close');
  const connecting = m.connect();
  sock.push(packet(2, 0, Buffer.from([0, 0])));
  await connecting;
  // A listener that throws: the message after it still arrives
  const got: string[] = [];
  m.on('message', (_t: string, p: Buffer) => { got.push(p.toString()); if (got.length === 1) { throw new Error('listener bug'); } });
  sock.push(packet(3, 0, Buffer.from([0, 1, 0x41, 0x61])));
  sock.push(packet(3, 0, Buffer.from([0, 1, 0x41, 0x62])));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, ['a', 'b']);
  // QoS 1 without its packet number
  sock.push(packet(3, 2, Buffer.from([0, 1, 0x41])));
  const [err] = await closed as [Error];
  assert.match(err.message, /malformed packet/);
});
