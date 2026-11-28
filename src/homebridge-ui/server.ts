import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import { checkToken, diagnostics } from './check.js';
import { isOldShape, migrateConfig } from '../configShape.js';

/** The plugin's settings page backend: checks a token and collects diagnostics, without saving anything. */
class SettingsServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/check', (body: { token?: unknown; country?: unknown } = {}) => checkToken(body.token, body.country));
    this.onRequest('/diagnostics', (body: { token?: unknown; country?: unknown } = {}) => diagnostics(body.token, body.country));
    // A 2.x config, in the 3.0 shape: the page shows it so, and Save writes it so
    this.onRequest('/migrate', (body: { config?: Record<string, unknown> } = {}) => {
      const config = body.config && typeof body.config === 'object' ? body.config : {};
      return { changed: isOldShape(config), config: migrateConfig(config) };
    });
    this.ready();
  }
}

(() => new SettingsServer())();
