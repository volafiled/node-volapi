"use strict";

const fetch = require("node-fetch");
const { URL } = require("url");
const {VolaError, VolaPrivilegeError} = require("./error");

/**
 * Your friendly neighborhood file
 *
 * @property {string} id ID
 * @property {string} name Name
 * @property {string} type Type
 * @property {number} size Size in bytes
 * @property {Date} expires Point when the files goes dodo
 * @property {Date} uploaded When?!
 * @property {string} uploader Who?!
 * @property {object} tags Other stuffs vola told us
 * @property {object} assets File assets
 * @property {string} url File URL
 * @property {boolean} expired Still there?
 * @property {number} validFor Seconds till dodo
 * @property {string} thumb Image or video thumbnail url
 */
class File {
  constructor(room, data) {
    this.room = room;
    [
      this.id,
      this.name,
      this.type,
      this.size,
      this.expires,
      this.uploaded,
      this.tags,
      this.assets] = data;
    this.tags = this.tags || {};
    this.expires = this.room.fixTime(this.expires);
    this.uploaded = this.room.fixTime(this.uploaded);
    const {nick = "", user = "", ip = null} = this.tags;
    this.uploader = user || nick;
    if (user) {
      this.fromAccount = true;
    }
    this.ip = ip;
    this._infos = null;
    Object.seal(this);
  }

  get url() {
    return new URL(this.name, `https://${this.room.config.site}/get/${this.id}/`).toString();
  }

  get expired() {
    return this.validFor < 0;
  }

  get validFor() {
    return this.expires - Date.now();
  }

  get thumb() {
    return this.getAsset("thumb") || this.getAsset("video_thumb");
  }

  /**
   * Get extended file information, such as checksums
   * @param {boolean} [force] Force (re-)getting the info
   * @returns {Object} The information you are looking for. Most interesting is
   * the .checksum property. You should treat it as opaque, and not rely on
   * the algorithm or encoding, but it's currently an md5 hash.
   */
  async infos(force) {
    if (this._infos && !force) {
      return this._infos;
    }
    const infos = await this.room.callWithCallback(
      "getFileinfo",
      this.id
    );
    delete infos.id;
    this._infos = infos;
    /**
     * File information available. Also available as "fileinfo-<id>".
     * @event Room#fileinfo
     * @type {File} Updated file
     * @type {Object} File infos
     */
    this.room.emit("fileinfo", this, infos);
    this.room.emit(`fileinfo-${this.id}`, this, infos);
    return this._infos;
  }

  setInfos(data) {
    return this._infos = data;
  }

  /**
   * Get a specific asset such as the video_thumb
   * @param {string} type Asset type
   * @returns {string} URL of the asset
   */
  getAsset(type) {
    const asset = this.assets[type];
    if (!asset) {
      return null;
    }
    return `https://${this.room.config.site}/asset/${asset}/${this.id}`;
  }

  /**
   * Files goes byebye
   */
  delete() {
    this.room.deleteFiles(this.id);
  }

  /**
   * Fetch this file
   * @returns {Request}
   */
  async fetch() {
    const headers = Object.assign({
      Referer: this.room.url
    }, this.room.headers);

    return await fetch(this.url, {
      method: "GET",
      headers
    });
  }

  /**
   * Timeout the uploader of this file, does not delete it tho
   * @param {number} minutes
   */
  timeout(minutes) {
    if (!this.room.privileged) {
      throw new VolaPrivilegeError();
    }
    if (!minutes || minutes <= 0) {
      throw new VolaError("Invalid timeout duration");
    }
    let seconds = 60;
    seconds = Math.floor(seconds * minutes);
    if (!seconds || seconds <= 0) {
      throw new VolaError("Invalid timeout duration");
    }
    this.room.call("timeoutFile", this.id, seconds);
  }

  _ban(options, what) {
    if (this.fromAccount) {
      this.room[what]({user: this.uploader}, options);
    }
    else {
      this.room[what]({ip: this.ip}, options);
    }
  }

  /**
   * Ban user who uploaded this file
   * @param {Object} [options] Blacklist options
   */
  ban(options) {
    this._ban(options, "ban");
  }

  /**
   * Unban user who uploaded this file
   * @param {Object} [options] Whitelist options
   */
  unban(options) {
    this._ban(options, "unban");
  }

  /**
   * Blacklist this file
   * @param {Object} [options] Blacklist options
   */
  blacklist(options) {
    this.room.blacklistFiles([this.id], options);
  }

  /**
   * Whitelist this file
   */
  whitelist() {
    this.room.whitelistFiles([this.id]);
  }

  toString() {
    const p = this.fromAccount ? "+" : "";
    return `<File(${this.room.alias}, ${p}${this.uploader}, ${this.id}, ${this.name})>`;
  }
}

module.exports = {File};
