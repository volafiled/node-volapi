"use strict";

const {Room, ManyRooms} = require("./room");
const util = require("./util");

module.exports = { Room, ManyRooms, util };
Object.assign(module.exports, require("./error"));
