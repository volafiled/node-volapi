"use strict";

const {VolaError, VolaPrivilegeError} = require("./error");

const FLAGS = {
  owner: false,
  donor: false,
  pro: false,
  user: false,
  staff: false,
  admin: false
};

/**
 * Somebody said something!
 * @property {string} nick Nickname
 * @property {bool} self Is this message from muh?
 * @property {string[]} rooms Linked room ids
 * @property {string[]} files Linked file ids
 * @property {string[]} urls Links
 * @property {string} message That's what she said!
 * @property {bool} owner Said by the owner
 * @property {bool} pro Said by a pro
 * @property {bool} donor Said by a donor
 * @property {bool} user Said by a logged in user
 * @property {staff} user Said by a (((trusted))) user
 * @property {admin} user Said by a mod
 */
class Message {
  constructor(room, data) {
    this.room = room;
    this.nick = data.nick || null;
    this.data = data.data || {};

    const {ip = null, self = false, id = null} = this.data;
    this.ip = ip;
    this.self = self;
    this.id = id;

    Object.assign(this, FLAGS);
    Object.assign(this, data.options);

    this.rooms = [];
    this.files = [];
    this.urls = [];
    this.message = data.message.map(part => {
      switch (part.type) {
      case "text":
        return part.value;

      case "break":
        return "\n";

      case "file":
        this.files.push(part.id);
        return `@${part.id}`;

      case "room":
        this.rooms.push(part.id);
        return `#${part.id}`;

      case "url":
        this.urls.push(part.href);
        return part.text;

      case "raw":
        return part.value;
      default:
        return null;
      }
    }).filter(e => e).join("");
  }

  /**
   * Said by the system
   * @returns {boolean}
   */
  get system() {
    return this.purple && !this.user;
  }

  /**
   * Said by a purple
   * @returns {boolean}
   */
  get purple() {
    return this.admin || this.staff;
  }

  /**
   * Said by a white
   * @returns {boolean}
   */
  get white() {
    return !this.purple && !this.green;
  }

  /**
   * Said by a green
   * @returns {boolean}
   */
  get green() {
    return this.user;
  }

  /**
   * Timeout whoever said this
   * @param {number} minutes Duration
   */
  timeout(minutes) {
    if (!this.room.privileged) {
      throw new VolaPrivilegeError();
    }
    if (!this.id) {
      throw new VolaError("No message id");
    }
    let seconds = 60;
    seconds = Math.floor(seconds * minutes);
    if (!seconds || seconds <= 0) {
      throw new VolaError("Invalid timeout duration");
    }
    this.room.call("timeoutChat", this.id, this.nick, seconds);
  }

  /**
   * Ban whoever said this
   * @param {object} options
   */
  ban(options) {
    this.room.ban(this.ip, options);
  }

  /**
   * Unban whoever said this
   * @param {object} options
   */
  unban(options) {
    this.room.unban(this.ip, options);
  }

  toString() {
    return `<Message(${this.room.id}, ${this.nick}, ${this.message})>`;
  }
}

module.exports = {Message};
