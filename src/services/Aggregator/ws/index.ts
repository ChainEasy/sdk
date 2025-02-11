import { z } from 'zod';
import WebSocket from 'isomorphic-ws';
import { validate as uuidValidate, v4 as uuidv4 } from 'uuid';
import MessageType from './MessageType.js';
import SubscriptionType from './SubscriptionType.js';
import {
  pingPongMessageSchema, initMessageSchema,
  errorSchema, brokerMessageSchema, orderBookSchema,
  assetPairsConfigSchema, addressUpdateSchema, swapInfoSchema,
} from './schemas/index.js';
import UnsubscriptionType from './UnsubscriptionType.js';
import type {
  SwapInfoBase, AssetPairUpdate, OrderbookItem,
  Balance, Exchange, CFDBalance, FuturesTradeInfo, SwapInfo, Json,
} from '../../../types.js';
import unsubscriptionDoneSchema from './schemas/unsubscriptionDoneSchema.js';
import assetPairConfigSchema from './schemas/assetPairConfigSchema.js';
import type { fullOrderSchema, orderUpdateSchema } from './schemas/addressUpdateSchema.js';
import cfdAddressUpdateSchema from './schemas/cfdAddressUpdateSchema.js';
import futuresTradeInfoSchema from './schemas/futuresTradeInfoSchema.js';
import { objectKeys } from '../../../utils/objectKeys.js';
// import assertError from '../../../utils/assertError.js';
// import errorSchema from './schemas/errorSchema';

const UNSUBSCRIBE = 'u';

type SwapInfoSubscriptionPayload = {
  // d: string, // swap request UUID, set by client side
  i: string // asset in
  o: string // asset out
  a: number // amount IN/OUT
  es?: Exchange[] | 'cex' | 'pools' // exchange list of all cex or all pools (ORION_POOL, UNISWAP, PANCAKESWAP etc)
  e?: boolean // is amount IN? Value `false` means a = amount OUT, `true` if omitted
  is?: boolean // instant settlement
}

type FuturesTradeInfoPayload = {
  s: string // wallet address
  i: string // pair
  a: number // amount
  p?: number // price
}

type BrokerTradableAtomicSwapBalanceSubscription = {
  callback: (balances: Partial<Record<string, number>>) => void
}

type PairsConfigSubscription = {
  callback: ({ kind, data }: {
    kind: 'initial' | 'update'
    data: Partial<Record<string, AssetPairUpdate>>
  }) => void
}

type PairConfigSubscription = {
  payload: string
  callback: ({ kind, data }: {
    kind: 'initial' | 'update'
    data: AssetPairUpdate
  }) => void
}

type AggregatedOrderbookSubscription = {
  payload: string
  callback: (
    asks: OrderbookItem[],
    bids: OrderbookItem[],
    pair: string
  ) => void
  errorCb?: (message: string) => void
}

type SwapInfoSubscription = {
  payload: SwapInfoSubscriptionPayload
  callback: (swapInfo: SwapInfo) => void
}

type FuturesTradeInfoSubscription = {
  payload: FuturesTradeInfoPayload
  callback: (futuresTradeInfo: FuturesTradeInfo) => void
  errorCb?: (message: string) => void
}

type AddressUpdateUpdate = {
  kind: 'update'
  balances: Partial<
    Record<
      string,
      Balance
    >
  >
  order?: z.infer<typeof orderUpdateSchema> | z.infer<typeof fullOrderSchema> | undefined
}

type AddressUpdateInitial = {
  kind: 'initial'
  balances: Partial<
    Record<
      string,
      Balance
    >
  >
  orders?: Array<z.infer<typeof fullOrderSchema>> | undefined // The field is not defined if the user has no orders
}

type CfdAddressUpdateUpdate = {
  kind: 'update'
  balances?: CFDBalance[] | undefined
  order?: z.infer<typeof orderUpdateSchema> | z.infer<typeof fullOrderSchema> | undefined
}

type CfdAddressUpdateInitial = {
  kind: 'initial'
  balances: CFDBalance[]
  orders?: Array<z.infer<typeof fullOrderSchema>> | undefined // The field is not defined if the user has no orders
}

type AddressUpdateSubscription = {
  payload: string
  callback: (data: AddressUpdateUpdate | AddressUpdateInitial) => void
  errorCb?: (message: string) => void
}

type CfdAddressUpdateSubscription = {
  payload: string
  callback: (data: CfdAddressUpdateUpdate | CfdAddressUpdateInitial) => void
}

type Subscription = {
  [SubscriptionType.ADDRESS_UPDATES_SUBSCRIBE]: AddressUpdateSubscription
  [SubscriptionType.CFD_ADDRESS_UPDATES_SUBSCRIBE]: CfdAddressUpdateSubscription
  [SubscriptionType.AGGREGATED_ORDER_BOOK_UPDATES_SUBSCRIBE]: AggregatedOrderbookSubscription
  [SubscriptionType.ASSET_PAIRS_CONFIG_UPDATES_SUBSCRIBE]: PairsConfigSubscription
  [SubscriptionType.ASSET_PAIR_CONFIG_UPDATES_SUBSCRIBE]: PairConfigSubscription
  [SubscriptionType.BROKER_TRADABLE_ATOMIC_SWAP_ASSETS_BALANCE_UPDATES_SUBSCRIBE]: BrokerTradableAtomicSwapBalanceSubscription
  [SubscriptionType.SWAP_SUBSCRIBE]: SwapInfoSubscription
  [SubscriptionType.FUTURES_TRADE_INFO_SUBSCRIBE]: FuturesTradeInfoSubscription
}

const exclusiveSubscriptions = [
  SubscriptionType.BROKER_TRADABLE_ATOMIC_SWAP_ASSETS_BALANCE_UPDATES_SUBSCRIBE,
  SubscriptionType.ASSET_PAIRS_CONFIG_UPDATES_SUBSCRIBE,
] as const;

type BufferLike =
  | string
  | Buffer
  | DataView
  | number
  | ArrayBufferView
  | Uint8Array
  | ArrayBuffer
  | SharedArrayBuffer
  | readonly unknown[]
  | readonly number[]
  | { valueOf: () => ArrayBuffer }
  | { valueOf: () => SharedArrayBuffer }
  | { valueOf: () => Uint8Array }
  | { valueOf: () => readonly number[] }
  | { valueOf: () => string }
  | { [Symbol.toPrimitive]: (hint: string) => string };

const isSubType = (subType: string): subType is keyof Subscription => Object.values(SubscriptionType).some((t) => t === subType);

const unknownMessageTypeRegex = /An unknown message type: '(.*)', json: (.*)/;
const nonExistentMessageRegex = /Could not cancel nonexistent subscription: (.*)/;

// type Message = {
//   message: Json
//   resolve: () => void
// };
class AggregatorWS {
  private ws?: WebSocket | undefined;

  // is used to make sure we do not need to renew ws subscription
  // we can not be sure that onclose event will recieve our code when we do `ws.close(4000)`
  // since sometimes it can be replaced with system one.
  // https://stackoverflow.com/questions/19304157/getting-the-reason-why-websockets-closed-with-close-code-1006
  private isClosedIntentionally = false;

  readonly subscriptions: Partial<{
    [K in keyof Subscription]: Partial<Record<string, Subscription[K]>>
  }> = {};

  public onInit: (() => void) | undefined

  public onError: ((err: string) => void) | undefined

  public logger: ((message: string) => void) | undefined

  private readonly wsUrl: string;

  get api() {
    return this.wsUrl;
  }

  readonly instanceId = uuidv4();

  constructor(
    wsUrl: string,
    logger?: (msg: string) => void,
    onInit?: () => void,
    onError?: (err: string) => void
  ) {
    this.wsUrl = wsUrl;
    this.logger = logger;
    this.onInit = onInit;
    this.onError = onError;
  }

  // readonly messageQueue: Message[] = [];

  private sendRaw(data: BufferLike) {
    if (this.ws?.readyState === 1) {
      this.ws.send(data);
    } else if (this.ws?.readyState === 0) {
      setTimeout(() => {
        this.sendRaw(data);
      }, 50);
    }
  }

  private send(jsonObject: Json) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const jsonData = JSON.stringify(jsonObject);
      this.ws.send(jsonData);
      this.logger?.(`Sent: ${jsonData}`);
    } else {
      setTimeout(() => {
        this.send(jsonObject);
      }, 50);
    }
  }

  subscribe<T extends typeof SubscriptionType[keyof typeof SubscriptionType]>(
    type: T,
    subscription: Subscription[T],
  ) {
    const id = type === 'aobus'
      ? ((subscription as any).payload as string) // TODO: Refactor!!!
      : uuidv4();

    const makeSubscription = () => {
      const isExclusive = exclusiveSubscriptions.some((t) => t === type);
      const subs = this.subscriptions[type];
      if (isExclusive && subs && Object.keys(subs).length > 0) {
        throw new Error(`Subscription '${type}' already exists. Please unsubscribe first.`);
      }

      const subRequest: Json = {};
      subRequest['T'] = type;
      subRequest['id'] = id;

      if ('payload' in subscription) {
        if (typeof subscription.payload === 'string') {
          subRequest['S'] = subscription.payload;
        } else { // SwapInfoSubscriptionPayload | FuturesTradeInfoPayload
          subRequest['S'] = { ...subscription.payload }

          if (!('s' in subscription.payload)) { // SwapInfoSubscriptionPayload
            subRequest['S'] = {
              ...subRequest['S'],
              d: id,
            };
          }
        }
      }

      this.send(subRequest);

      const subKey = isExclusive ? 'default' : id;
      this.subscriptions[type] = {
        ...this.subscriptions[type],
        [subKey]: subscription,
      };
    }

    // if (!this.ws) {
    //   this.initAsync()
    //     .then(() => {
    //       console.log(`Aggregator WS ${this.instanceId} is initialized`);
    //       makeSubscription();
    //     })
    //     .catch((err) => {
    //       assertError(err);
    //       this.onError?.(err.message);
    //     });
    // } else makeSubscription();

    if (!this.ws) {
      this.init();
      console.log(`Aggregator WS ${this.instanceId} is initialized`);
    }
    makeSubscription();

    return id;
  }

  unsubscribe(subscription: keyof typeof UnsubscriptionType | string, details?: string) {
    this.send({
      T: UNSUBSCRIBE,
      S: subscription,
      ...(details !== undefined) && { d: details },
    });

    if (subscription.includes('0x')) { // is wallet address (ADDRESS_UPDATE)
      const auSubscriptions = this.subscriptions[SubscriptionType.ADDRESS_UPDATES_SUBSCRIBE];
      if (auSubscriptions) {
        const targetAuSub = Object.entries(auSubscriptions).find(([, value]) => value?.payload === subscription);
        if (targetAuSub) {
          const [key] = targetAuSub;
          delete this.subscriptions[SubscriptionType.ADDRESS_UPDATES_SUBSCRIBE]?.[key];
        }
      }

      const aufSubscriptions = this.subscriptions[SubscriptionType.CFD_ADDRESS_UPDATES_SUBSCRIBE];
      if (aufSubscriptions) {
        const targetAufSub = Object.entries(aufSubscriptions).find(([, value]) => value?.payload === subscription);
        if (targetAufSub) {
          const [key] = targetAufSub;
          delete this.subscriptions[SubscriptionType.CFD_ADDRESS_UPDATES_SUBSCRIBE]?.[key];
        }
      }
    } else if (uuidValidate(subscription)) {
      // is swap info subscription (contains hyphen)
      delete this.subscriptions[SubscriptionType.SWAP_SUBSCRIBE]?.[subscription];
      delete this.subscriptions[SubscriptionType.ASSET_PAIR_CONFIG_UPDATES_SUBSCRIBE]?.[subscription];
      delete this.subscriptions[SubscriptionType.FUTURES_TRADE_INFO_SUBSCRIBE]?.[subscription];
      // !!! swap info subscription is uuid that contains hyphen
    } else if (subscription.includes('-') && subscription.split('-').length === 2) { // is pair name(AGGREGATED_ORDER_BOOK_UPDATE)
      const aobSubscriptions = this.subscriptions[SubscriptionType.AGGREGATED_ORDER_BOOK_UPDATES_SUBSCRIBE];
      if (aobSubscriptions) {
        const targetAobSub = Object.entries(aobSubscriptions).find(([, value]) => value?.payload === subscription);
        if (targetAobSub) {
          const [key] = targetAobSub;
          delete this.subscriptions[SubscriptionType.AGGREGATED_ORDER_BOOK_UPDATES_SUBSCRIBE]?.[key];
        }
      }
    } else if (subscription === UnsubscriptionType.ASSET_PAIRS_CONFIG_UPDATES_UNSUBSCRIBE) {
      delete this.subscriptions[SubscriptionType.ASSET_PAIRS_CONFIG_UPDATES_SUBSCRIBE]?.['default'];
    } else if (subscription === UnsubscriptionType.BROKER_TRADABLE_ATOMIC_SWAP_ASSETS_BALANCE_UPDATES_UNSUBSCRIBE) {
      delete this.subscriptions[SubscriptionType.BROKER_TRADABLE_ATOMIC_SWAP_ASSETS_BALANCE_UPDATES_SUBSCRIBE]?.['default'];
    }
  }

  destroy() {
    this.isClosedIntentionally = true;
    this.ws?.close();
    delete this.ws;
  }

  // private initPromise: Promise<void> | null = null;

  // private initAsync() {
  //   if (!this.initPromise) {
  //     this.initPromise = new Promise<void>((resolve, reject) => {
  //       try {
  //         this.init();
  //         resolve();
  //       } catch (err) {
  //         reject(err);
  //       }
  //     });
  //   }

  //   return this.initPromise;
  // }

  private init(isReconnect = false) {
    this.isClosedIntentionally = false;
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onerror = (err) => {
      this.logger?.(`AggregatorWS: ${err.message}`);
    };
    this.ws.onclose = () => {
      this.logger?.(`AggregatorWS: connection closed ${this.isClosedIntentionally ? 'intentionally' : ''}`);
      if (!this.isClosedIntentionally) this.init(true);
    };
    this.ws.onopen = () => {
      // Re-subscribe to all subscriptions
      if (isReconnect) {
        const subscriptionsToReconnect = this.subscriptions;
        objectKeys(this.subscriptions).forEach((subType) => {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete this.subscriptions[subType];
        });
        Object.keys(subscriptionsToReconnect)
          .filter(isSubType)
          .forEach((subType) => {
            const subscriptions = subscriptionsToReconnect[subType];
            if (subscriptions) {
              Object.keys(subscriptions).forEach((subKey) => {
                const sub = subscriptions[subKey];
                if (sub) this.subscribe(subType, sub);
              });
            }
          });
      }
      this.logger?.(`AggregatorWS: connection opened${isReconnect ? ' (reconnect)' : ''}`);
    };
    this.ws.onmessage = (e) => {
      const { data } = e;
      if (typeof data !== 'string') throw new Error('AggregatorWS: received non-string message');
      this.logger?.(`AggregatorWS: received message: ${data}`);
      const rawJson: unknown = JSON.parse(data);

      const messageSchema = z.union([
        initMessageSchema,
        pingPongMessageSchema,
        addressUpdateSchema,
        cfdAddressUpdateSchema,
        assetPairsConfigSchema,
        assetPairConfigSchema,
        brokerMessageSchema,
        orderBookSchema,
        swapInfoSchema,
        futuresTradeInfoSchema,
        errorSchema,
        unsubscriptionDoneSchema,
      ]);

      const json = messageSchema.parse(rawJson);

      switch (json.T) {
        case MessageType.ERROR: {
          const err = errorSchema.parse(json);
          // Get subscription error callback
          // 2. Find subscription by id
          // 3. Call onError callback

          const { id, m } = err;
          if (id !== undefined) {
            const nonExistentMessageMatch = m.match(nonExistentMessageRegex);
            const unknownMessageMatch = m.match(unknownMessageTypeRegex);
            if (nonExistentMessageMatch !== null) {
              const [, subscription] = nonExistentMessageMatch;
              if (subscription === undefined) throw new TypeError('Subscription is undefined. This should not happen.')
              console.warn(`You tried to unsubscribe from non-existent subscription '${subscription}'. This is probably a bug in the code. Please be sure that you are unsubscribing from the subscription that you are subscribed to.`)
            } else if (unknownMessageMatch !== null) {
              const [, subscription, jsonPayload] = unknownMessageMatch;
              if (subscription === undefined) throw new TypeError('Subscription is undefined. This should not happen.')
              if (jsonPayload === undefined) throw new TypeError('JSON payload is undefined. This should not happen.')
              console.warn(`You tried to subscribe to '${subscription}' with unknown payload '${jsonPayload}'. This is probably a bug in the code. Please be sure that you are subscribing to the existing subscription with the correct payload.`)
            } else {
              const subType = objectKeys(this.subscriptions).find((st) => this.subscriptions[st]?.[id]);
              if (subType === undefined) throw new Error(`AggregatorWS: cannot find subscription type by id ${id}. Current subscriptions: ${JSON.stringify(this.subscriptions)}`);
              const sub = this.subscriptions[subType]?.[id];
              if (sub === undefined) throw new Error(`AggregatorWS: cannot find subscription by id ${id}. Current subscriptions: ${JSON.stringify(this.subscriptions)}`);
              if ('errorCb' in sub) {
                sub.errorCb(err.m);
              }
            }
          }
          this.onError?.(err.m);
        }
          break;
        case MessageType.PING_PONG:
          this.sendRaw(data);
          break;
        case MessageType.UNSUBSCRIPTION_DONE:
          // const { id } = json;
          break;
        case MessageType.SWAP_INFO: {
          const baseSwapInfo: SwapInfoBase = {
            swapRequestId: json.S,
            assetIn: json.ai,
            assetOut: json.ao,
            amountIn: json.a,
            amountOut: json.o,
            price: json.p,
            marketPrice: json.mp,
            minAmountOut: json.mao,
            minAmountIn: json.ma,
            path: json.ps,
            exchanges: json.e,
            poolOptimal: json.po,
            ...(json.oi) && {
              orderInfo: {
                pair: json.oi.p,
                side: json.oi.s,
                amount: json.oi.a,
                safePrice: json.oi.sp,
              },
            },
            alternatives: json.as.map((item) => ({
              exchanges: item.e,
              path: item.ps,
              marketAmountOut: item.mo,
              marketAmountIn: item.mi,
              marketPrice: item.mp,
              availableAmountIn: item.aa,
              availableAmountOut: item.aao,
            })),
          };

          switch (json.k) { // kind
            case 'exactSpend':
              this.subscriptions[SubscriptionType.SWAP_SUBSCRIBE]?.[json.S]?.callback({
                kind: json.k,
                marketAmountOut: json.mo,
                availableAmountIn: json.aa,
                ...baseSwapInfo,
              });

              break;
            case 'exactReceive':
              this.subscriptions[SubscriptionType.SWAP_SUBSCRIBE]?.[json.S]?.callback({
                kind: json.k,
                ...baseSwapInfo,
                marketAmountIn: json.mi,
                availableAmountOut: json.aao,
              });
              break;
            default:
              break;
          }
        }
          break;
        case MessageType.FUTURES_TRADE_INFO_UPDATE:
          this.subscriptions[SubscriptionType.FUTURES_TRADE_INFO_SUBSCRIBE]?.[json.id]?.callback({
            futuresTradeRequestId: json.id,
            sender: json.S,
            instrument: json.i,
            buyPrice: json.bp,
            sellPrice: json.sp,
            buyPower: json.bpw,
            sellPower: json.spw,
            minAmount: json.ma,
          });
          break;
        case MessageType.INITIALIZATION:
          this.onInit?.();
          break;
        case MessageType.AGGREGATED_ORDER_BOOK_UPDATE: {
          const { ob, S } = json;
          const mapOrderbookItems = (rawItems: typeof ob.a | typeof ob.b) => rawItems.reduce<OrderbookItem[]>((acc, item) => {
            const [
              price,
              amount,
              exchanges,
              vob,
            ] = item;

            acc.push({
              price,
              amount,
              exchanges,
              vob: vob.map(([side, pairName]) => ({
                side,
                pairName,
              })),
            });

            return acc;
          }, []);
          this.subscriptions[
            SubscriptionType.AGGREGATED_ORDER_BOOK_UPDATES_SUBSCRIBE
          ]?.[json.S]?.callback(
            mapOrderbookItems(ob.a),
            mapOrderbookItems(ob.b),
            S,
          );
        }
          break;
        case MessageType.ASSET_PAIR_CONFIG_UPDATE: {
          const pair = json.u;
          const [, minQty, pricePrecision] = pair;

          this.subscriptions[
            SubscriptionType.ASSET_PAIR_CONFIG_UPDATES_SUBSCRIBE
          ]?.[json.id]?.callback({
            data: {
              minQty,
              pricePrecision,
            },
            kind: json.k === 'i' ? 'initial' : 'update',
          });

          break;
        }
        case MessageType.ASSET_PAIRS_CONFIG_UPDATE: {
          const pairs = json;
          const priceUpdates: Partial<Record<string, AssetPairUpdate>> = {};

          pairs.u.forEach(([pairName, minQty, pricePrecision]) => {
            priceUpdates[pairName] = {
              minQty,
              pricePrecision,
            };
          });

          this.subscriptions[
            SubscriptionType.ASSET_PAIRS_CONFIG_UPDATES_SUBSCRIBE
          ]?.['default']?.callback({
            kind: json.k === 'i' ? 'initial' : 'update',
            data: priceUpdates,
          });
        }
          break;
        case MessageType.CFD_ADDRESS_UPDATE:
          switch (json.k) { // message kind
            case 'i': { // initial
              const fullOrders = (json.o)
                ? json.o.reduce<Array<z.infer<typeof fullOrderSchema>>>((prev, o) => {
                  prev.push(o);

                  return prev;
                }, [])
                : undefined;

              this.subscriptions[
                SubscriptionType.CFD_ADDRESS_UPDATES_SUBSCRIBE
              ]?.[json.id]?.callback({
                kind: 'initial',
                orders: fullOrders,
                balances: json.b,
              });
            }
              break;
            case 'u': { // update
              let orderUpdate: z.infer<typeof orderUpdateSchema> | z.infer<typeof fullOrderSchema> | undefined;
              if (json.o) {
                const firstOrder = json.o[0];
                orderUpdate = firstOrder;
              }

              this.subscriptions[
                SubscriptionType.CFD_ADDRESS_UPDATES_SUBSCRIBE
              ]?.[json.id]?.callback({
                kind: 'update',
                order: orderUpdate,
                balances: json.b,
              });
            }
              break;
            default:
              break;
          }
          break;
        case MessageType.ADDRESS_UPDATE: {
          const balances = (json.b)
            ? Object.entries(json.b)
              .reduce<Partial<Record<string, Balance>>>((prev, [asset, assetBalances]) => {
                if (!assetBalances) return prev;
                const [tradable, reserved, contract, wallet, allowance] = assetBalances;

                prev[asset] = {
                  tradable, reserved, contract, wallet, allowance,
                };

                return prev;
              }, {})
            : {};
          switch (json.k) { // message kind
            case 'i': { // initial
              const fullOrders = json.o
                ? json.o.reduce<Array<z.infer<typeof fullOrderSchema>>>((prev, o) => {
                  prev.push(o);

                  return prev;
                }, [])
                : undefined;

              this.subscriptions[
                SubscriptionType.ADDRESS_UPDATES_SUBSCRIBE
              ]?.[json.id]?.callback({
                kind: 'initial',
                orders: fullOrders,
                balances,
              });
            }
              break;
            case 'u': { // update
              let orderUpdate: z.infer<typeof orderUpdateSchema> | z.infer<typeof fullOrderSchema> | undefined;
              if (json.o) {
                const firstOrder = json.o[0];
                orderUpdate = firstOrder;
              }

              this.subscriptions[
                SubscriptionType.ADDRESS_UPDATES_SUBSCRIBE
              ]?.[json.id]?.callback({
                kind: 'update',
                order: orderUpdate,
                balances,
              });
            }
              break;
            default:
              break;
          }
        }
          break;
        case MessageType.BROKER_TRADABLE_ATOMIC_SWAP_ASSETS_BALANCE_UPDATE: {
          const brokerBalances: Partial<Record<string, number>> = {};

          json.bb.forEach(([asset, balance]) => {
            brokerBalances[asset] = balance;
          });

          this.subscriptions[
            SubscriptionType.BROKER_TRADABLE_ATOMIC_SWAP_ASSETS_BALANCE_UPDATES_SUBSCRIBE
          ]?.['default']?.callback(brokerBalances);
        }
          break;
        default:
          break;
      }
    };
  }
}

export * as schemas from './schemas/index.js';
export {
  AggregatorWS,
  SubscriptionType,
  UnsubscriptionType,
  MessageType,
};
