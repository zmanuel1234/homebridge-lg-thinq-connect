#!/usr/bin/env node
// lg-thinq-diagnostics: prints what LG's API says about each appliance on an account (its profile
// and current state), with device IDs and serial numbers removed, to attach to an issue.
//
//   lg-thinq-diagnostics [--country US] [--out FILE]
//
// The report goes to the screen (standard output) unless --out names a file, so the command never
// writes anywhere on its own; prompts and messages go to standard error, so the output is clean
// JSON when redirected. The token is read from the LG_THINQ_TOKEN environment variable, or asked
// for without showing it.

import { realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { ThinQClient, asText, field } from '../api.js';
import { fileURLToPath } from 'node:url';

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
      if (!muted) { process.stderr.write(chunk); }
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((done) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stderr.write('\n');
      done(answer.trim());
    });
    muted = true;
  });
}

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: lg-thinq-diagnostics [--country US] [--out FILE]\n'
      + 'Prints what LG reports about each appliance, with IDs removed, to attach to an issue;\n'
      + 'with --out, saves it to FILE instead. The token comes from LG_THINQ_TOKEN, or is asked\n'
      + 'for without being shown.');
    return;
  }
  const country = arg('country', 'US');
  const outArg = arg('out');
  const out = outArg ? resolve(outArg) : '';
  const token = process.env.LG_THINQ_TOKEN?.trim() || await askHidden('LG personal access token (not shown): ');
  const client = new ThinQClient({ token, country });
  const pkg = createRequire(import.meta.url)('../../package.json') as { name: string; version: string };
  const report = await collect(client, country.toUpperCase(), `${pkg.name} ${pkg.version}`);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (out) { writeFileSync(out, json); } else { process.stdout.write(json); }
  for (const a of report.appliances) {
    const info = field(a, 'deviceInfo');
    console.error(`- ${asText(field(info, 'alias'))}: ${asText(field(info, 'deviceType'))} ${asText(field(info, 'modelName'))}`);
  }
  console.error(out
    ? `Saved ${report.appliances.length} appliance(s) to ${out}. Look it over, then attach it to your issue.`
    : `${report.appliances.length} appliance(s) above. Look it over, then paste it into your issue.`);
}

/** Whether Node was started on this file (directly, through npm's bin link, or without the .js). */
function startedAsCommand(): boolean {
  const self = realpathSync(fileURLToPath(import.meta.url));
  const given = process.argv[1];
  if (!given) { return false; }
  return [given, `${given}.js`].some((p) => {
    try { return realpathSync(p) === self; } catch { return false; }
  });
}

if (startedAsCommand()) {
  main().catch((err: unknown) => {
    console.error(`lg-thinq-diagnostics: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
