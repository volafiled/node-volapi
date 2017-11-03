"use strict";

const {URL} = require("url");
const {Transform} = require("stream");
const {VolaError} = require("./error");

const RE_EXTRACTID = /^\/r\/([a-z0-9_-]+)$/i;
const RE_MATCHID = /^[a-z0-9_-]+$/i;

function parseId(id) {
  if (!id) {
    return null;
  }
  try {
    const url = new URL(id);
    if (!url.pathname) {
      throw new VolaError("Not a valid room URL");
    }
    const m = url.pathname.match(RE_EXTRACTID);
    if (!m) {
      throw new VolaError("Not a valid room URL");
    }
    return m[1];
  }
  catch (ex) {
    const m = id.match(RE_EXTRACTID);
    if (m) {
      return m[1];
    }
    if (!RE_MATCHID.test(id)) {
      throw new VolaError("Not a valid room ID");
    }
    return id;
  }
}

const MIN_NICK = 3;
const MAX_NICK = 12;
const RE_NICK = /^[a-zA-Z0-9]+$/;

function verifyNick(nick, config = {}) {
  if (typeof nick !== "string") {
    throw new VolaError("Nicknames have to be string");
  }
  if (nick.length < MIN_NICK) {
    throw new VolaError("Nicknames have to be at least 3 chars long");
  }
  const {chat_max_alias_length = MAX_NICK} = config;
  if (nick.length > chat_max_alias_length) {
    throw new VolaError(`Nicknames have to be at most ${chat_max_alias_length} chars long`);
  }
  if (!RE_NICK.test(nick)) {
    throw new VolaError("Nickname contains invalid characters");
  }
}

function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

function deadline(time) {
  return new Promise((_, reject) => setTimeout(() => {
    reject(new Error(`Deadline of ${time} expired`));
  }, time));
}


class TeeTransform extends Transform {
  constructor(tee, options) {
    super(options);
    this.tee = tee;
    this.on("pipe", s => {
      const {highWaterMark = this.highWaterMark, fd, path} = s;
      this.highWaterMark = highWaterMark;
      this.fd = fd;
      this.path = path;
    });
  }
  _transform(chunk, encoding, cb) {
    if (this.tee && chunk.length) {
      try {
        this.tee.write(chunk);
      }
      catch (ex) {
        return cb(ex);
      }
    }
    return cb(null, chunk);
  }
}

class ProgressTransform extends Transform {
  constructor(options) {
    super(options);
    this.on("pipe", s => {
      const {highWaterMark = this.highWaterMark} = s;
      this.highWaterMark = highWaterMark;
    });
  }
  _transform(chunk, encoding, cb) {
    if (chunk.length) {
      try {
        this.emit("progress", chunk.length);
      }
      catch (ex) {
        cb(ex);
        return;
      }
    }
    cb(null, chunk);
  }
}

module.exports = {
  parseId,
  verifyNick,
  sleep,
  deadline,
  TeeTransform,
  ProgressTransform
};
