"use strict";

const fetch = require("node-fetch");
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
    const {user = "", ip = null} = this.tags;
    this.uploader = user;
    this.ip = ip;
    this._infos = null;
    Object.seal(this);
  }

  get url() {
    return `https://${this.room.config.site}/get/${this.id}/${this.name}`;
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
   * @returns {Promise<Object>} The information you are looking for
   */
  infos(force) {
    if (this._infos && !force) {
      return Promise.resolve(this._infos);
    }
    return new Promise((resolve, reject) => {
      this.room.once(`fileinfo-${this.id}`, data => {
        if ("error" in data) {
          reject(data.error);
        }
        resolve(this.setInfos(data));
      });
      this.room.call("get_fileinfo", this.id);
    });
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
   * @returns {Promise<Request>}
   */
  fetch() {
    const headers = Object.assign({
      Referer: this.room.url
    }, this.room.headers);

    return fetch(this.url, {
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
    this.room.call("timeoutFile", this.id, this.uploader, seconds);
  }

  /**
   * Blacklist this file
   * @param {Object} [options] Ban options
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
    return `<File(${this.room.alias}, ${this.uploader}, ${this.id}, ${this.name})>`;
  }
}

module.exports = {File};
