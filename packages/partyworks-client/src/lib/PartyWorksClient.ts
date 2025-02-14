import type {
  PartySocketConnectionState,
  PartySocketOptions,
  PartySocketStatus,
} from "partyworks-socket";
import { PartySocket } from "partyworks-socket";
import {
  SingleEventSource,
  type UnsubscribeListener,
  PartyworksEvents,
} from "partyworks-shared";
import { ImmutableObject } from "../immutables/ImmutableObject";
import { DEFAULT_LOSTCONNECTION_TIMEOUT, type Peer, type Self } from "../types";
import { ImmutablePeers } from "../immutables/ImmutableOthers";
import { PartyWorksEventSource } from "./EventSource";
import { v4 as uuid } from "uuid";
import { MessageBuilder } from "./MessageBuilder";

type EmitAwaiOptions = {
  listenEvent?: string;

  maxTime?: number; //max time to await for a response, defaults to 5000

  //* below are the configurable props so it can be handled by the user choice
  //TODO use these eventually when we have status, and buffer queues
  behaviourOnDisconnect: "queue" | "fail" | "noop" | "continue";
  failOnDisconnect?: boolean;
  noopOnDisonnect?: boolean;
  shouldQueue?: boolean;
};

type OthersEvent<TPresence, TUserMeta> =
  | { type: "set" } //this event is when the ROOM_STATE is recieved and peers are populated
  | { type: "enter"; other: Peer<TPresence, TUserMeta> }
  | { type: "leave"; other: Peer<TPresence, TUserMeta> }
  | {
      type: "presenceUpdate";
      updates: Partial<TPresence>;
      other: Peer<TPresence, TUserMeta>;
    }
  | {
      type: "metaUpdate";
      updates: Partial<TUserMeta>;
      other: Peer<TPresence, TUserMeta>;
    };

type Subscribe<T> = (data: T) => void;

type RoomEventSubscriberMap<TPresence, TUserMeta, TBroadcastEvent> = {
  allMessages: Subscribe<MessageEvent<any>>;
  message: Subscribe<MessageEvent<any>>;
  others: Subscribe<{
    others: Peer<TPresence, TUserMeta>[];
    event: OthersEvent<TPresence, TUserMeta>;
  }>;
  self: Subscribe<Self<TPresence, TUserMeta>>; //todo maybe make this an update type like other 'presenceUpdated' | 'metaUpdated'
  myPresence: Subscribe<TPresence>;
  event: Subscribe<
    RoomBroadcastEventListener<TPresence, TUserMeta, TBroadcastEvent>
  >;
  //todo improve on typescript, atleast the ability to add a generic and override the values should be there
  error: Subscribe<{ error: any; event?: string }>;

  status: Subscribe<PartySocketStatus>;
  lostConnection: Subscribe<LostConnectionStatus>;
};

//i think for the internal events we can have rpc based format, but custom events can be tricky the ones that don't follow req/res format
type PartyworksEventsMap =
  | {
      event: PartyworksEvents.ROOM_STATE;
      data: {
        self: {
          info: any; //this is TUserMeta
          data: { id: string };
        };
        users: Peer[];
      };
    }
  | {
      event: PartyworksEvents.USER_JOINED;
      data: { userId: string; info: any; presence: any };
    }
  | { event: PartyworksEvents.USER_LEFT; data: { userId: string } }
  | {
      event: PartyworksEvents.PRESENSE_UPDATE;
      data: { userId: string; data: any };
    }
  | {
      event: PartyworksEvents.USERMETA_UPDATE;
      data: { userId: string; data: any };
    }
  | {
      event: PartyworksEvents.BROADCAST;
      data: { data: any; userId: string };
    };

type UpdateMyPresence<TPresence> = {
  (data: Partial<TPresence>, type?: "partial"): void;
  (data: TPresence, type: "set"): void;
};

export interface RoomBroadcastEventListener<
  TPresence,
  TUserMeta,
  TBroadcastEvent
> {
  data: TBroadcastEvent;
  user: Peer<TPresence, TUserMeta> | null;
  userId: string;
}

export type LostConnectionStatus = "lost" | "failed" | "restored";

export interface PartyWorksRoomOptions extends PartySocketOptions {
  lostConnectionTimeout?: number;
}

export class PartyWorksRoom<
  TPresence = any,
  TUserMeta = any,
  TBroadcastEvent = any,
  TEvents extends Record<string, any> = {},
  TEventsEmit = any //this should be for emitting the event
> extends PartyWorksEventSource<TEvents> {
  private _id: string;
  private _partySocket: PartySocket;
  private _loaded: boolean = false; //we count that we're still connecting if this is not laoded yet
  private _self?: ImmutableObject<Self<TPresence, TUserMeta>>; //not sure how to structure this one?
  private _peers: ImmutablePeers<TPresence, TUserMeta>;
  private _lostConnection: {
    lostConnectionTimeout?: ReturnType<typeof setTimeout>; //timeout for when a connection is lost
    didLoseConnection: boolean;
  } = { didLoseConnection: false };

  private ridListeners = new SingleEventSource<
    Readonly<TEvents[keyof TEvents]>
  >(); //another EventSource just for ridListeners

  public eventHub: {
    allMessages: SingleEventSource<MessageEvent<any>>; //for all the messages, servers as socket.addEventlistener("message")
    message: SingleEventSource<MessageEvent<any>>; //for all but internal messages, internal ones will be ignored, most likely user's use this one
    others: SingleEventSource<{
      others: Peer<TPresence, TUserMeta>[];
      event: OthersEvent<TPresence, TUserMeta>;
    }>; //others/peers in the room
    self: SingleEventSource<Self<TPresence, TUserMeta>>; //self
    myPresence: SingleEventSource<TPresence>; //a local my presence
    event: SingleEventSource<
      RoomBroadcastEventListener<TPresence, TUserMeta, TBroadcastEvent>
    >; //this is for broadcast api
    error: SingleEventSource<{ error: any; event?: string }>; //this is for event & non event based errors
    status: SingleEventSource<PartySocketConnectionState>;
    lostConnection: SingleEventSource<LostConnectionStatus>;
  };

  constructor(private options: PartyWorksRoomOptions) {
    super();

    this._id = options.room;
    this.options.lostConnectionTimeout =
      this.options.lostConnectionTimeout ?? DEFAULT_LOSTCONNECTION_TIMEOUT;

    //we will start closed
    this._partySocket = new PartySocket({
      ...options,
    });

    this._partySocket.eventHub.status.subscribe(this.handleLostConnection);

    this.eventHub = {
      allMessages: new SingleEventSource(),
      message: new SingleEventSource(),
      others: new SingleEventSource(),
      self: new SingleEventSource(),
      myPresence: new SingleEventSource(),
      event: new SingleEventSource(),
      error: new SingleEventSource(),
      status: this._partySocket.eventHub.status,
      lostConnection: new SingleEventSource(),
    };
    this._message();
    this._peers = new ImmutablePeers();
  }

  get id() {
    return this._id;
  }

  connect() {
    if (!this._partySocket.started) {
      this._partySocket.start();
    } else {
      this._partySocket.reconnect();
    }
    //TODO implement a proper connection state, and use it for tracking states &  bufffering
    // this._partySocket.eventHub.status.subscribe((status) => {
    //   console.log(`socket status ${this._partySocket.getStatus()} [${status}]`);
    // });
  }

  disConnect() {
    this._partySocket.close();
  }

  _message() {
    this._partySocket.eventHub.messages.subscribe((e) => {
      //this handler is always called, as it is a basic all message event handler
      this.eventHub.allMessages.notify(e);

      try {
        const parsedData = JSON.parse(e.data);

        if (
          !parsedData ||
          (typeof parsedData.event === "undefined" &&
            typeof parsedData.error === "undefined" &&
            typeof parsedData.rid === "undefined")
        ) {
          //   this should never happen
          console.error(`No event field in the response from websocket`);
          //notify when event is not there
          this.eventHub.message.notify(e);
          return;
        }

        //differentiating internal events from external ones

        //these are internal events
        if (
          Object.values(PartyworksEvents).includes(
            parsedData.event as PartyworksEvents
          ) &&
          //internal flag checker, used to track internal messages
          parsedData._pwf === "-1"
        ) {
          const data = parsedData as PartyworksEventsMap;

          switch (data.event) {
            //ok so initially i was going with two events connenct & room_state. (this is the same setup for funrooms)
            //but for ease and simplicity that'll be the same message now
            case PartyworksEvents.ROOM_STATE: {
              this._loaded = true;
              this._self = new ImmutableObject<Self>({
                data: {
                  id: this._partySocket.id,
                  // _pkUrl: this._partySocket._pkurl,
                },
                info: data.data.self.info, //this is provided by the user on backend
                presence: undefined,
              });

              const usersWithoutSelf = data.data.users.filter(
                (user) => user.userId !== this._self?.current.data.id
              );
              this._peers.addPeers(usersWithoutSelf);
              this.eventHub.others.notify({
                others: this._peers.current,
                event: { type: "set" },
              });
              this.eventHub.self.notify(this._self.current);
              break;
            }

            case PartyworksEvents.USER_JOINED: {
              const peer = this._peers.addPeer(data.data as any);

              this.eventHub.others.notify({
                others: this._peers.current,
                event: { type: "enter", other: peer },
              });
              break;
            }

            case PartyworksEvents.USER_LEFT: {
              const peer = this._peers.disconnectPeer(data.data.userId);

              if (peer) {
                this.eventHub.others.notify({
                  others: this._peers.current,
                  event: { type: "leave", other: peer },
                });
              }

              break;
            }

            case PartyworksEvents.PRESENSE_UPDATE: {
              if (data.data.userId === this._self?.current.data.id) {
                this._self.partialSet("presence", data.data.data);
                this.eventHub.self.notify(this._self.current);
                this.eventHub.myPresence.notify(this._self?.current.presence!);

                return;
              }

              const peer = this._peers.updatePeer(data.data.userId, {
                presence: data.data.data,
              });
              if (peer)
                this.eventHub.others.notify({
                  others: this._peers.current,
                  event: {
                    type: "presenceUpdate",
                    updates: data.data.data,
                    other: peer,
                  },
                });
              break;
            }

            case PartyworksEvents.USERMETA_UPDATE: {
              if (data.data.userId === this._self?.current.data.id) {
                this._self.partialSet("info", data.data.data);
                this.eventHub.self.notify(this._self.current);
                return;
              }

              const peer = this._peers.updatePeer(data.data.userId, {
                info: data.data.data,
              });
              if (peer)
                this.eventHub.others.notify({
                  others: this._peers.current,
                  event: {
                    type: "metaUpdate",
                    updates: data.data.data,
                    other: peer,
                  },
                });

              break;
            }

            case PartyworksEvents.BROADCAST: {
              this.eventHub.event.notify({
                data: data.data.data,
                userId: data.data.userId,
                user:
                  this._peers.current.find(
                    (user) => user.userId === data.data.userId
                  ) || null,
              });
              break;
            }

            default: {
              console.error(`unknown evemt`);
            }
          }
          return;
        }

        //notify the listener
        this.eventHub.message.notify(e);

        //ok new logic let's diff events & errors
        if (parsedData.error) {
          if (parsedData.rid) {
            if (parsedData.options?.sendToAllListeners) {
              //here broadcast to everyone and also broadcast to rid listeners

              this.ridListeners.notify(parsedData);
              this.eventHub.error.notify(parsedData);
            } else {
              //only broadcast to rid listeners

              this.ridListeners.notify(parsedData);
            }
          } else {
            //no rid broadcast to everyone except ridListeners, a normal es event
            this.eventHub.error.notify(parsedData);
          }

          return;
        }

        //now we're here that means this is not an error for sure
        if (parsedData.rid) {
          if (parsedData.options?.sendToAllListeners) {
            //here do the exec to everyone.
            //including the rid listerners
            this.ridListeners.notify(parsedData);

            if (!this.events[parsedData.event]) {
              return;
            }

            for (let cb of this.events[parsedData.event]) {
              cb.exec(parsedData.data);
            }
          } else {
            //only broadcast to the rid listeners
            this.ridListeners.notify(parsedData);
          }
        } else {
          //this is a normal message just do a normal exec
          if (!this.events[parsedData.event]) {
            return;
          }

          for (let cb of this.events[parsedData.event]) {
            cb.exec(parsedData.data);
          }
        }
      } catch (error) {
        //notify when data is not parsable
        this.eventHub.message.notify(e);
      }
    });
  }

  updatePresence: UpdateMyPresence<TPresence> = (
    data: TPresence | Partial<TPresence>,
    type: "partial" | "set" = "partial"
  ): void => {
    //todo make sure the self is always there? for presence updates locally.
    //it can be left in a non ack state, where we don't consider it acked yet
    //ok anyways revise this

    if (this._self) {
      if (type === "partial") {
        this._self?.partialSet("presence", data);
      } else {
        this._self?.set({ presence: data as TPresence });
      }
      this.eventHub.myPresence.notify(this._self?.current.presence!);
      this.eventHub.self.notify(this._self.current!);
      this._partySocket.send(
        JSON.stringify(
          MessageBuilder.updatePresenceMessage({ data, type }),
          (k, v) => (v === undefined ? null : v) //we replace undefined with null, since stringify removes undefined props
        )
      );
    }
  };

  broadcast = (data: TBroadcastEvent) => {
    this._partySocket.send(
      JSON.stringify(MessageBuilder.broadcastMessage(data))
    );
  };

  emit<K extends keyof TEventsEmit>(event: K, data: TEventsEmit[K]): void {
    const dataToSend = JSON.stringify(MessageBuilder.emitMessage(event, data));
    this._partySocket.send(dataToSend);
  }

  emitAwait<K extends keyof TEventsEmit = keyof TEventsEmit>(
    {
      event,
      data,
    }: {
      event: K;
      data: TEventsEmit[K];
    },
    options?: EmitAwaiOptions
  ): Promise<
    K extends keyof TEvents ? TEvents[Extract<K, keyof TEvents>] : unknown
  >;
  emitAwait<D, K extends keyof TEventsEmit = keyof TEventsEmit>(
    { event, data }: { event: K; data: TEventsEmit[K] },
    options?: EmitAwaiOptions
  ): Promise<D>;
  emitAwait<D, K extends keyof TEventsEmit>(
    { event, data }: { event: K; data: TEventsEmit[K] },
    options?: EmitAwaiOptions
  ): Promise<D> {
    return new Promise((resolve, reject) => {
      const requestId = uuid();

      //todo we can use this to make sure event prop exist on response, else ignore
      const listenEvent = (options?.listenEvent || event) as keyof TEvents;

      const unsub = this.ridListeners.subscribe((data) => {
        const responseId = data.rid;

        if (!responseId || responseId !== requestId) return;

        if (data.error) reject(data.error);

        clearTimeout(timeout);
        unsub();
        resolve(data.data);
      });

      const timeout = setTimeout(() => {
        unsub();
        reject(`no message recieved`);
      }, 5000);

      try {
        const stringifiedObjectResponse = JSON.stringify(
          MessageBuilder.emitAwaitMessage({ event, data, rid: requestId })
        );

        this._partySocket.send(stringifiedObjectResponse);
        console.log(`[ Sent ${event as string} ]`);
      } catch (error) {
        clearTimeout(timeout);
        unsub();
        reject(error);
      }
    });
  }

  //todo refactor
  handleLostConnection = () => {
    const status = this._partySocket.getStatus();

    if (status === "connected") {
      clearTimeout(this._lostConnection.lostConnectionTimeout);
      this._lostConnection.lostConnectionTimeout = undefined;
      if (this._lostConnection.didLoseConnection) {
        this._lostConnection.didLoseConnection = false;
        this.eventHub.lostConnection.notify("restored");
      }
      return;
    }

    if (
      status === "reconnecting" &&
      !this._lostConnection.lostConnectionTimeout
    ) {
      if (!this._lostConnection.didLoseConnection)
        this._lostConnection.lostConnectionTimeout = setTimeout(() => {
          this._lostConnection.didLoseConnection = true;
          this._lostConnection.lostConnectionTimeout = undefined;
          this.eventHub.lostConnection.notify("lost");
        }, this.options.lostConnectionTimeout);

      return;
    }

    if (status === "disconnected") {
      clearTimeout(this._lostConnection.lostConnectionTimeout);
      this._lostConnection.lostConnectionTimeout = undefined;
      this._lostConnection.didLoseConnection = false;
      this.eventHub.lostConnection.notify("failed");
      return;
    }
  };

  getOthers = (): Peer<TPresence, TUserMeta>[] => {
    return this._peers.current;
  };

  getPresence = (): TPresence | undefined => {
    return this._self?.current.presence;
  };

  getStatus = () => {
    const status = this._partySocket.getStatus();
    //! for ssr, if initial is returned, then on client hydration there will be text missmatch
    return status === "initial" ? "connecting" : status;
  };

  subscribe<
    K extends keyof RoomEventSubscriberMap<
      TPresence,
      TUserMeta,
      TBroadcastEvent
    >
  >(
    event: K,
    callback: RoomEventSubscriberMap<TPresence, TUserMeta, TBroadcastEvent>[K]
  ): UnsubscribeListener;
  subscribe<T>(
    event: keyof RoomEventSubscriberMap<TPresence, TUserMeta, TBroadcastEvent>,
    callback: Subscribe<T>
  ): UnsubscribeListener;

  subscribe<T>(
    event: keyof RoomEventSubscriberMap<TPresence, TUserMeta, TBroadcastEvent>,
    callback: Subscribe<T>
  ): UnsubscribeListener {
    switch (event) {
      case "allMessages":
        return this.eventHub.allMessages.subscribe(callback as any);

      case "message":
        return this.eventHub.message.subscribe(callback as any);

      case "error":
        return this.eventHub.error.subscribe(callback as any);

      case "event":
        return this.eventHub.event.subscribe(callback as any);

      case "myPresence":
        return this.eventHub.myPresence.subscribe(callback as any);

      case "others":
        return this.eventHub.others.subscribe(callback as any);

      case "self":
        return this.eventHub.self.subscribe(callback as any);

      case "status":
        return this.eventHub.status.subscribe(callback as any);

      case "lostConnection":
        return this.eventHub.lostConnection.subscribe(callback as any);

      default: {
        //? should we throw
        // console.warn(`Unknown event on room.subsribe ${event}`);
        throw new Error(`Unknown event on room.subsribe ${event}`);
      }
    }
  }

  leave() {
    this._partySocket.stop();
  }

  getSelf = () => {
    return this._self?.current;
  };
}
