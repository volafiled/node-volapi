"use strict";

const fs = require("fs");
const {promisify} = require("util");
const crypto = require("crypto");
const path = require("path");
const EventEmitter = require("events");
const {URLSearchParams} = require("url");
const EIO = require("engine.io-client");
const FormData = require("form-data");
const fetch = require("node-fetch");
const {File} = require("./file");
const {parseId, deadline, sleep, verifyNick} = require("./util");
const {ProgressTransform, TeeTransform} = require("./util");
const {debug} = require("./debug");
const {VolaPrivilegeError, VolaError} = require("./error");
const {CookieJar} = require("./cookiejar");
const {Handler} = require("./handler");
const {Message} = require("./message");

const DEFAULT_SITE = "volafile.org";
const HEADERS = {
  "User-Agent": "node-volapi/1.0",
};
const OK = 200;
const ACCESS_DENIED = 403;

const FILES = Symbol("FILES");
const DEFAULT_CONFIG = Object.freeze({
  janitors: [],
  disabled: false,
});

let cid = 0;

function gettable(room, key) {
  Object.defineProperty(room, key, {
    enumerable: true,
    get() {
      return room.config[key];
    },
    set(nv) {
      room.config[key] = nv;
    }
  });
}

function configurable(room, key, admin) {
  Object.defineProperty(room, key, {
    enumerable: true,
    get() {
      return this.config[key];
    },
    set(nv) {
      if (admin && !this.admin) {
        throw new VolaPrivilegeError();
      }
      this.setConfig(key, nv).catch(() => {});
    }
  });
}

function toBanSpec(spec) {
  if (!spec) {
    throw new VolaError("No spec provided");
  }
  if (typeof spec === "string") {
    spec = {ip: spec};
  }
  if (!Array.isArray(spec)) {
    spec = [spec];
  }
  for (const s of spec) {
    if (!Object.keys(s).length) {
      throw new VolaError("Empty spec provided");
    }
  }
  return spec;
}

/**
 * Yay, we vola
 *
 * @property {boolean} admin Wew, a mod!
 * @property {boolean} adult Room is an adult room
 * @property {boolean} connected This thing on?
 * @property {boolean} disabled Room is nuked
 * @property {boolean} owner Your room m8
 * @property {boolean} janitor Maintenance personnel
 * @property {boolean} staff (((Trusted))) you are
 * @property {File[]} files Current set of files in here
 * @property {string} alias Room alias (custom name); might be same as .id
 * @property {string} id Room id
 * @property {string} motd MOTD
 * @property {string} name Room name
 * @property {string} nick Connected user name
 * @property {string} url Full URL of this room
 */
class Room extends EventEmitter {
  /**
   * A new room for a new day
   * @param {string} id Room id (or alias or full url)
   * @param {string} [nick] Nickname
   * @param {Object} [options] Room options
   * @param {string} [options.password] Room password
   * @param {string} [options.key] Room key (aka session password)
   * @param {Room} [options.other] Other room (to take login info from)
   */
  constructor(id, nick, options) {
    options = options || {};
    const {password = "", key = "", other = null} = options;
    id = parseId(id);
    if (!id) {
      throw new VolaError("No room id provided");
    }
    super();

    this.config = {site: DEFAULT_SITE, loaded: false};
    gettable(this, "password");
    gettable(this, "key");

    this.alias = this.id = id;
    this.nick = (other && other.nick) || nick;
    verifyNick(this.nick);
    this.timediff = 0;
    this._uploadCount = 0;
    this.password = password;
    this.key = key;

    this.ack = this.sack = this.last_sack = -1;
    this.users = 0;
    this[FILES] = new Map();
    this.headers = Object.assign({}, (other && other.headers || HEADERS));
    if (!this.headers.Cookie) {
      this.headers.Cookie = new CookieJar("allow-download=1");
    }
    this.userInfo = {};
    this.janitor = this.owner = this.admin = this.connected = false;
    this.handler = new Handler(this);
    this.closed = false;
    this._closing = null;

    const {Message: MessageCtor = Message} = options;
    this.Message = MessageCtor || Message;

    const {File: FileCtor = File} = options;
    this.File = FileCtor || File;

    this.on("file", file => {
      this[FILES].set(file.id, file);
    });
    this.on("delete_file", fid => {
      this[FILES].delete(fid);
    });
  }

  get url() {
    const {config = {}} = this;
    const {site = "volafile.org"} = config;
    return `https://${site}/r/${this.alias}`;
  }

  get files() {
    this.expireFiles();
    return Array.from(this[FILES].values());
  }

  get privileged() {
    return this.owner || this.admin || this.janitor;
  }

  /**
   * So you got a password?
   * @param {string} password
   * @throws {Error} o_O
   */
  async login(password) {
    await this.ensureConfig();
    const resp = await this.callREST("login", {
      name: this.nick,
      password
    });
    if (resp.error) {
      throw new VolaError(`Failed to log in: ${resp.error.message || resp.error}`);
    }
    this.session = resp.session;
    this.headers.Cookie.set("session", this.session);
    debug(this.headers);
    this.nick = resp.nick;
    if (this.connected) {
      this.call("useSession", this.session);
    }
  }

  changeNick(nick) {
    verifyNick(nick);
    this.call("command", this.nick, "nick", nick);
  }

  /**
   * Without this life is boring!
   */
  async connect() {
    for (let attempt = 1; ; ++attempt) {
      let resolve;
      let reject;
      const messageWaiter = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
        this.prependOnceListener("connected", resolve);
        this.prependOnceListener("error", reject);
      });
      try {
        await this.openConnection();
        await messageWaiter;
        return;
      }
      catch (ex) {
        if (ex.description && /response: 5\d{2}$/i.test(ex.description.message)) {
          await sleep(200 * attempt);
          continue;
        }
        throw ex;
      }
      finally {
        this.removeListener("connected", resolve);
        this.removeListener("error", reject);
      }
    }
  }

  async openConnection() {
    await this.ensureConfig();
    this.id = this.config.room_id;
    debug(this.config);
    const params = new URLSearchParams({
      room: this.id,
      cs: this.config.checksum2,
      nick: this.nick,
      rn: Math.random()
    });
    if (this.password) {
      params.append("password", this.password);
    }
    else if (this.key) {
      params.append("key", this.key);
    }
    const url = `wss://${this.config.site}/api/?${params}`;
    const extraHeaders = Object.assign({
      Origin: `https://${this.config.site}`,
      Referer: this.url,
    }, this.headers);
    debug(url);
    await new Promise((resolve, reject) => {
      this.closed = false;
      this.eio = new EIO(url, {
        path: "/api",
        extraHeaders,
        transports: ["websocket"],
      });
      this.eio.on("ping", async () => {
        try {
          this.sendAck();
          await Promise.race([
            deadline(20 * 1000),
            new Promise(resolve => this.eio.once("pong", resolve)),
          ]);
        }
        catch (ex) {
          this.emit("error", ex);
          try {
            await this.close();
          }
          catch (ex) {
            // ignored
          }
        }
      });
      this.eio.on("open", () => {
        if (this.closed) {
          return;
        }
        this.eio.on("error", data => {
          this.closed = true;

          /**
           * This Room is rekt
           * @event Room#error
           * @type {Error}
           */
          this.emit("error", data);
          this.removeAllListeners();
        });
        this.eio.on("close", data => {
          this.closed = true;

          /**
         * This Room is no mo
         * @event Room#close
         * @type {object} Close data per socket
         */
          this.emit("close", data);
          this.removeAllListeners();
          reject(data);
        });

        /**
         * Connection is now open, but not necessarily usable.
         * @event Room#open
         */
        this.emit("open");
        resolve();
      });
      this.eio.on("message", data => {
        if (this.closed) {
          return;
        }
        this.handler.onmessage(data);
      });
      this.eio.once("close", data => {
        this.closed = true;
        reject(data);
      });
      this.eio.once("error", data => {
        this.closed = true;
        reject(data);
      });
    });
  }

  /**
   * Run until this room somehow closes.
   * @returns {reason}
   *   Resolving when the room is closed or rejecting on error
   */
  async run() {
    await new Promise((resolve, reject) => {
      this.on("error", reject);
      this.once("close", resolve);
    });
  }

  /**
   * LIFE SHOULD BE BORING!
   */
  async close() {
    this.closed = true;
    if (!this.eio) {
      return;
    }
    if (!this._closing) {
      this._closing = this._close();
    }
    try {
      await this._closing;
    }
    finally {
      this._closing = null;
    }
  }

  async _close() {
    if (!this.eio) {
      return;
    }
    await this.sendClose();
    this.eio.close();
    delete this.eio;
  }

  /**
   * Say something profound!
   * @param {string} msg MUST BE PROFOUND!
   * @param {object} [options] Such as .me and .admin
   * @throws {VolaError}
   */
  chat(msg, options = {}) {
    if (typeof (msg) !== "string") {
      throw new VolaError("Not a string message");
    }
    if (!msg.length) {
      throw new VolaError("Empty message");
    }
    if (msg.length > this.config.chat_max_message_length) {
      throw new VolaError("Message too long");
    }
    const {me = false, admin = false} = options || {};
    if (admin) {
      if (!this.admin && !this.staff) {
        throw new VolaError("Cannot /achat");
      }
      this.call("command", this.nick, "a", msg);
    }
    else if (me) {
      this.call("command", this.nick, "me", msg);
    }
    else {
      this.call("chat", this.nick, msg);
    }
  }

  /**
   * Some specific file you had in mind?
   * @param {string} id
   * @returns {File}
   */
  getFile(id) {
    const file = this[FILES].get(id);
    if (file && file.expired) {
      this[FILES].delete(id);
      return null;
    }
    return file;
  }

  /**
   * Some specific file you had in mind? But wait for it!
   * @param {string} id
   * @param {number} [timeout]
   * @returns {File}
   */
  waitFile(id, timeout = 10 * 1000) {
    const file = this[FILES].get(id);
    if (file && file.expired) {
      this[FILES].delete(id);
      return null;
    }
    return Promise.race([
      new Promise(resolve => this.once(`file-${id}`, resolve)),
      deadline(timeout || 10 * 1000)
    ]);
  }

  /**
   * Report a room
   * @param {string} reason
   */
  report(reason) {
    this.call("submitReport", {reason});
  }

  /**
   * Cleaning the flow
   * @param {string[]} ids
   * @throws {VolaPrivilegeError}
   */
  deleteFiles(ids) {
    if (!this.privileged) {
      throw new VolaPrivilegeError();
    }
    if (!Array.isArray(ids)) {
      ids = [ids];
    }
    this.call("deleteFiles", ids);
  }

  /**
   * Everybody should upload THIS!
   * @param {string[]} ids
   * @throws {VolaPrivilegeError}
   */
  whitelistFiles(ids) {
    if (!this.admin) {
      throw new VolaPrivilegeError();
    }
    if (!Array.isArray(ids)) {
      ids = [ids];
    }
    this.call("whitelistFiles", ids);
  }

  /**
   * Remove messages
   * @param {string[]} ids
   */
  removeMessages(ids) {
    if (!this.admin) {
      throw new VolaPrivilegeError();
    }
    if (!Array.isArray(ids)) {
      ids = [ids];
    }
    this.call("removeMessages", ids);
  }

  /**
   * Nobody should upload THIS!
   * @param {string[]} ids
   * @param {object} [options]
   * @throws{VolaPrivilegeError}
   */
  blacklistFiles(ids, options) {
    if (!this.admin) {
      throw new VolaPrivilegeError();
    }
    const o = Object.assign({}, {
      hours: 0,
      reason: "",
      ban: false,
      hellban: false,
      mute: false}, options);
    if (!o.hours || o.hours <= 0) {
      throw new VolaError("Invalid BL duration");
    }
    if (!Array.isArray(ids)) {
      ids = [ids];
    }
    this.call("blacklistFiles", ids, options);
  }

  /**
   * Ban some moron
   * @param {object} spec
   * @param {object} [options]
   * @throws {VolaPrivilegeError}
   * @throws {VolaError}
   */
  ban(spec, options) {
    if (!this.admin) {
      throw new VolaPrivilegeError();
    }
    spec = toBanSpec(spec);
    const o = Object.assign({}, {
      hours: 0,
      reason: "",
      purgeFiles: false,
      ban: false,
      hellban: false,
      mute: false}, options);
    if (!o.hours || o.hours <= 0) {
      throw new VolaError("Invalid ban duration");
    }
    if (!o.ban && !o.hellban && !o.mute && !o.purgeFiles) {
      throw new VolaError("You gotta do something to a moron");
    }
    this.call("banUser", spec, o);
  }

  /**
   * Unban some moron
   * @param {Object} spec
   * @param {object} [options]
   * @throws {VolaPrivilegeError}
   * @throws {VolaError}
   */
  unban(spec, options) {
    if (!this.admin) {
      throw new VolaPrivilegeError();
    }
    spec = toBanSpec(spec);
    const o = Object.assign({}, {
      reason: "",
      ban: false,
      hellban: false,
      mute: false,
      timeout: false}, options);
    if (!o.ban && !o.hellban && !o.mute && !o.timeout) {
      throw new VolaError("You gotta do something to a moron");
    }
    this.call("unbanUser", spec, o);
  }

  async setConfig(key, value) {
    if (!this.privileged) {
      throw new VolaPrivilegeError();
    }
    const resp = await this.callREST("setRoomConfig", {
      room: this.id,
      session: this.session,
      c: cid++,
      config: JSON.stringify({[key]: value}),
    });
    if (resp.error) {
      throw new Error(resp.error.message || resp.error);
    }
    return resp;
  }

  /**
   * You are the owner, but you really don't wanna be
   * @param {string} newOwner Somebody to suffer
   */
  async transferOwner(newOwner) {
    if (!this.owner && !this.admin) {
      throw new VolaPrivilegeError();
    }
    newOwner = (newOwner || "").trim().toLowerCase();
    if (!newOwner) {
      throw new Error("newOwner may not be empty");
    }

    await this.setConfig("owner", newOwner);
  }

  /**
   * Add a janitor
   * @param {string} janitor Somebody to suffer (a little less)
   */
  async addJanitor(janitor) {
    if (!this.owner && !this.admin) {
      throw new VolaPrivilegeError();
    }
    janitor = (janitor || "").trim().toLowerCase();
    if (!janitor) {
      throw new Error("newOwner may not be empty");
    }
    if (this.config.janitors.has(janitor)) {
      return;
    }
    const janitors = new Set(this.config.janitors);
    janitors.add(janitor);
    await this.setConfig("janitors", Array.from(janitors));
    this.config.janitors.add(janitor);
  }

  /**
   * Remove a janitor
   * @param {string} janitor Somebody to suffer (a little less)
   */
  async removeJanitor(janitor) {
    if (!this.owner && !this.admin) {
      throw new VolaPrivilegeError();
    }
    janitor = (janitor || "").trim().toLowerCase();
    if (!janitor) {
      throw new Error("newOwner may not be empty");
    }
    if (!this.config.janitors.has(janitor)) {
      return;
    }
    const janitors = new Set(this.config.janitors);
    janitors.delete(janitor);
    await this.setConfig("janitors", Array.from(janitors));
    this.config.janitors.delete(janitor);
  }

  /**
   * Uploads a file to this room
   * @param {object} options Upload options
   * @param {string} [options.file] File to upload (stream has preference!)
   * @param {string} [options.name] Name to upload file with. If not given, it
   *    will be derived from file property. If neither property is given, an
   *    Error is thrown!
   * @param {Object} [options.stream] A supported stream, buffer or string. If
   *    provided the file property will be ignored (except for deriving a name).
   * @param {callback} [options.progress] Upload progress callback.
   * @returns {Object} Upload result, containing the file `.id` and local(!)
   *    `.checksum` of the file/stream.
   */
  uploadFile(options) {
    options = options || {};
    let {name = null, stream = null} = options;
    const {file = null, progress = null} = options;
    if (!stream) {
      if (!file) {
        throw new VolaError("Need to provide a .stream or a .file");
      }
      stream = fs.createReadStream(file, {
        encoding: null,
      });
    }
    else if (typeof stream === "string") {
      stream = Buffer.from(stream, "utf-8");
    }
    if (!name) {
      if (!file) {
        throw new VolaError("No .name or .file provided");
      }
      const {base} = path.parse(file);
      name = base;
    }
    if (progress && typeof progress !== "function") {
      throw new VolaError("progress must be a function");
    }
    return this._uploadFile(name, stream, progress);
  }

  async _getUploadKey() {
    for (;;) {
      const qs = {
        name: this.nick,
        room: this.id,
        c: ++this._uploadCount
      };
      if (this.password) {
        qs.password = this.password;
      }
      else if (this.key) {
        qs.roomKey = this.key;
      }
      const params = await this.callREST("getUploadKey", qs);
      const {key = null, server = null, file_id = null} = params;
      if (!key || !server || !file_id) {
        const {error = {}} = params;
        const {info = {}} = error;
        const {timeout = null} = info;
        if (timeout) {
          /**
           * Upload is blocked temporarily by the flood protection, but will
           * be retried after the timeout expires
           * @event Room#upload_blocked
           * @type {Number} Number of ms the block is active
           */
          this.emit("upload_blocked", timeout);
          await sleep(timeout);
          continue;
        }
        if (error.code === ACCESS_DENIED) {
          throw new VolaPrivilegeError(`Failed to get upload key: ${error.name} / ${error.message}`);
        }
        throw new VolaError(`Failed to get upload key: ${error.name} / ${error.message}`);
      }
      return {key, server, file_id};
    }
  }

  _uploadFile(name, body, progress_callback) {
    return new Promise(async (resolve, reject) => {
      let stream = body;
      const error = err => {
        reject(err);
      };
      try {
        const checksum = crypto.createHash("md5");
        let form = new FormData();
        checksum.on("error", error);
        if (Buffer.isBuffer(stream)) {
          form.append("file", stream, name);
          checksum.end(stream);
        }
        else {
          const opts = {
            filename: name,
          };
          if (stream.hasOwnProperty("knownLength")) {
            opts.knownLength = stream.knownLength;
          }
          else if ("httpModule" in stream) {
            const {response = {}} = stream;
            const {headers = {}} = response;
            let {"content-length": length} = headers;
            length = +length;
            if (isFinite(length) && length) {
              opts.knownLength = length;
            }
          }
          stream.on("error", error);
          stream = stream.pipe(new TeeTransform(checksum));
          form.append("file", stream, opts);
        }
        const {key, server, file_id} = await this._getUploadKey();

        const length = await promisify(form.getLength.bind(form))();
        const headers = Object.assign({
          "Origin": `https://${this.config.site}`,
          "Referer": this.url,
          "Content-Length": length,
        }, this.headers, form.getHeaders());
        if (stream.on) {
          stream.on("error", error);
        }
        form.on("error", error);
        if (progress_callback) {
          const progress = new ProgressTransform();
          let cur = 0;
          progress.on("progress", delta => {
            cur += delta;
            progress_callback(delta, cur, length, server);
          });
          progress.on("error", error);
          form = form.pipe(progress);
        }
        const params = new URLSearchParams({
          room: this.id,
          key,
          filename: name
        });
        if (this.password) {
          params.append("password", this.password);
        }
        else if (this.key) {
          params.append("roomKey", this.key);
        }
        const url = `https://${server}/upload?${params}`;
        if (body.resume) {
          body.resume();
        }
        const req = await this.fetch(url, {
          method: "POST",
          body: form,
          headers
        });
        const resp = await req.text();
        if (req.status !== OK) {
          throw new VolaError(`Upload failed! ${resp}`);
        }
        if (!Buffer.isBuffer(stream)) {
          checksum.end();
        }
        resolve({
          id: file_id,
          checksum: checksum.read().toString("hex")
        });
      }
      catch (ex) {
        reject(ex);
      }
    });
  }

  call(fn, ...args) {
    if (!this.connected) {
      throw new VolaError("Room is not connected");
    }
    const call = JSON.stringify([
      this.sack,
      [[0, ["call", { fn, args }]], ++this.ack]
    ]);
    this.last_sack = this.sack;
    debug("calling", call);
    this.eio.send(call);
  }

  callWithCallback(fn, ...args) {
    const [id, promise] = this.handler.registerCallback();
    args.push(id);
    this.call(fn, ...args);
    return promise;
  }

  sendAck() {
    if (!this.connected || this.last_sack === this.sack) {
      return;
    }
    const call = JSON.stringify([this.sack]);
    this.last_sack = this.sack;
    this.eio.send(call);
  }

  async sendClose() {
    if (!this.connected) {
      throw new VolaError("Room is not connected");
    }
    const call = JSON.stringify([
      this.sack,
      [[2], ++this.ack]
    ]);
    try {
      const send = promisify(this.eio.send.bind(this.eio));
      await Promise.race([
        deadline(10 * 1000),
        send(call, null)
      ]);
    }
    catch (ex) {
      console.error("failed to send close", ex);
    }
  }

  fetch(url, options = {}) {
    if (!url.includes(this.config.site)) {
      throw new VolaError(`Only use this method with ${this.config.site} resources`);
    }
    let {headers = {}} = options;
    headers = Object.assign({}, this.headers, headers);
    return fetch(url, Object.assign({}, options, {headers}));
  }

  async callREST(endp, params) {
    params = new URLSearchParams(params);
    for (let attempt = 1; ; ++attempt) {
      const resp = await this.fetch(
        `https://${this.config.site}/rest/${endp}?${params}`, {
          method: "GET",
          headers: {
            Origin: `https://${this.config.site}`,
            Referer: this.url
          }
        });
      if (resp.status && resp.status >= 500) {
        await sleep(100 * attempt);
        continue;
      }
      try {
        return await resp.json();
      }
      catch (ex) {
        if (resp.status && resp.status >= 500) {
          await sleep(100 * attempt);
          continue;
        }
        throw ex;
      }
    }
  }

  async ensureConfig() {
    if (this.config.loaded) {
      return;
    }
    const config = await this.callREST("getRoomConfig", {room: this.id});
    if (!config) {
      throw new VolaError("Failed to get config");
    }
    if (config.error) {
      throw new VolaError(`${config.error.code}: ${config.error.message}`);
    }
    this.updateConfig(config);
    configurable(this, "motd");
    configurable(this, "name");
    configurable(this, "adult");
    configurable(this, "disabled", true);
    configurable(this, "file_ttl", true);
  }

  updateConfig(config) {
    if (config && !config.password) {
      // Lain decided it's sane to return an empty password
      delete config.password;
    }
    Object.assign(this.config, DEFAULT_CONFIG, config || {}, {loaded: true});
    if ("room_id" in this.config) {
      this.id = this.config.room_id;
    }
    if ("custom_room_id" in this.config) {
      this.alias = this.config.custom_room_id;
    }
    this.config.janitors = new Set(this.config.janitors);
    verifyNick(this.nick, this.config);
  }

  fixTime(time) {
    return time - this.timediff;
  }

  expireFiles() {
    const expired = [];
    this[FILES].forEach((file, fid) => {
      if (file.expired) {
        expired.push(fid);
      }
    });
    for (const e of expired) {
      this[FILES].delete(e);
    }
  }

  toString() {
    return `<Room(${this.id} (${this.alias}), ${this.nick})>`;
  }
}

class ManyRooms extends EventEmitter {
  constructor(roomids, nick, options) {
    super();
    options = options || {};
    this.nick = nick;
    const {Room: RoomCtor = Room} = options;
    this.Room = RoomCtor;
    verifyNick(this.nick);
    this._roomopts = roomids.map(e => {
      if (typeof e === "string") {
        e = {room: e};
      }
      return Object.assign({}, e, options);
    });
    if (!this._roomopts.length) {
      throw new VolaError("No roomids given");
    }
    this.baseRoom = null;
  }

  makeRoom(options, other) {
    const {nick = null, room} = options;
    delete options.nick;
    delete options.room;
    if (other) {
      options.other = other;
    }
    return new this.Room(room, nick, options);
  }

  async init(password) {
    const baseRoom = new Room("BEEPi", this.nick); // yeahyeah
    if (password) {
      await baseRoom.login(password);
    }
    this.baseRoom = baseRoom;
    this._rooms = this._roomopts.map(
      opts => this.makeRoom(opts, this.baseRoom));

    const events = new Map();
    this.on("newListener", eventName => {
      if (events.has(eventName)) {
        return;
      }
      const listeners = new Map(this._rooms.map(room => {
        const listener = (...args) => {
          this.emit(eventName, room, ...args);
        };
        room.on(eventName, listener);
        return [room, listener];
      }));
      events.set(eventName, listeners);
    });
    this.on("removeListener", eventName => {
      if (this.listenerCount(eventName)) {
        return;
      }
      const listeners = events.get(eventName);
      if (!listeners) {
        return;
      }
      events.delete(eventName);
      for (const [room, listener] of listeners) {
        room.removeListener(eventName, listener);
      }
    });
  }

  async connect() {
    await Promise.all(this._rooms.map(room => room.connect()));
  }

  async run() {
    try {
      await Promise.race(this._rooms.map(room => room.run()));
    }
    finally {
      await this.close();
    }
    this.removeAllListeners();
    this._rooms.length = 0;
  }

  async close() {
    await Promise.all(this._rooms.map(async room => {
      try {
        await room.close();
      }
      catch (ex) {
        // ignore
      }
    }));
  }
}

module.exports = { Room, ManyRooms };
