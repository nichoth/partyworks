import type * as Party from "partykit/server";
import { PartyworksEvents } from "partyworks-shared";
import { Bot, BotOptions, Player } from "./types";
import { MessageBuilder } from "./MessageBuilder";
import { MessageEvent } from "@cloudflare/workers-types";

type CustomEvents<TEvents, TState> = {
  [K in keyof Partial<TEvents>]: {
    middlewares?: any; //? maybe event level middlewares makes sense
    validator?: (data: any) => void;
    handler: (
      value: { rid?: string; data: TEvents[K]; event: string },
      player: Player<TState>
    ) => void;
  };
};

const noop = () => {};

//ok so this pattern is a little bit more strict
//this can be annoying for some users dx wise as they just want typesafety in terms of messages
//this can inversely lead to bad dx and alot of duplicated code in cases that send same messages over different events
//but this is also the best in terms of type safety, lol even event safety
//aaaaghhh dunno, i want this one particularly for my funrooms version tough!
// export abstract class sq<
//   TState = any,
//   TEventsListener extends Record<string, any> = {},
//   TEventEmitters extends Record<
//     keyof TEventsListener,
//     { sends: any; broadcasts: any }
//   > = any,
//   TBroadcasts = any
// > {}

//todo maybe in future we can get more granular
//like having multiple options for send & broadcast on a per event level, that'll likely save many things

//todo remove one of the implementations for player.sendData vs this.send & partyworks.broadcastData vs this.broadcast
//well most likely player.sendData & partyworks.broadcastData are gonna be removed, since they funky :>

//a bot/server user api
//create a bot [likkely on setup]
//connect the bot

export abstract class PartyWorks<
  TState = any,
  TEventsListener extends Record<string, any> = {},
  TEventEmitters extends Record<string, any> = {},
  TBroadcasts extends Record<string, any> = any,
  TPresence = any
> implements Party.Server
{
  readonly partyworks: Party.Party & {
    broadcastData: <K extends keyof TBroadcasts>(
      event: K,
      data: TBroadcasts[K]
    ) => void;
  };

  private players: Player<TState, TEventEmitters, TPresence>[] = [];

  private bots: Bot<TState, TPresence>[] = [];

  private _customEvents: CustomEvents<TEventsListener, TState> =
    {} as CustomEvents<TEventsListener, TState>;

  constructor(readonly party: Party.Party) {
    this.partyworks = party as any;

    //todo remove this, i personally don't like this api, kinda hacky, this.broadcast works fine
    this.partyworks.broadcastData = (event, data) => {
      try {
        const stringifiedData = JSON.stringify({ event, data });

        this.party.broadcast(stringifiedData);
      } catch (error) {
        console.log(`error broadcasting data`);
      }
    };

    //setup custom events and other things, that you want to run in constrcutor
    this.setCustomEvent();
    this.setup();
  }

  //*-----------------------------------
  //* Private Internal Methods, internal lib methods
  //*-----------------------------------

  //checks the correct data format
  //well may not be neccessare since the user can check, still
  private _validatePresenceMessage(data: any) {
    if (!data || !data.type || (data.type !== "partial" && data.type !== "set"))
      return false;

    return true;
  }

  private handleEvents(e: MessageEvent, conn: Player) {
    try {
      const parsedData = JSON.parse(e.data as string);

      //todo, this is how we track internal vs user messages [_pwf flag value to be set "-1" for internal events]
      //todo ok here internal events also mean custom events sent by user via the client's emit or emitAwait
      if (parsedData.event && parsedData._pwf === "-1") {
        switch (parsedData.event) {
          case PartyworksEvents.PRESENSE_UPDATE: {
            if (!this._validatePresenceMessage(parsedData.data)) return;
            if (!this.validatePresence(conn, parsedData.data)) return;

            if (parsedData.data.type === "set") {
              conn.presence = parsedData.data.data;
            } else if (parsedData.data.data) {
              //todo listen for type 'set' | 'partial' fields as well
              //todo implement proper merging, at sub field levels as well
              conn.presence = { ...conn.presence, ...parsedData.data.data };
            }

            //ok maybe here we can do some ack, but presence is fire & forget, dunno :/
            this.party.broadcast(
              JSON.stringify(MessageBuilder.presenceUpdate(conn)),
              [conn.id]
            );
            break;
          }

          case PartyworksEvents.BROADCAST: {
            if (!this.validateBroadcast(conn, parsedData.data)) return;

            this.party.broadcast(
              JSON.stringify(
                MessageBuilder.broadcastEvent(conn, parsedData.data)
              ),
              [conn.id]
            );

            this.bots.forEach((bot) => bot.onBroadcast(conn, parsedData.data));
            break;
          }

          default: {
            //now check for internal custom events

            const eventHandler = this._customEvents[parsedData.event];

            if (eventHandler) {
              try {
                const { validator, handler } = eventHandler;
                if (typeof validator === "function") {
                  //? maybe we're expecting it to throw, or return false
                  validator(parsedData.data);
                }

                //? here also if throws we can handle maybe based on event & rid
                //?ok definitely makes sense to throw an error a default one & perhaps a custom one
                handler(
                  {
                    data: parsedData.data,
                    rid: parsedData.rid,
                    event: parsedData.event,
                  },
                  conn
                );

                return;
              } catch (error) {
                //this should be safe, and should not throw any error, otherwise bad bad bad!
                this.catchAll(error, parsedData, conn);

                return;
              }
            }

            this.notFound(parsedData, conn);
            console.log("unknown event");
            console.log(parsedData);
          }
        }
      }
    } catch (error) {}
  }

  //*-----------------------------------
  //* Userfacing Internal Methods, not to be overriden, sadly typescript does not have final keyword so we can't enforce em yet
  //*-----------------------------------

  getConnectedUsers(options?: { includeBots?: boolean }) {
    if (options && options.includeBots) return [...this.players, ...this.bots];

    return this.players;
  }

  async handleConnect(
    connection: Player<TState, TEventEmitters>,
    ctx: Party.ConnectionContext
  ) {
    this.customDataOnConnect(connection, ctx);
    connection.addEventListener("message", (e) => {
      this.handleEvents(e, connection);
    });

    this.players.push(connection);

    const roomData = this.roomState();

    //todo remove this, this api gives sendData to player/cconnection itself, i feel this.send is a much better and cleaner api
    connection.sendData = <K extends keyof TEventEmitters>(
      event: K,
      data: TEventEmitters[K]
    ) => {
      try {
        const stringifiedData = JSON.stringify({ event, data });

        connection.send(stringifiedData);
      } catch (error) {
        console.log(`error sending data`);
      }
    };

    //send internal connect message & roomState
    // connection.send(JSON.stringify(MessageBuilder.connect(connection, data)));
    connection.send(
      JSON.stringify(
        MessageBuilder.roomState({
          //@ts-ignore , we will sync the info property if defined
          info: connection.state?.info! as any,
          self: connection,
          users: [...this.players, ...this.bots],
          roomData,
        })
      )
    );

    //notify everyone that the user has connected
    this.party.broadcast(
      JSON.stringify(MessageBuilder.userOnline(connection)),
      [connection.id]
    );

    //call the bot handlers
    this.bots.forEach((bot) => bot.onUserJoined(connection));

    this.sendEventOnConnect(connection);
  }

  handleDisconnect(connection: Party.Connection) {
    this.players = this.players.filter((con) => con.id !== connection.id);

    this.party.broadcast(
      JSON.stringify(MessageBuilder.userOffline(connection))
    );

    //call the bot handlers
    this.bots.forEach((bot) => bot.onUserLeft(connection as any));
  }

  handleClose(connection: Party.Connection) {
    this.handleDisconnect(connection);
  }

  handleError(connection: Party.Connection) {
    this.handleDisconnect(connection);
  }

  //typesafe send function
  send<K extends keyof TEventEmitters>(
    connection: Party.Connection,
    data: { event: K; data: TEventEmitters[K] }
  ) {
    try {
      const stringifiedData = JSON.stringify(data);

      connection.send(stringifiedData);
    } catch (error) {
      console.log(`error sending data`);
    }
  }

  //? sendAwait function :/ . huh dunno how we can do anything bout this one
  //todo allow to send eventless messages, since rid is the king, eventListerers will be based on rids for emitAwait rid events
  //huh so we want eventless messages, umm, what should be do about the typescript then
  sendAwait<K extends keyof TEventEmitters>(
    connection: Party.Connection,
    data:
      | { rid: string; event: K; data: TEventEmitters[K] }
      | { rid: string; data?: any; [key: string]: any },
    options?: {
      sendToAllListeners?: boolean; //if true emitted to all listeners listening for that event, not limited to rid event listeners
    }
  ) {
    try {
      const stringifiedData = JSON.stringify({ ...data, options });

      connection.send(stringifiedData);
    } catch (error) {}
  }

  //this sends a client recognized error, event prop is optional
  //event will help in easy error association, or can be used as custom tags on error
  protected sendError<
    T extends keyof TEventsListener,
    K extends keyof TEventEmitters
  >(
    connection: Party.Connection,
    data: { error: any; event?: string | K | T; rid?: string },
    options?: {
      sendToAllListeners?: boolean; //if true emitted to all listeners listening for that event, not limited to rid event listeners
    }
  ): void {
    try {
      const stringifiedData = JSON.stringify({ ...data, options });

      connection.send(stringifiedData);
    } catch (error) {
      console.log(`error sending error`); //lol
    }
  }

  //typesafe broadcast function for the room
  protected /*final*/ broadcast<K extends keyof TBroadcasts>(
    data: { event: K; data: TBroadcasts[K] },
    ignored?: string[]
  ): void {
    try {
      const stringifiedData = JSON.stringify(data);

      this.party.broadcast(stringifiedData, ignored);
    } catch (error) {
      console.log(`error broadcasting data`);
    }
  }

  //ok here we take either a party.connection or a playerid
  //this function will give an api to update a user's presence
  updatePresence(
    conn: Party.Connection,
    data: { presence: Partial<TPresence>; type: "partial" }
  ): void;

  updatePresence(
    conn: Party.Connection,
    data: { presence: TPresence; type: "set" }
  ): void;
  updatePresence(
    conn: Party.Connection,
    {
      presence,
      type,
    }:
      | { presence: Partial<TPresence>; type: "partial" }
      | { presence: TPresence; type: "set" }
  ) {
    const player = conn as Player<any, any, TPresence>; //TYPECASTING :/

    if (type === "set") {
      player.presence = presence;
    } else {
      player.presence = { ...player.presence, ...presence };
    }

    //todo sending only partial updates maybe
    this.party.broadcast(JSON.stringify(MessageBuilder.presenceUpdate(player)));
  }

  //ok how should we approach this
  //we will just broadast the meta update & the users need to make sure they do the setState before hand
  //since the way we do it rn depends on user setting the info property on serializeObject
  //well this is more llike broadcast userMeta at this point :/
  updateUserMeta(conn: Party.Connection) {
    this.party.broadcast(
      JSON.stringify(MessageBuilder.metaUpdate(conn as Player))
    );
  }

  //* bot/server user api
  addBot<T = any>(
    id: string,
    { state, presence }: { state: T; presence: TPresence } & Partial<BotOptions>
  ): boolean;
  addBot(
    id: string,
    {
      state,
      presence,
    }: { state: TState; presence: TPresence } & Partial<BotOptions>
  ): boolean;
  addBot(
    id: string,
    {
      state,
      presence,
      onBroadcast,
      onPresenceUpdate,
      onUserJoined,
      onUserLeft,
    }: { state: TState; presence: TPresence } & Partial<BotOptions>
  ) {
    const existing = this.bots.find((bot) => bot.id === id);

    if (existing) return false;

    const bot: Bot = {
      id,
      state,
      presence,
      onUserJoined: onUserJoined ?? noop,
      onUserLeft: onUserLeft ?? noop,
      onBroadcast: onBroadcast ?? noop,
      onPresenceUpdate: onPresenceUpdate ?? noop,
    };

    this.bots.push(bot);

    //notify everyone that the user has connected
    this.party.broadcast(JSON.stringify(MessageBuilder.userOnline(bot)));

    return true;
  }

  updateBotPresence(
    id: string,
    presence: Partial<TPresence>,
    type?: "partial"
  ): void;
  updateBotPresence(id: string, presence: TPresence, type: "set"): void;
  updateBotPresence(
    id: string,
    presence: Partial<TPresence> | TPresence,
    type: "set" | "partial" = "partial"
  ) {
    const bot = this.bots.find((bot) => bot.id === id);

    //? hmm, should we return a boolean or maybe throw an error ?
    if (!bot) return;

    if (type === "set") {
      bot.presence = presence as TPresence;
    } else {
      bot.presence = { ...bot.presence, ...presence };
    }

    this.party.broadcast(JSON.stringify(MessageBuilder.presenceUpdate(bot)));
  }

  sendBotBroadcast(id: string, data: any, ignore?: string[]) {
    const bot = this.bots.find((bot) => bot.id === id);

    //? hmm, should we return a boolean or maybe throw an error ?
    if (!bot) return;

    this.party.broadcast(
      JSON.stringify(MessageBuilder.broadcastEvent(bot, data)),
      ignore
    );
  }

  //*-----------------------------------
  //* Potential Overriders, these have default functionality but can also be overriden
  //*-----------------------------------

  //so this should have some basic properties, but can be easily ovverriden
  onConnect(
    connection: Party.Connection,
    ctx: Party.ConnectionContext
  ): void | Promise<void> {
    this.handleConnect(connection as Player, ctx);
  }

  onMessage(
    message: string | ArrayBuffer,
    sender: Party.Connection
  ): void | Promise<void> {}

  onClose(connection: Party.Connection): void | Promise<void> {
    this.handleClose(connection);
  }

  onError(connection: Party.Connection, error: Error): void | Promise<void> {
    this.handleError(connection);
  }

  //*-----------------------------------
  //* Overriders, default functionality is noop these are supposed to be overriden by the users
  //*-----------------------------------

  //? this is for getting roomState maybe,
  roomState(): any | Promise<any> {}

  //this is for sending custom
  customDataOnConnect(
    player: Player<TState, TEventEmitters>,
    ctx: Party.ConnectionContext
  ): void {}

  //maybe this is gonna be the custom state on connect
  customRoomState(player: Player<TState, TEventEmitters>): any {}

  //send the event that you want to send on connect here
  sendEventOnConnect(player: Player<TState, TEventEmitters>) {}

  //let's you check for and validate the presenceUpdates for a user
  //you should never throw an error in this one, return a booolean to indicate if this should fail or not fail
  validatePresence(
    player: Player<TState, TEventEmitters, TPresence>,
    data: any //ideally should be {type: "partial" | "set",  data: TPresence | Partial<TPresence>}
  ): boolean {
    return true;
  }

  //let's you checks and validate the broadcast messages
  //you should never throw an error in this one, return a booolean to indicate if this should fail or not fail
  validateBroadcast(
    player: Player<TState, TEventEmitters, TPresence>,
    data: any
  ): boolean {
    return true;
  }

  //these are run in the constructor, for those who don't wanna do the constructor super thing in child class
  setup() {}
  setCustomEvent() {}

  //sets the custom events
  customEvents(data: CustomEvents<TEventsListener, TState>) {
    this._customEvents = data;
  }

  //this will send all your custom events related errors, for both handlers & validators
  catchAll(
    error: any,
    {}: { data: any; rid: any; event: any }, //todo this can be any, in case of unknown events maybe we throw 404 instead :/
    player: Party.Connection
  ) {}

  //this handle notfound events, this should be overridden by the user, default is noop
  notFound(parsedData: any, player: Party.Connection) {}

  //todo maybe adding a global middleware kinda setup for custom events
  globalMiddlewares() {}
}
