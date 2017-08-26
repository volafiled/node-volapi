"use strict";

const cookie = require("cookie");

class CookieJar extends Map {
  constructor(strOrArray) {
    super(Array.isArray(strOrArray) ? strOrArray : []);
    if (typeof strOrArray === "string") {
      const provided = cookie.parse(strOrArray);
      for (const k of Object.keys(provided)) {
        this.set(k, provided[k]);
      }
    }
  }

  toString() {
    const result = [];
    for (const [k, v] of this) {
      result.push(cookie.serialize(k, v));
    }
    return result.join("; ");
  }

  toJSON() {
    return this.toString();
  }
}

module.exports = { CookieJar };
