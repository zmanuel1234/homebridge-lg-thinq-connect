// A key pair and a certificate signing request (PKCS #10) for LG's live updates.
//
// LG signs the request and returns a certificate; with it and the private key the plugin connects
// to LG's message server (AWS IoT) over TLS. Node can make keys and signatures but not requests,
// so the request is assembled here in DER: the few ASN.1 structures it needs, nothing general.

import { generateKeyPairSync, sign } from 'node:crypto';

/** DER length octets. */
function length(n: number): Buffer {
  if (n < 0x80) { return Buffer.from([n]); }
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) { bytes.unshift(v % 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...c: Buffer[]) => tlv(0x30, ...c);
const set = (...c: Buffer[]) => tlv(0x31, ...c);

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [a * 40 + b];
  for (const part of rest) {
    const chunk = [part & 0x7f];
    for (let v = part >>> 7; v > 0; v >>>= 7) { chunk.unshift((v & 0x7f) | 0x80); }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const COMMON_NAME = '2.5.4.3';
const SHA256_WITH_RSA = '1.2.840.113549.1.1.11';

function pem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export interface Identity {
  privateKeyPem: string;
  csrPem: string;
}

/** A new 2048-bit RSA key and a request for a certificate with the common name LG's toolkit uses. */
export function newIdentity(commonName = 'lg_thinq'): Identity {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const info = sequence(
    tlv(0x02, Buffer.from([0])), // version 1
    sequence(set(sequence(oid(COMMON_NAME), tlv(0x0c, Buffer.from(commonName, 'utf8'))))), // subject
    publicKey, // SubjectPublicKeyInfo, already DER
    Buffer.from([0xa0, 0x00]), // no attributes
  );
  const signature = sign('sha256', info, privateKey);
  const request = sequence(
    info,
    sequence(oid(SHA256_WITH_RSA), Buffer.from([0x05, 0x00])),
    tlv(0x03, Buffer.from([0]), signature), // BIT STRING, no unused bits
  );
  return { privateKeyPem: privateKey, csrPem: pem('CERTIFICATE REQUEST', request) };
}
