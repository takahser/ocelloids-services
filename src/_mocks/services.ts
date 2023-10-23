import { pino } from 'pino';
import toml from 'toml';
import { MemoryLevel } from 'memory-level';

import { SubsDB } from '../services/storage/subs.js';
import { Janitor } from '../services/storage/janitor.js';
import { $ServiceConfiguration } from '../services/configuration.js';
import Connector from '../services/networking/connector.js';
import { _configToml } from './data.js';

export const _log = pino({
  enabled: false
});

export const _config = $ServiceConfiguration.parse(
  toml.parse(_configToml)
);

export const _services = {
  log: _log,
  config: _config,
  connector: {} as unknown as Connector,
  storage: {
    db: new MemoryLevel(),
    subsDB: {} as unknown as SubsDB
  },
  janitor: {
    schedule: () => {}
  } as unknown as Janitor
};
