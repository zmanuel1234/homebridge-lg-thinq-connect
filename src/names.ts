// Display names for an appliance's tiles and sensors: the appliance's own name (as in the ThinQ
// app, unchanged), then what the tile is, in title case: "Front Load Washer Remote Start".

/** "remote start" → "Remote Start"; words already capitalized (UV) stay as they are. */
export function titleCase(words: string): string {
  return words.split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

/** The appliance's name, then the rest of `name` in title case. */
export function displayName(appliance: string, name: string): string {
  if (!name.startsWith(`${appliance} `)) { return name; }
  return `${appliance} ${titleCase(name.slice(appliance.length + 1))}`;
}

/**
 * The name to show now, given the one the Home app has: ours on first use; then the Home app's,
 * unless it's only an earlier default of ours (the 1.0.x lower-case one, or one of `previous`),
 * which is brought up to date.
 */
export function keepOrUpdate(current: unknown, name: string, previous: string[] = []): string | undefined {
  if (typeof current !== 'string' || !current) { return name; }
  if (current === name) { return undefined; }
  const was = current.toLowerCase();
  if (was === name.toLowerCase() || previous.some((p) => p.toLowerCase() === was)) { return name; }
  return undefined;
}
