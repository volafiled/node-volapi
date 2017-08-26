"use strict";

const {Message} = require("./message");
const {File} = require("./file");
const {debug, error} = require("./debug");

const GENERICS = ["roomScore", "submitChat", "pro", "room_old"];

class Handler {
  constructor(room) {
    this.room = room;
    const handlers = Object.getOwnPropertyNames(Object.getPrototypeOf(this)).
      filter(e => e.startsWith("handle_"));
    for (const h of handlers) {
      this[h] = this[h].bind(room);
    }
    const repost = function(type, data) {
      this.handle_generic(type, data, true);
    };
    for (const g of GENERICS) {
      this[`handle_${g}`] = repost.bind(this, g);
    }
  }

  onmessage(data) {
    data = JSON.parse(data);
    if (!data) {
      return;
    }
    if (!Array.isArray(data)) {
      this.handle_initial_connection(data);
      return;
    }
    this.room.ack = data.shift();
    for (const d of data) {
      try {
        const [envelope, ack] = d;
        this.room.sack = ack;
        let [type, msg] = envelope;
        if (type === 2) {
          // Flush, in theory
          continue;
        }
        if (type !== 0) {
          // Unhandled
        }
        [type, msg] = msg;
        try {
          const h = `handle_${type}`;
          const {[h]: fn = null} = this;
          if (fn) {
            fn.call(this, msg);
          }
          else {
            this.handle_generic(type, msg);
          }
        }
        catch (ex) {
          error("Failed to handle", type, msg, ex);
        }
      }
      catch (ex) {
        error(d, ex);
      }
    }
  }

  handle_initial_connection(data) {
    this.connected = true;
    this.version = data.version;
    if (this.session) {
      this.call("useSession", this.session);
    }
    else {
      this.session = data.session;
    }
    this.ack = data.ack;
  }

  handle_owner(data) {
    const {owner = false } = data;
    this.owner = owner;
    this.handler.handle_generic("owner", owner, true);
  }

  handle_admin(data) {
    const {admin = false } = data;
    this.admin = admin;
    this.handler.handle_generic("admin", admin, true);
  }

  handle_login(data) {
    this.loggedin = true;
    this.handler.handle_generic("login", data, true);
  }

  handle_time(data) {
    this.timediff = data - Date.now();
    this.handler.handle_generic("time", data, true);
  }

  handle_subscribed() {
    debug("firing open resolve");
    /**
     * This Room is not ready for shitposting
     * @event Room#open
     */
    this.emit("open");
    /**
     * This Room will now receive messages
     * @event Room#subscribed
     * @type {Error}
     */
    this.emit("subscribed");
  }

  handle_chat_name(data) {
    this.nick = data || this.nick;
  }

  handle_chat(data) {
    /**
     * Somebody said something, but nobody listened
     * @event Room#chat
     * @type {Message}
     */
    this.emit("chat", new Message(this, data));
  }

  handle_files(data) {
    const {"set": set = false, files = []} = data;
    for (let file of files) {
      file = new File(this, file);
      /**
       * A random file appears
       * @event Room#file
       * @type {File}
       */
      this.emit("file", file, set);
      debug(file.id, file.validFor);
    }
    if (set) {
      /**
       * We got a brand new file list of pre-existing files!
       * @event Room#received_files
       */
      this.emit("received_files");
    }
  }

  handle_delete_file(data) {
    /**
     * A random file vanished
     * @event Room#file
     * @type {string}
     */
    this.emit("delete_file", data);
  }

  handle_user_count(data) {
    this.users = data;
    /**
     * User count changed
     * @event Room#users
     * @type {number}
     */
    this.emit("users", this.users);
  }

  handle_generic(type, data, reposted = false) {
    if (reposted) {
      debug("generic", type, data);
    }
    else {
      console.log("unhandled message", type, data);
    }
    this.emit(type, data);
  }
}

/**
 * Other stuff also generates events, such as "pro", etc.
 * Subscribe to their names (not actually misc)
 * @event Room#misc
 * @type {*}
 */

module.exports = {Handler};
