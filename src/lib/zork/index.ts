/// <reference path='../../../third_party/wrtc/wrtc.d.ts' />

/*
 * Pure Node implementation of Zork for uProxy Cloud Servers.
 * Rough lifecycle is to process single word commands such as "ping" until
 * "give" or "get" is received, at which point an RTC proxy session is
 * established and further input is treated as signaling channel messages.
 *
 *
 * If a "get" command is received, we start a local SOCKS server, send an RTC
 * offer to establish an RTC connection with the remote peer we'll be getting
 * access from, and set things up to pipe data between our local SOCKS server
 * and the peer connection.
 * As the getter, we are the one that creates the offer, as well as all RTC
 * datachannels. This includes a heartbeat datachannel which is required to
 * bootstrap the connection and demonstrate it's still alive, as well as a
 * datachannel for each SOCKS connection which actually forwards proxy data.
 *
 *
 * If a "give" command is received, we wait for an RTC offer from the getter,
 * and then send our answer (see handleSignaling below). Once an RTC connection
 * is established, we wait for the getter to create datachannels with us.
 * Each datachannel is created by the getter when they get a connection to
 * their local SOCKS server. When we detect a getter-initiated datachannel,
 * we create a SocksSession for it and set it up to forward data between the
 * Internet and the datachannel.
 *
 *
 * Note: Zork can be giving to one or more clients at the same time it is
 * getting from one or more clients. Each Zork session is independent.
 */


// TODO list summary:
// - Make sure numGetters logic can track getters with legacy clients.
// - Use any specified `transform` settings once they are supported.
//   Currently we stash them in the context but then ignore them.
// - Make sure there are no resource leaks (see "cleanup" TODO's below)
// - Factor out logic duplicated in ../socks/bin/webrtc.ts
// - Refactor SocksPiece to reduce callback inversion?
// - Replace console log calls with something more structured?
// - Do error states ever need to be indicated to clients rather than
//   just logged locally?


import * as net from 'net';
import {MESSAGE_VERSION} from '../../generic_core/constants';
import {NodeSocksServer as SocksServer} from '../socks/node/server';
import {NodeForwardingSocket as ForwardingSocket} from '../socks/node/socket';
import {SocksSession, State} from '../socks/session';
import {RTCPeerConnection} from 'wrtc';
import * as socks_headers from '../socks/headers';


// The delimiter for Zork messages is just \n, but we use \r?\n for
// MSG_DELIM_RE so that \r\n sent by e.g. a telnet client will also be treated
// as a delimiter. https://en.wikipedia.org/wiki/Robustness_principle
// "Be conservative in what you send, be liberal in what you accept."
const MSG_DELIM = '\n';
const MSG_DELIM_RE = /\r?\n/;

const ZORK_PORT_DEFAULT = 9000;
const ZORK_PORT = Number(process.argv[2] || ZORK_PORT_DEFAULT);
const SOCKS_HOST = '0.0.0.0';
const SOCKS_PORT_DEFAULT = 9999;
const SOCKS_PORT = Number(process.argv[3] || SOCKS_PORT_DEFAULT);
if (isNaN(ZORK_PORT) || isNaN(SOCKS_PORT)) {
  console.error(`Usage: ${process.argv[0]} ${process.argv[1]} [ZORK_PORT] [SOCKS_PORT]`);
  process.exit(1);
}
let startedSocksServer = false;  // ever started any local SOCKS server
let numZorkConnections = 0;  // ever made (as opposed to currently active)
let numGetters = 0;  // currently active (not ever)
const HEARTBEAT_CHANNEL_ID = 'HEARTBEAT';
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 15000;
const HEARTBEAT_MSG = 'heartbeat';
const PAUSE_FWD_SOCK_ON_BUFFERED_NUMBYTES = 500000;  // 500K high water mark
const RESUME_FWD_SOCK_ON_BUFFERED_NUMBYTES = 500000;  // 500K low water mark
const CHECK_BUFF_TO_RESUME_FWD_SOCK_INTERVAL_MS = 50;
const RTC_PEER_CONFIG = {
  iceServers: [
    {url: 'stun:stun.l.google.com:19302'},
    {url: 'stun:stun1.l.google.com:19302'},
    {url: 'stun:stun.services.mozilla.com'}
  ]
};

type Mode = 'give' | 'get';

interface RTCState {
  conn: any;
  remoteReceived: boolean;
  pendingCandidates: any[];
}

interface Context {
  clientId: string;
  legacy: boolean;  // Are we speaking with a legacy uProxy client?
  socket: net.Socket;  // Connection to the zork client. Becomes the signaling channel.
  reply: (msg: string) => void;  // Helper function to reply to the client.
  log: any;  // Helper function for contextual logging.
  mode: Mode;  // null indicates still waiting for a 'give' or 'get' command
  rtc: RTCState;
  // Only used when we're the giver:
  onHeartbeatTimeout: Function;
  heartbeatTimeoutId: number;
  transformer: any;
  socksSessionByChannelId: {[id: string]: any};
}

interface ParsedCmd {
  verb: string;      // e.g. 'ping', 'give', 'get', 'transform', etc.
  source: string;    // e.g. 'transform with caesar'
  tokens: string[];  // e.g. ['transform', 'with', 'caesar']
}


// Command handlers:

const handleCmdInvalid = (ctx: Context, cmd: ParsedCmd) => {
  ctx.reply(`I don't understand that command. (${cmd.verb})`);
};

const handleCmdPing = (ctx: Context) => {
  ctx.reply(`ping`);
};

const handleCmdXyzzy = (ctx: Context) => {
  ctx.reply(`Nothing happens.`);
};

const handleCmdVersion = (ctx: Context) => {
  ctx.reply(`${MESSAGE_VERSION}`);
};

const handleCmdQuit = (ctx: Context) => {
  ctx.socket.end();
};

const handleCmdGetters = (ctx: Context) => {
  ctx.reply(`${numGetters}`);
};

const handleCmdTransform = (ctx: Context, cmd: ParsedCmd) => {
  // TODO: change protocol to acknowledge when processing was successful?
  const t1 = cmd.tokens[1];
  if (t1 === 'with') {
    ctx.transformer = {name: cmd.tokens[2]};
  } else if (t1 === 'config') {
    const idx = cmd.source.indexOf(' config ') + ' config '.length;
    const config = cmd.source.substring(idx);
    ctx.transformer = {config: config};
  } else {
    ctx.reply(`usage: transform (with name|config json)`);
  }
};

const handleCmdGive = (ctx: Context) => {
  ctx.mode = 'give';
  ctx.log(`set mode to "give"`);
  initOnHeartbeatTimeout(ctx);
  initPeerConnection(ctx);
};

const handleCmdGet = (ctx: Context) => {
  ctx.mode = 'get';
  ctx.log('set mode to "get"');

  initSocksServer(ctx);
  initPeerConnection(ctx);

  // RTC connection stalls if no datachannel created before creating the offer,
  // so we need to create a datachannel before creating the offer to bootstrap
  // the connection. Use the heartbeat data channel for this purpose.
  const heartbeatChannel = ctx.rtc.conn.createDataChannel(HEARTBEAT_CHANNEL_ID);
  setInterval(() => heartbeatChannel.send(HEARTBEAT_MSG), HEARTBEAT_INTERVAL_MS);

  // Getter is offerer.
  ctx.rtc.conn.createOffer((offer: any) => {
    ctx.rtc.conn.setLocalDescription(offer);
    const json = JSON.stringify(offer);
    ctx.log(`forwarding offer: ${json}`);
    ctx.reply(json);
  }, ctx.log.error);
};

// End command handlers. Add them to cmdHandlerByVerb map:
const cmdHandlerByVerb: {[verb: string]: (ctx: Context, cmd?: ParsedCmd) => void} = {
  'ping': handleCmdPing,
  'xyzzy': handleCmdXyzzy,
  'version': handleCmdVersion,
  'quit': handleCmdQuit,
  'getters': handleCmdGetters,
  'transform': handleCmdTransform,
  'give': handleCmdGive,
  'get': handleCmdGet
};


// Helper functions for RTC and proxy session establishment:

const initOnHeartbeatTimeout = (ctx: Context) => {
  ctx.onHeartbeatTimeout = () => {
    ctx.log(`${HEARTBEAT_TIMEOUT_MS / 1000}s elapsed with no heartbeat`);
    // TODO: do something here to forcibly end this RTC connection?
    numGetters--;
    ctx.log(`decremented numGetters to ${numGetters}`);
    if (numGetters < 0) {  // should not get here === famous last words
      numGetters = 0;
      ctx.log.error(`numGetters < 0; reset to 0.`);
    }
  };
};

const initPeerConnection = (ctx: Context) => {
  const conn = ctx.rtc.conn = new RTCPeerConnection(RTC_PEER_CONFIG);
  conn.onicecandidate = (event: any) => {
    if (ctx.legacy) {
      event = {signals: {PLAIN: [{type: 2, candidate: event.candidate}]}};
    }
    const json = JSON.stringify(event);
    ctx.log(`candidate: ${json}`);
    ctx.reply(json);
  };
  conn.ondatachannel = (event: any) => handleDataChannel(ctx, event.channel);
  conn.onsignalingstatechange = (event: any) => ctx.log(`signaling state change: ${ctx.rtc.conn.signalingState}`);
  conn.onicegatheringstatechange = (event: any) => ctx.log(`ice gathering state change: ${ctx.rtc.conn.iceGatheringState}`);
  conn.oniceconnectionstatechange = (event: any) => ctx.log(`ice connection state change: ${ctx.rtc.conn.iceConnectionState}`);
};

const initSocksServer = (ctx: Context) => {
  // If we've already started a local SOCKS server running on SOCKS_PORT,
  // use 0 for the port so the OS assigns us a free port.
  const tryPort = startedSocksServer ? 0 : SOCKS_PORT;
  ctx.log(`starting local SOCKS server on port ${tryPort ? tryPort : '[TBD]'}`);
  const server = new SocksServer(SOCKS_HOST, tryPort);
  server.onConnection((sessionId) => handleSocksConnection(ctx, sessionId));
  server.listen().then(() => {
    startedSocksServer = true;
    const boundPort = server.address().port;  // in case OS assigned
    ctx.log(`[socksServer] listening on ${SOCKS_HOST}:${boundPort}`);
    ctx.log(`[socksServer] Test with e.g. curl -x socks5h://${SOCKS_HOST}:${boundPort} httpbin.org/ip`);
  });
};

const handleDataChannel = (ctx: Context, channel: any) => {
  const channelId = channel.label;
  ctx.log(`handleDataChannel: [channel ${channelId}] [channel.readyState ${channel.readyState}]`);

  channel.onopen = () => ctx.log(`[channel ${channelId}] datachannel opened`);
  channel.onclose = () => ctx.log(`[channel ${channelId}] datachannel closed`);
  channel.onerror = (err: any) => ctx.log.error(`[channel ${channelId}] datachannel error: ${err}`);

  if (ctx.mode === 'get') {
    handleGiverCreatedDataChannel(ctx, channel);
    return;
  }
  // Got here -> we're the giver.

  if (channelId === HEARTBEAT_CHANNEL_ID) {
    handleHeartbeatDataChannel(ctx, channel);
    return;
  }

  // Got here -> we're the giver, and this is a non-heartbeat datachannel.
  handleProxyDataChannel(ctx, channel);
};

const handleProxyDataChannel = (ctx: Context, channel: any) => {
  // Initialize a SOCKS session for this datachannel, and set its onmessage
  // handler so that it forwards data for the SOCKS session.
  initSocksSessionAndFwdSocket(ctx, channel);

  channel.onmessage = (event: any) => {
    let bytesForSession = event.data;
    const legacyMessage = typeof event.data === 'string';  // only legacy clients send string messages.
    if (legacyMessage) {
      bytesForSession = handleLegacyMessage(ctx, channel, event.data);
      if (!bytesForSession) {
        return;
      }
    }
    const session = ctx.socksSessionByChannelId[channel.label];
    if (session) {
      session.handleDataFromSocksClient(bytesForSession);
    } else {
      throw new Error(`no socksSession found for datachannel ${channel.label}`);
    }
  };
};

const handleLegacyMessage = (ctx: Context, channel: any, msg: any) => {
  if (msg === HEARTBEAT_MSG) {  // done by peerconnection.ts
    channel.send(HEARTBEAT_MSG);
    return null;
  }
  const request = JSON.parse(msg);
  if (request.control) {  // pool.ts
    const command = request.control;
    switch (command) {
      case 'OPEN':
        ctx.log('pool OPEN - resetting session!');
        initSocksSessionAndFwdSocket(ctx, channel);
        break;
      case 'CLOSE':
        ctx.log('ignoring pool CLOSE');
        break;
      default:
        ctx.log.error(`unknown pool command ${command}`);
    }
    return null;
  }
  // pool.ts adds an additional layer of wrapping.
  // The actual message is in a field called data, again encoded as JSON.
  const bytesForSession = socks_headers.composeRequestBuffer(
      <socks_headers.Request>JSON.parse(request.data));
  return bytesForSession;
};

const handleGiverCreatedDataChannel = (ctx: Context, channel: any) => {
  // ondatachannel events don't fire for the peer creating the datachannel.
  // Since the getter is always the one that creates datachannels, a getter
  // doesn't expect any giver-created datachannels, so just closes any onopen.
  channel.onopen = () => {
    channel.close();
    ctx.log.error(`closed unexpected giver-created datachannel`);
  };
};

const handleHeartbeatDataChannel = (ctx: Context, channel: any) => {
  ctx.socket.end();
  ctx.log(`heartbeat datachannel created -> closed zork connection, handoff to RTC complete`);
  numGetters++;
  ctx.log(`incremented numGetters to ${numGetters}`);
  ctx.heartbeatTimeoutId = setTimeout(ctx.onHeartbeatTimeout, HEARTBEAT_TIMEOUT_MS);
  channel.onmessage = (event: any) => {
    //ctx.log(`heartbeat message: "${event.data}"`);
    clearTimeout(ctx.heartbeatTimeoutId);
    ctx.heartbeatTimeoutId = setTimeout(ctx.onHeartbeatTimeout, HEARTBEAT_TIMEOUT_MS);
  };
};

const handleSocksConnection = (ctx: Context, sessionId: any) => {
  ctx.log(`[socksServer] new connection: ${sessionId}`);
  const channel = ctx.rtc.conn.createDataChannel(sessionId);
  return {
    // SOCKS client -> datachannel
    handleDataFromSocksClient: (bytes: ArrayBuffer) => channel.send(bytes),
    // SOCKS client <- datachannel
    onDataForSocksClient: (callback: (buffer: ArrayBuffer) => void) => {
      channel.onmessage = (event: any) => callback(event.data);
      return this;
    },
    handleDisconnect: () => {
      // Don't close the datachannel here; getters are responsible for
      // creating and closing datachannels. Legacy getters may recycle used
      // datachannels back into a pool. Closing from the give side here results
      // in "'node…' terminated by signal SIGSEGV (Address boundary error)".
      ctx.log(`[socksServer] [session ${sessionId}] client disconnect, closed datachannel`);
    },
    onDisconnect: (callback: () => void) => {
      // This callback calls client.end(), so we ignore it.
      ctx.log(`[socksServer] [session ${sessionId}] client disconnected`);
      return this;
    }
  };
};

const initSocksSessionAndFwdSocket = (ctx: Context, channel: any) => {
  const channelId = channel.label;
  ctx.log(`initSocksSessionAndFwdSocket: channel ${channelId}`);

  const forwardingSocket = new ForwardingSocket();

  const session = new SocksSession(`${ctx.clientId}:${channelId}`,
      ctx.legacy ? State.AWAITING_REQUEST : State.AWAITING_AUTHS);

  ctx.socksSessionByChannelId[channelId] = session;

  session.onForwardingSocketRequired((host: any, port: any) =>
    forwardingSocket.connect(host, port).then(() => forwardingSocket));

  let firstPacket = true;
  session.onDataForSocksClient((bytes: any) => {
    if (ctx.legacy && firstPacket) {
      firstPacket = false;
      const response = socks_headers.interpretResponseBuffer(bytes);
      const data = JSON.stringify(response);
      const json = JSON.stringify({data: data});
      channel.send(json);
      ctx.log('[channel ${channelId}] sent JSON connection response to legacy client');
    } else {
      // datachannel <- SOCKS session
      const numBytesSent = bytes.byteLength;
      channel.send(bytes);
      ctx.log(`[channel ${channelId}] sent ${numBytesSent} bytes`);
    }

    let checkBuffToResumeSockInterval: NodeJS.Timer = null;

    // Resume the forwarding socket when the channel's buffer has drained enough.
    const checkBuffToResumeSock = () => {
      const buffAmnt = channel.bufferedAmount;
      if (buffAmnt < RESUME_FWD_SOCK_ON_BUFFERED_NUMBYTES) {
        forwardingSocket.resume();
        clearInterval(checkBuffToResumeSockInterval);
        checkBuffToResumeSockInterval = null;
        ctx.log(`[channel ${channelId}] bufferedAmount (${buffAmnt}) under low water mark -> resumed forwarding socket`);
      }
    };

    // Pause the forwarding socket when the channel's buffer gets too big (backpressure).
    const buffAmnt = channel.bufferedAmount;
    if (buffAmnt >= PAUSE_FWD_SOCK_ON_BUFFERED_NUMBYTES) {
      forwardingSocket.pause();
      if (!checkBuffToResumeSockInterval) {
        ctx.log(`[channel ${channelId}] bufferedAmount (${buffAmnt}) over high water mark -> paused forwarding socket`);
        checkBuffToResumeSockInterval = setInterval(checkBuffToResumeSock, CHECK_BUFF_TO_RESUME_FWD_SOCK_INTERVAL_MS);
      }
    }

    return this;
  });

  session.onDisconnect(() => ctx.log(`[socksSession ${channelId}] disconnected`));
};

const handleSignaling = (ctx: Context, msg: string) => {
  let data = JSON.parse(msg);

  if (data.signals) {
    ctx.log('legacy client detected');
    ctx.legacy = true;

    // bridge.ts
    if (!('PLAIN' in data.signals)) {
      throw new Error('only support PLAIN signalling');
    }
    const plainMessages = data.signals['PLAIN'];
    if (plainMessages.length !== 1) {
      throw new Error('only support one message per signal');
    }
    data = plainMessages[0];
    // data.type is either 0 (offer) or 2 (ice candidate)
    data = data.type == 0 ? data.description : data;
  }

  if (data.candidate) {
    handleIce(ctx, data.candidate);
  } else if (data.type === 'offer' && data.sdp && ctx.mode === 'give') {
    // Getter is offerer, so giver receives the offer.
    ctx.rtc.remoteReceived = true;
    ctx.log(`got offer: ${msg} -> remoteReceived = true`);
    ctx.rtc.conn.setRemoteDescription(data, () => {
      while (ctx.rtc.pendingCandidates.length) {
        ctx.rtc.conn.addIceCandidate(ctx.rtc.pendingCandidates.shift());
      }
      ctx.rtc.conn.createAnswer((answer: any) => {
        ctx.log(`created answer, setting local description`);
        ctx.rtc.conn.setLocalDescription(answer, () => {
          if (ctx.legacy) {
            answer = {signals: {PLAIN: [{type: 1, description: answer}]}};
          }
          const json = JSON.stringify(answer);
          ctx.log(`forwarding answer: ${json}`);
          ctx.reply(json);
        }, ctx.log.error);
      }, ctx.log.error);
    }, ctx.log.error);
  } else if (data.type === 'answer' && data.sdp && ctx.mode === 'get') {
    // Giver is answerer, so getter receives the answer.
    ctx.rtc.remoteReceived = true;
    ctx.log(`got answer: ${msg} -> remoteReceived = true`);
    ctx.rtc.conn.setRemoteDescription(data);
  } else {
    ctx.log(`handleSignaling: ignoring msg: ${msg}`);
  }
};

const handleIce = (ctx: Context, data: string) => {
  if (ctx.rtc.remoteReceived) {
    ctx.rtc.conn.addIceCandidate(data);
    ctx.log(`handleIce: remoteReceived: added ice candidate`);
  } else {
    ctx.rtc.pendingCandidates.push(data);
    ctx.log(`handleIce: !remoteReceived: added pending ice candidate`);
  }
};


// End RTC/proxy helper functions. Create and start the Zork server:

const zorkServer = net.createServer((client) => {
  const clientId = `zc${numZorkConnections++}`;
  const ctx: Context = {  // Create a context holding the state for this connection
    clientId: clientId,
    legacy: false,
    socket: client,
    reply: makeReplyFunction(client),
    log: null,
    mode: null,
    transformer: null,
    onHeartbeatTimeout: null,
    heartbeatTimeoutId: null,
    socksSessionByChannelId: {},
    rtc: {
      conn: null,
      remoteReceived: false,
      pendingCandidates: []
    }
  };
  ctx.log = makeLogger(ctx);
  ctx.log(`[zorkServer] client connected`);

  let buffer = '';
  client.on('data', (data) => {
    const chunk = data.toString();
    const msgs = chunk.split(MSG_DELIM_RE);
    const msgDelimNotFound = msgs.length === 1;
    if (msgDelimNotFound) {
      buffer += chunk;
      return;
    }
    msgs[0] = buffer + msgs[0];
    buffer = msgs.pop();
    for (let msg of msgs) {
      if (msg) {  // Ignore empty messages.
        handleMsg(ctx, msg);
      }
    }
  });

  client.on('end', () => {
    ctx.log(`[zorkServer] client disconnected`);
    // TODO: any cleanup necessary here to make sure resources allocated
    // for this client will be reclaimed? e.g. need to set `ctx = null` for gc?
  });
}).listen(ZORK_PORT).on('listening', () => console.info('[zorkServer] listening on port', ZORK_PORT));


// Zork server helper functions:

const handleMsg = (ctx: Context, msg: string) => {
  if (ctx.mode === null) {  // Not yet in 'give' or 'get' mode. Treat msg as command.
    const cmd = parseCmd(msg);
    const cmdHandler = cmdHandlerByVerb[cmd.verb] || handleCmdInvalid;
    cmdHandler(ctx, cmd);
  } else {  // Already in 'give' or 'get' mode. Treat msg as signaling.
    handleSignaling(ctx, msg);
  }
};

const parseCmd = (cmdline: string) : ParsedCmd => {
  const tokens = cmdline.split(/\W+/);
  const verb = tokens[0].toLowerCase();
  const parsed = {verb: verb, tokens: tokens, source: cmdline};
  return parsed;
};


// Context helper functions:

const makeReplyFunction = (socket: net.Socket) : ((msg: string) => void)  => {
  return (msg: string) => {
    socket.write(msg);
    socket.write(MSG_DELIM);
  };
};

const makeLogger = (ctx: Context) => {
  const prefix = (level: string) => {
    const now = new Date();
    const ms = now.getMilliseconds();
    const s = `[${now.toTimeString().substring(0, 8)}`
            + `.${ms < 10 ? '00' : ms < 100 ? '0' : ''}${ms}]`
            + ` [${level}]`
            + ` [client ${ctx.clientId}]`
            + ` [${ctx.mode || 'cmd'}]`;
    return s;
  };
  let logger: any = (...args: any[]) => console.info(prefix('INFO'), ...args);
  logger.error = (...args: any[]) => console.error(prefix('ERROR'), ...args);
  return logger;
};
