import EventEmitter from 'node:events';

import {
  AbstractLevel,
  AbstractSublevel,
  AbstractBatchOperation
} from 'abstract-level';

import { SubsStore } from './persistence/subs.js';
import { Janitor } from './persistence/janitor.js';
import { ServiceConfiguration } from './config.js';
import Connector from './networking/connector.js';
import { FastifyBaseLogger } from 'fastify';
import { Scheduler } from './persistence/scheduler.js';
import { HexString } from './monitoring/types.js';

export type DB<F = Buffer | Uint8Array | string, K = string, V = any> = AbstractLevel<F, K, V>;
export type Family<F = Buffer | Uint8Array | string, K = string, V = any> = AbstractSublevel<DB, F, K, V>;
export type BatchOperation<K = string, V = any> = AbstractBatchOperation<DB, K, V>;

/**
 * Sublevel prefixes.
 */
export const prefixes = {
  subs: {
    family: (chainId: string) => `su:${chainId}`,
    uniques: 'su:ukeys'
  },
  sched: {
    tasks: 'sc:tasks'
  },
  cache: {
    family: (chainId: string) => `ch:${chainId}`,
    keys: {
      block: (hash: HexString) => `blk:${hash}`,
      ump: (hash: HexString) => `ump:${hash}`,
      hrmp: (hash: HexString) => `hrm:${hash}`
    },
    tips: 'ch:fi'
  },
  matching: {
    outbound: 'ma:out',
    inbound: 'ma:in'
  }
};
export const jsonEncoded = { valueEncoding: 'json' };

export type TelemetryObserver = {
  id: symbol,
  source: EventEmitter
}

export const TelemetrySources = {
  engine: Symbol('engine'),
  catcher: Symbol('catcher'),
  notifier: Symbol('notifier')
};

export const TelementryEngineEvents = {
  Inbound: Symbol('engine:inbound'),
  Outbound: Symbol('engine:outbound'),
  Matched: Symbol('eninge:matched')
};

export const TelementryCatcherEvents = {
  BlockSeen: Symbol('catcher:block-seen'),
  BlockFinalized: Symbol('catcher:block-finalized'),
  BlockCacheHit: Symbol('catcher:blocks-cache')
};

export const TelementryNotifierEvents = {
  Notify: Symbol('notifier:notify'),
  NotifyError: Symbol('notifier:notify-error')
};

export type Logger = FastifyBaseLogger
export type Services = {
  log: Logger,
  storage: {
    root: DB,
    subs: SubsStore
  },
  janitor: Janitor,
  scheduler: Scheduler,
  config: ServiceConfiguration,
  connector: Connector
}
