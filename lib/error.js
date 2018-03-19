"use strict";

/**
 * You did something wrong, or vola did, not sure
 * @extends {Error}
 * @property {boolean} volaSaysNo If defined and true, this is a VolaError
 */
class VolaError extends Error { }

Object.defineProperty(VolaError.prototype, "volaSaysNo", {
  value: true,
  enumerable: true
});

/**
 * pls leave
 * @extends {VolaError}
 * @property {boolean} volaSaysPlsLeave
 *   If defined and true, this is a VolaPrivilegeError
 */
class VolaPrivilegeError extends VolaError {
  constructor(msg) {
    super(msg || "I'm sorry Dave, I'm afraid I can't do that");
  }
}

Object.defineProperty(VolaError.prototype, "volaSaysPlsLeave", {
  value: true,
  enumerable: true
});

module.exports = {VolaError, VolaPrivilegeError};
