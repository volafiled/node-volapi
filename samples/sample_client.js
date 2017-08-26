const {Room} = require("volapi");

async function main() {
  console.log("starting up");
  const room = new Room("BEEPi", "MrRobot");
  room.on("open", () => {
    console.log("opened room", room.toString());
  });
  room.on("close", reason => {
    console.log("closed room", room.toString(), reason);
  });
  room.on("error", reason => {
    console.error("error in room", room.toString(), reason);
  });
  room.on("chat", m => {
    if (!m.self && !m.system) {
      // Just parrot!
      room.chat(m.message);
    }
    console.log(m.toString());
  });

  console.log("logging in");
  await room.login("hunter2");
  console.log("connecting");
  await room.connect();
  console.log("running");
  await room.run();
}

main().catch(console.error);
