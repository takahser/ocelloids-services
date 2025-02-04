import EventEmitter from 'node:events';

import { Observable, from, switchMap, map, share, filter } from 'rxjs';
import { Registry } from '@polkadot/types-codec/types';
import { ControlQuery, extractEvents, types, extractTxWithEvents, flattenCalls } from '@sodazone/ocelloids-sdk';

import { extractXcmpReceive, extractXcmpSend } from './ops/xcmp.js';
import { Logger, Services, NetworkURN } from '../types.js';
import {
  Subscription,
  XcmInbound,
  RxSubscriptionHandler,
  XcmInboundWithContext,
  XcmSentWithContext,
  RxSubscriptionWithId,
  XcmEventListener,
  XcmNotifyMessage,
  SubscriptionStats,
  XcmNotificationType,
  XcmRelayedWithContext,
  HexString,
} from './types.js';

import { MatchingEngine } from './matching.js';
import { SubsStore } from '../persistence/subs.js';
import { NotifierHub } from '../notification/hub.js';
import { NotifierEvents } from '../notification/types.js';
import { TelemetryCollect, TelemetryEventEmitter } from '../telemetry/types.js';

import { sendersCriteria, messageCriteria, matchMessage, matchSenders } from './ops/criteria.js';
import { extractUmpReceive, extractUmpSend } from './ops/ump.js';
import { extractDmpReceive, extractDmpSend, extractDmpSendByEvent } from './ops/dmp.js';
import { mapXcmSent } from './ops/common.js';
import { errorMessage } from '../../errors.js';
import { extractRelayReceive } from './ops/relay.js';
import { IngressConsumer } from '../ingress/index.js';

import { GetDownwardMessageQueues, GetOutboundHrmpMessages, GetOutboundUmpMessages } from './types-augmented.js';
import {
  dmpDownwardMessageQueuesKey,
  parachainSystemHrmpOutboundMessages,
  parachainSystemUpwardMessages,
} from './storage.js';
import { getChainId } from '../config.js';

type Monitor = {
  subs: RxSubscriptionWithId[];
  controls: Record<string, ControlQuery>;
};

export enum SubscribeErrorCodes {
  TOO_MANY_SUBSCRIBERS,
}

export class SubscribeError extends Error {
  code: SubscribeErrorCodes;

  constructor(code: SubscribeErrorCodes, message: string) {
    super(message);

    Object.setPrototypeOf(this, SubscribeError.prototype);
    this.code = code;
  }
}

export type SwitchboardOptions = {
  subscriptionMaxPersistent?: number;
  subscriptionMaxEphemeral?: number;
};

const SUB_ERROR_RETRY_MS = 5000;

/**
 * XCM Subscriptions Switchboard.
 *
 * Manages subscriptions and notifications for Cross-Consensus Message Format (XCM) formatted messages.
 * Enables subscribing to and unsubscribing from XCM messages of interest, handling 'matched' notifications,
 * and managing subscription lifecycles.
 * Monitors active subscriptions, processes incoming 'matched' notifications,
 * and dynamically updates selection criteria of the subscriptions.
 */
export class Switchboard extends (EventEmitter as new () => TelemetryEventEmitter) {
  readonly #log: Logger;
  readonly #db: SubsStore;
  readonly #engine: MatchingEngine;
  readonly #ingress: IngressConsumer;
  readonly #notifier: NotifierHub;
  readonly #stats: SubscriptionStats;
  readonly #maxEphemeral: number;
  readonly #maxPersistent: number;
  readonly #timeouts: NodeJS.Timeout[] = [];

  #subs: Record<string, RxSubscriptionHandler> = {};
  #shared: {
    blockEvents: Record<string, Observable<types.BlockEvent>>;
    blockExtrinsics: Record<string, Observable<types.TxWithIdAndEvent>>;
  };

  constructor(ctx: Services, options: SwitchboardOptions) {
    super();

    const { log, subsStore, ingressConsumer } = ctx;

    this.#db = subsStore;
    this.#log = log;

    this.#engine = new MatchingEngine(ctx, this.#onXcmWaypointReached.bind(this));
    this.#ingress = ingressConsumer;
    this.#notifier = new NotifierHub(ctx);
    this.#stats = {
      ephemeral: 0,
      persistent: 0,
    };
    this.#maxEphemeral = options.subscriptionMaxEphemeral ?? 10_000;
    this.#maxPersistent = options.subscriptionMaxPersistent ?? 10_000;
    this.#shared = {
      blockEvents: {},
      blockExtrinsics: {},
    };
  }

  /**
   * Subscribes according to the given query subscription.
   *
   * @param {Subscription} qs The query subscription.
   * @throws {SubscribeError} If there is an error creating the subscription.
   */
  async subscribe(qs: Subscription) {
    if (this.#stats.ephemeral >= this.#maxEphemeral || this.#stats.persistent >= this.#maxPersistent) {
      throw new SubscribeError(SubscribeErrorCodes.TOO_MANY_SUBSCRIBERS, 'too many subscriptions');
    }

    if (!qs.ephemeral) {
      await this.#db.insert(qs);
    }
    this.#monitor(qs);

    this.#log.info('[%s] new subscription: %j', qs.origin, qs);
  }

  /**
   * Adds a listener function to the underlying notifier.
   *
   * @param eventName The notifier event name.
   * @param listener The listener function.
   */
  addNotificationListener(eventName: keyof NotifierEvents, listener: XcmEventListener) {
    this.#notifier.on(eventName, listener);
  }

  /**
   * Removes a listener function from the underlying notifier.
   *
   * @param eventName The notifier event name.
   * @param listener The listener function.
   */
  removeNotificationListener(eventName: keyof NotifierEvents, listener: XcmEventListener) {
    this.#notifier.off(eventName, listener);
  }

  /**
   * Unsubscribes by subsciption identifier.
   *
   * If the subscription does not exists just ignores it.
   *
   * @param {string} id The subscription identifier.
   */
  async unsubscribe(id: string) {
    if (this.#subs[id] === undefined) {
      this.#log.warn('unsubscribe from a non-existent subscription %s', id);
      return;
    }

    try {
      const {
        descriptor: { origin, ephemeral },
        originSubs,
        destinationSubs,
        relaySub,
      } = this.#subs[id];

      this.#log.info('[%s] unsubscribe %s', origin, id);

      originSubs.forEach(({ sub }) => sub.unsubscribe());
      destinationSubs.forEach(({ sub }) => sub.unsubscribe());
      if (relaySub) {
        relaySub.sub.unsubscribe();
      }
      delete this.#subs[id];

      await this.#engine.clearPendingStates(id);

      if (ephemeral) {
        this.#stats.ephemeral--;
      } else {
        this.#stats.persistent--;
        await this.#db.remove(id);
      }
    } catch (error) {
      this.#log.error(error, 'Error unsubscribing %s', id);
    }
  }

  async start() {
    await this.#startNetworkMonitors();
  }

  /**
   * Stops the switchboard and unsubscribes from the underlying
   * reactive subscriptions.
   */
  async stop() {
    this.#log.info('Stopping switchboard');

    for (const {
      descriptor: { id },
      originSubs,
      destinationSubs,
      relaySub,
    } of Object.values(this.#subs)) {
      this.#log.info('Unsubscribe %s', id);

      originSubs.forEach(({ sub }) => sub.unsubscribe());
      destinationSubs.forEach(({ sub }) => sub.unsubscribe());
      if (relaySub) {
        relaySub.sub.unsubscribe();
      }
    }

    for (const t of this.#timeouts) {
      t.unref();
    }

    await this.#engine.stop();
  }

  /**
   * Gets a subscription handler by id.
   */
  findSubscriptionHandler(id: string) {
    return this.#subs[id];
  }

  /**
   * Updates the senders control handler.
   *
   * Applies to the outbound extrinsic signers.
   */
  updateSenders(id: string) {
    const {
      descriptor: { senders },
      sendersControl,
    } = this.#subs[id];

    sendersControl.change(sendersCriteria(senders));
  }

  /**
   * Updates the message control handler.
   *
   * Updates the destination subscriptions.
   */
  updateDestinations(id: string) {
    const { descriptor, messageControl } = this.#subs[id];

    messageControl.change(messageCriteria(descriptor.destinations as NetworkURN[]));

    const updatedSubs = this.#updateDestinationSubscriptions(id);
    this.#subs[id].destinationSubs = updatedSubs;
  }

  /**
   * Updates the subscription to relayed HRMP messages in the relay chain.
   */
  updateEvents(id: string) {
    const { descriptor, relaySub } = this.#subs[id];

    if (this.#shouldMonitorRelay(descriptor) && relaySub === undefined) {
      try {
        this.#subs[id].relaySub = this.#monitorRelay(descriptor);
      } catch (error) {
        // log instead of throw to not block OD subscriptions
        this.#log.error(error, 'Error on relay subscription (%s)', id);
      }
    } else if (!this.#shouldMonitorRelay(descriptor) && relaySub !== undefined) {
      relaySub.sub.unsubscribe();
      delete this.#subs[id].relaySub;
    }
  }

  /**
   * Updates a subscription descriptor.
   */
  updateSubscription(sub: Subscription) {
    if (this.#subs[sub.id]) {
      this.#subs[sub.id].descriptor = sub;
    } else {
      this.#log.warn('trying to update an unknown subscription %s', sub.id);
    }
  }

  /**
   * Calls the given collect function for each private observable component.
   *
   * @param collect The collect callback function.
   */
  collectTelemetry(collect: TelemetryCollect) {
    collect(this);
    collect(this.#engine);
    collect(this.#notifier);
  }

  /**
   * Returns the in-memory subscription statistics.
   */
  get stats() {
    return this.#stats;
  }

  /**
   * Main monitoring logic.
   *
   * This method sets up and manages subscriptions for XCM messages based on the provided
   * query subscription information. It creates subscriptions for both the origin and destination
   * networks, monitors XCM message transfers, and emits events accordingly.
   *
   * @param {Subscription} qs - The query subscription.
   * @throws {Error} If there is an error during the subscription setup process.
   * @private
   */
  #monitor(qs: Subscription) {
    const { id } = qs;

    let origMonitor: Monitor = { subs: [], controls: {} };
    let destMonitor: Monitor = { subs: [], controls: {} };
    let relaySub: RxSubscriptionWithId | undefined;

    try {
      origMonitor = this.#monitorOrigins(qs);
      destMonitor = this.#monitorDestinations(qs);
    } catch (error) {
      // Clean up origin subscriptions.
      origMonitor.subs.forEach(({ sub }) => {
        sub.unsubscribe();
      });
      throw error;
    }

    // Only subscribe to relay events if required by subscription.
    // Contained in its own try-catch so it doesn't prevent origin-destination subs in case of error.
    if (this.#shouldMonitorRelay(qs)) {
      try {
        relaySub = this.#monitorRelay(qs);
      } catch (error) {
        // log instead of throw to not block OD subscriptions
        this.#log.error(error, 'Error on relay subscription (%s)', id);
      }
    }

    const { sendersControl, messageControl } = origMonitor.controls;

    this.#subs[id] = {
      descriptor: qs,
      sendersControl,
      messageControl,
      originSubs: origMonitor.subs,
      destinationSubs: destMonitor.subs,
      relaySub,
    };

    if (qs.ephemeral) {
      this.#stats.ephemeral++;
    } else {
      this.#stats.persistent++;
    }
  }

  /**
   * Set up inbound monitors for XCM protocols.
   *
   * @private
   */
  #monitorDestinations({ id, destinations, origin }: Subscription): Monitor {
    const subs: RxSubscriptionWithId[] = [];
    const originId = origin as NetworkURN;
    try {
      for (const dest of destinations as NetworkURN[]) {
        const chainId = dest;
        if (this.#subs[id]?.destinationSubs.find((s) => s.chainId === chainId)) {
          // Skip existing subscriptions
          // for the same destination chain
          continue;
        }

        const inboundObserver = {
          error: (error: any) => {
            this.#log.error(error, '[%s] error on destination subscription %s', chainId, id);
            this.emit('telemetrySubscriptionError', {
              subscriptionId: id,
              chainId,
              direction: 'in',
            });

            // try recover inbound subscription
            if (this.#subs[id]) {
              const { destinationSubs } = this.#subs[id];
              const index = destinationSubs.findIndex((s) => s.chainId === chainId);
              if (index > -1) {
                destinationSubs.splice(index, 1);
                this.#timeouts.push(
                  setTimeout(() => {
                    this.#log.info(
                      '[%s] UPDATE destination subscription %s due error %s',
                      chainId,
                      id,
                      errorMessage(error)
                    );
                    const updated = this.#updateDestinationSubscriptions(id);
                    this.#subs[id].destinationSubs = updated;
                  }, SUB_ERROR_RETRY_MS)
                );
              }
            }
          },
        };

        if (this.#ingress.isRelay(dest)) {
          // VMP UMP
          this.#log.info('[%s] subscribe inbound UMP (%s)', chainId, id);

          subs.push({
            chainId,
            sub: this.#sharedBlockEvents(chainId)
              .pipe(extractUmpReceive(originId), this.#emitInbound(id, chainId))
              .subscribe(inboundObserver),
          });
        } else if (this.#ingress.isRelay(originId)) {
          // VMP DMP
          this.#log.info('[%s] subscribe inbound DMP (%s)', chainId, id);

          subs.push({
            chainId,
            sub: this.#sharedBlockEvents(chainId)
              .pipe(extractDmpReceive(), this.#emitInbound(id, chainId))
              .subscribe(inboundObserver),
          });
        } else {
          // Inbound HRMP / XCMP transport
          this.#log.info('[%s] subscribe inbound HRMP (%s)', chainId, id);

          subs.push({
            chainId,
            sub: this.#sharedBlockEvents(chainId)
              .pipe(extractXcmpReceive(), this.#emitInbound(id, chainId))
              .subscribe(inboundObserver),
          });
        }
      }
    } catch (error) {
      // Clean up subscriptions.
      subs.forEach(({ sub }) => {
        sub.unsubscribe();
      });
      throw error;
    }

    return { subs, controls: {} };
  }

  /**
   * Set up outbound monitors for XCM protocols.
   *
   * @private
   */
  #monitorOrigins({ id, origin, senders, destinations }: Subscription): Monitor {
    const subs: RxSubscriptionWithId[] = [];
    const chainId = origin as NetworkURN;

    if (this.#subs[id]?.originSubs.find((s) => s.chainId === chainId)) {
      throw new Error(`Fatal: duplicated origin monitor ${id} for chain ${chainId}`);
    }

    const sendersControl = ControlQuery.from(sendersCriteria(senders));
    const messageControl = ControlQuery.from(messageCriteria(destinations as NetworkURN[]));

    const outboundObserver = {
      error: (error: any) => {
        this.#log.error(error, '[%s] error on origin subscription %s', chainId, id);
        this.emit('telemetrySubscriptionError', {
          subscriptionId: id,
          chainId,
          direction: 'out',
        });

        // try recover outbound subscription
        // note: there is a single origin per outbound
        if (this.#subs[id]) {
          const { originSubs, descriptor } = this.#subs[id];
          const index = originSubs.findIndex((s) => s.chainId === chainId);
          if (index > -1) {
            this.#subs[id].originSubs = [];
            this.#timeouts.push(
              setTimeout(() => {
                if (this.#subs[id]) {
                  this.#log.info('[%s] UPDATE origin subscription %s due error %s', chainId, id, errorMessage(error));
                  const { subs: updated, controls } = this.#monitorOrigins(descriptor);
                  this.#subs[id].sendersControl = controls.sendersControl;
                  this.#subs[id].messageControl = controls.messageControl;
                  this.#subs[id].originSubs = updated;
                }
              }, SUB_ERROR_RETRY_MS)
            );
          }
        }
      },
    };

    try {
      if (this.#ingress.isRelay(chainId)) {
        // VMP DMP
        this.#log.info('[%s] subscribe outbound DMP (%s)', chainId, id);

        subs.push({
          chainId,
          sub: this.#ingress
            .getRegistry(chainId)
            .pipe(
              switchMap((registry) =>
                this.#sharedBlockExtrinsics(chainId).pipe(
                  extractDmpSend(chainId, this.#getDmp(chainId, registry), registry),
                  this.#emitOutbound(id, chainId, registry, messageControl)
                )
              )
            )
            .subscribe(outboundObserver),
        });

        // VMP DMP
        this.#log.info('[%s] subscribe outbound DMP - by event (%s)', chainId, id);

        subs.push({
          chainId,
          sub: this.#ingress
            .getRegistry(chainId)
            .pipe(
              switchMap((registry) =>
                this.#sharedBlockEvents(chainId).pipe(
                  extractDmpSendByEvent(chainId, this.#getDmp(chainId, registry), registry),
                  this.#emitOutbound(id, chainId, registry, messageControl)
                )
              )
            )
            .subscribe(outboundObserver),
        });
      } else {
        // Outbound HRMP / XCMP transport
        this.#log.info('[%s] subscribe outbound HRMP (%s)', chainId, id);

        subs.push({
          chainId,
          sub: this.#ingress
            .getRegistry(chainId)
            .pipe(
              switchMap((registry) =>
                this.#sharedBlockEvents(chainId).pipe(
                  extractXcmpSend(chainId, this.#getHrmp(chainId, registry), registry),
                  this.#emitOutbound(id, chainId, registry, messageControl)
                )
              )
            )
            .subscribe(outboundObserver),
        });

        // VMP UMP
        this.#log.info('[%s] subscribe outbound UMP (%s)', chainId, id);

        subs.push({
          chainId,
          sub: this.#ingress
            .getRegistry(chainId)
            .pipe(
              switchMap((registry) =>
                this.#sharedBlockEvents(chainId).pipe(
                  extractUmpSend(chainId, sendersControl, this.#getUmp(chainId, registry), registry),
                  this.#emitOutbound(id, chainId, registry, messageControl)
                )
              )
            )
            .subscribe(outboundObserver),
        });
      }
    } catch (error) {
      // Clean up subscriptions.
      subs.forEach(({ sub }) => {
        sub.unsubscribe();
      });
      throw error;
    }

    return {
      subs,
      controls: {
        sendersControl,
        messageControl,
      },
    };
  }

  #monitorRelay({ id, destinations, origin }: Subscription) {
    const chainId = origin as NetworkURN;
    if (this.#subs[id]?.relaySub) {
      this.#log.debug('Relay subscription already exists.');
    }
    const messageControl = ControlQuery.from(messageCriteria(destinations as NetworkURN[]));

    const emitRelayInbound = () => (source: Observable<XcmRelayedWithContext>) =>
      source.pipe(switchMap((message) => from(this.#engine.onRelayedMessage(id, message))));

    const relayObserver = {
      error: (error: any) => {
        this.#log.error(error, '[%s] error on relay subscription s', chainId, id);
        this.emit('telemetrySubscriptionError', {
          subscriptionId: id,
          chainId,
          direction: 'relay',
        });

        // try recover relay subscription
        // there is only one subscription per subscription ID for relay
        if (this.#subs[id]) {
          this.#timeouts.push(
            setTimeout(async () => {
              this.#log.info('[%s] UPDATE relay subscription %s due error %s', chainId, id, errorMessage(error));
              const updatedSub = await this.#monitorRelay(this.#subs[id].descriptor);
              this.#subs[id].relaySub = updatedSub;
            }, SUB_ERROR_RETRY_MS)
          );
        }
      },
    };

    // TODO: should resolve relay id for consensus in context
    const relayIds = this.#ingress.getRelayIds();
    this.#log.info('[%s] subscribe relay %s xcm events (%s)', chainId, relayIds[0], id);
    return {
      chainId,
      sub: this.#ingress
        .getRegistry(relayIds[0])
        .pipe(
          switchMap((registry) =>
            this.#sharedBlockExtrinsics(relayIds[0]).pipe(
              extractRelayReceive(chainId, messageControl, registry),
              emitRelayInbound()
            )
          )
        )
        .subscribe(relayObserver),
    };
  }

  #updateDestinationSubscriptions(id: string) {
    const { descriptor, destinationSubs } = this.#subs[id];
    // Subscribe to new destinations, if any
    const { subs } = this.#monitorDestinations(descriptor);
    const updatedSubs = destinationSubs.concat(subs);
    // Unsubscribe removed destinations, if any
    const removed = updatedSubs.filter((s) => !descriptor.destinations.includes(s.chainId));
    removed.forEach(({ sub }) => sub.unsubscribe());
    // Return list of updated subscriptions
    return updatedSubs.filter((s) => !removed.includes(s));
  }

  /**
   * Starts collecting XCM messages.
   *
   * Monitors all the active subscriptions for the configured networks.
   *
   * @private
   */
  async #startNetworkMonitors() {
    const chainIds = this.#ingress.getChainIds();

    for (const chainId of chainIds) {
      const subs = await this.#db.getByNetworkId(chainId);

      this.#log.info('[%s] #subscriptions %d', chainId, subs.length);

      for (const sub of subs) {
        try {
          this.#monitor(sub);
        } catch (err) {
          this.#log.error(err, 'Unable to create subscription: %j', sub);
        }
      }
    }
  }

  #onXcmWaypointReached(msg: XcmNotifyMessage) {
    const { subscriptionId } = msg;
    if (this.#subs[subscriptionId]) {
      const { descriptor, sendersControl } = this.#subs[subscriptionId];
      if (
        (descriptor.events === undefined || descriptor.events === '*' || descriptor.events.includes(msg.type)) &&
        matchSenders(sendersControl, msg.sender)
      ) {
        this.#notifier.notify(descriptor, msg);
      }
    } else {
      // this could happen with closed ephemeral subscriptions
      this.#log.warn('Unable to find descriptor for subscription %s', subscriptionId);
    }
  }

  #sharedBlockEvents(chainId: NetworkURN): Observable<types.BlockEvent> {
    if (!this.#shared.blockEvents[chainId]) {
      this.#shared.blockEvents[chainId] = this.#ingress.finalizedBlocks(chainId).pipe(extractEvents(), share());
    }
    return this.#shared.blockEvents[chainId];
  }

  #sharedBlockExtrinsics(chainId: NetworkURN): Observable<types.TxWithIdAndEvent> {
    if (!this.#shared.blockExtrinsics[chainId]) {
      this.#shared.blockExtrinsics[chainId] = this.#ingress
        .finalizedBlocks(chainId)
        .pipe(extractTxWithEvents(), flattenCalls(), share());
    }
    return this.#shared.blockExtrinsics[chainId];
  }

  /**
   * Checks if relayed HRMP messages should be monitored.
   *
   * All of the following conditions needs to be met:
   * 1. `xcm.relayed` notification event is requested in the subscription
   * 2. Origin chain is not a relay chain
   * 3. At least one destination chain is a parachain
   *
   * @param Subscription
   * @returns boolean
   */
  #shouldMonitorRelay({ origin, destinations, events }: Subscription) {
    return (
      (events === undefined || events === '*' || events.includes(XcmNotificationType.Relayed)) &&
      !this.#ingress.isRelay(origin as NetworkURN) &&
      destinations.some((d) => !this.#ingress.isRelay(d as NetworkURN))
    );
  }

  #emitInbound(id: string, chainId: NetworkURN) {
    return (source: Observable<XcmInboundWithContext>) =>
      source.pipe(switchMap((msg) => from(this.#engine.onInboundMessage(new XcmInbound(id, chainId, msg)))));
  }

  #emitOutbound(id: string, origin: NetworkURN, registry: Registry, messageControl: ControlQuery) {
    const {
      descriptor: { outboundTTL },
    } = this.#subs[id];

    return (source: Observable<XcmSentWithContext>) =>
      source.pipe(
        mapXcmSent(id, registry, origin),
        filter((msg) => matchMessage(messageControl, msg)),
        switchMap((outbound) => from(this.#engine.onOutboundMessage(outbound, outboundTTL)))
      );
  }

  #getDmp(chainId: NetworkURN, registry: Registry): GetDownwardMessageQueues {
    return (blockHash: HexString, networkId: NetworkURN) => {
      const paraId = getChainId(networkId);
      return from(this.#ingress.getStorage(chainId, dmpDownwardMessageQueuesKey(registry, paraId), blockHash)).pipe(
        map((buffer) => {
          return registry.createType('Vec<PolkadotCorePrimitivesInboundDownwardMessage>', buffer);
        })
      );
    };
  }

  #getUmp(chainId: NetworkURN, registry: Registry): GetOutboundUmpMessages {
    return (blockHash: HexString) => {
      return from(this.#ingress.getStorage(chainId, parachainSystemUpwardMessages, blockHash)).pipe(
        map((buffer) => {
          return registry.createType('Vec<Bytes>', buffer);
        })
      );
    };
  }

  #getHrmp(chainId: NetworkURN, registry: Registry): GetOutboundHrmpMessages {
    return (blockHash: HexString) => {
      return from(this.#ingress.getStorage(chainId, parachainSystemHrmpOutboundMessages, blockHash)).pipe(
        map((buffer) => {
          return registry.createType('Vec<PolkadotCorePrimitivesOutboundHrmpMessage>', buffer);
        })
      );
    };
  }
}
