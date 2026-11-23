import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newIdentity } from '../src/csr';

let openssl = '';
try { openssl = execFileSync('openssl', ['version']).toString().trim(); } catch { /* not installed */ }

test('a 2048-bit RSA key in PEM, and a request in PEM', () => {
  const id = newIdentity();
  assert.match(id.privateKeyPem, /^-----BEGIN PRIVATE KEY-----\n/);
  assert.equal(createPublicKey(id.privateKeyPem).asymmetricKeyDetails?.modulusLength, 2048);
  assert.match(id.csrPem, /^-----BEGIN CERTIFICATE REQUEST-----\n([A-Za-z0-9+/=]{1,64}\n)+-----END CERTIFICATE REQUEST-----\n$/);
});

test('OpenSSL accepts the request: valid signature, CN=lg_thinq, the key\'s public half', { skip: openssl ? false : 'openssl not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'lg-csr-'));
  const id = newIdentity();
  writeFileSync(join(dir, 'r.csr'), id.csrPem);
  const out = execFileSync('openssl', ['req', '-in', join(dir, 'r.csr'), '-noout', '-verify', '-subject'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  assert.match(out, /CN\s*=\s*lg_thinq/);
  const pub = execFileSync('openssl', ['req', '-in', join(dir, 'r.csr'), '-noout', '-pubkey']).toString();
  assert.equal(createPublicKey(pub).export({ type: 'spki', format: 'pem' }), createPublicKey(id.privateKeyPem).export({ type: 'spki', format: 'pem' }));
});
