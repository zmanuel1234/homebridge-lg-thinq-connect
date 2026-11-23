import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import { checkToken } from './check';

/** The plugin's settings page backend: checks a token against LG without saving anything. */
class SettingsServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/check', (body: { token?: unknown; country?: unknown } = {}) => checkToken(body.token, body.country));
    this.ready();
  }
}

(() => new SettingsServer())();
