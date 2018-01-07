"use strict";

const {Room, ManyRooms} = require("./room");
const util = require("./util");
const {Message} = require("./message");
const {File} = require("./file");

module.exports = { Room, ManyRooms, util, Message, File };
Object.assign(module.exports, require("./error"));
