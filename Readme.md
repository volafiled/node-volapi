volapi in node
===

Ever wanted to make a volafile bot, but python isn't your thing and Dongo's
elixir is for plebs?
`volapi` to the rescue!

Installation
---

You know the drill:

```shell
yarn add volapi
```

API
---

You got a `Room` and it emits `Message`s and `File`s and other stuff!

See sample_client.js

Changes
---

v2.0

 - `Room.connect()` will now actually wait for the room to be really ready, and
   will throw in the even an error with the subscription occurs (such as the
   `429` rate-limit message. Previously `.connect()` would only fail in the
   event of a network or http(s) error.
 - Related: the `open` event will now fire once the websocket is established,
   not when the ws protocol is done subscribing.
 - Related: new `connected` event, that happens when the connection is truly
   open and ready. May occur after other events (such as initial file events)
 - The `upload_timeout` event was renamed to `upload_blocked`.
 - New `Room.report()` method.
 - `Room.janitor` property, indicating your own janitorness
 - `Room.setConfig` was renamed to `Room.updateConfig`. Never was a public API.
 - New `Room.setConfig` method.
 - New `Room.transferOwner` method.
 - New `Room.addJanitor`/`Room.removeJanitor` methods.
