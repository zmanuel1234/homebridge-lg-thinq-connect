import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import { checkToken, diagnostics } from './check';

/** The plugin's settings page backend: checks a token and collects diagnostics, without saving anything. */
class SettingsServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/check', (body: { token?: unknown; country?: unknown } = {}) => checkToken(body.token, body.country));
    this.onRequest('/diagnostics', (body: { token?: unknown; country?: unknown } = {}) => diagnostics(body.token, body.country));
    this.ready();
  }
}

(() => new SettingsServer())();
