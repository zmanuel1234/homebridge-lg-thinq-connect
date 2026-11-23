#!/usr/bin/env node
// lg-thinq-diagnostics: saves what LG's API says about each appliance on an account (its profile
// and current state) to a file, with device IDs and serial numbers removed, to attach to an issue.
//
//   lg-thinq-diagnostics [--country US] [--out lg-diagnostics.json]
//
// The token is read from the LG_THINQ_TOKEN environment variable, or asked for without showing it.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { ThinQClient, field } from '../api';

/** Keys whose values identify the appliance or the home network, whatever their spelling or type. */
const PRIVATE_KEY = /serial|^mac(addr(ess)?)?$|ssid|wifi|deviceid|groupid/i;

/** Removes device IDs, serials, MAC addresses and network names from LG's answers. */
export function redact(value: unknown, deviceIds: string[]): unknown {
  const ids = deviceIds.filter((id) => id.length > 0);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let out = v;
      for (const id of ids) { out = out.split(id).join('DEVICE-ID-REMOVED'); }
      return out;
    }
    if (Array.isArray(v)) { return v.map(walk); }
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [walk(k) as string,
        PRIVATE_KEY.test(k) && x !== null && typeof x !== 'object' ? 'REMOVED' : walk(x)]));
    }
    return v;
  };
  return walk(value);
}

export interface Report {
  tool: string;
  createdAt: string;
  country: string;
  appliances: unknown[];
}

/** Everything LG says about each appliance on the account, redacted. */
export async function collect(client: Pick<ThinQClient, 'devices' | 'profile' | 'state'>, country: string, tool: string): Promise<Report> {
  const devices = await client.devices();
  const appliances: unknown[] = [];
  for (const d of devices) {
    const entry: Record<string, unknown> = { deviceInfo: d.deviceInfo };
    for (const [key, get] of [['profile', client.profile], ['state', client.state]] as const) {
      try {
        entry[key] = await get.call(client, d.deviceId);
      } catch (err) {
        entry[key] = { error: (err as Error).message };
      }
    }
    appliances.push(entry);
  }
  return {
    tool,
    createdAt: new Date().toISOString(),
    country,
    appliances: redact(appliances, devices.map((d) => d.deviceId)) as unknown[],
  };
}

function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _enc, done) {
      if (!muted) { process.stdout.write(chunk); }
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((done) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      done(answer.trim());
    });
    muted = true;
  });
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: lg-thinq-diagnostics [--country US] [--out lg-diagnostics.json]\n'
      + 'Saves what LG reports about each appliance, with IDs removed, to attach to an issue.\n'
      + 'The token comes from LG_THINQ_TOKEN, or is asked for without being shown.');
    return;
  }
  const country = arg('country', 'US');
  const out = resolve(arg('out', 'lg-diagnostics.json'));
  const token = process.env.LG_THINQ_TOKEN?.trim() || await askHidden('LG personal access token (not shown): ');
  const client = new ThinQClient({ token, country });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkg = require('../../package.json') as { name: string; version: string };
  const report = await collect(client, country.toUpperCase(), `${pkg.name} ${pkg.version}`);
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  for (const a of report.appliances) {
    const info = field(a, 'deviceInfo');
    console.log(`- ${String(field(info, 'alias'))}: ${String(field(info, 'deviceType'))} ${String(field(info, 'modelName') ?? '')}`);
  }
  console.log(`Saved ${report.appliances.length} appliance(s) to ${out}. Look it over, then attach it to your issue.`);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(`lg-thinq-diagnostics: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
