const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Room, randomCode, MIN_PLAYERS, MAX_PLAYERS } = require("./Room");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "..", "public")));

/** @type {Map<string, Room>} */
const rooms = new Map();

function cleanName(name) {
  return String(name || "").trim().slice(0, 20) || "Player";
}

function newRoomCode() {
  let code;
  do {
    code = randomCode();
  } while (rooms.has(code));
  return code;
}

function broadcastLobby(room) {
  io.to(room.code).emit("lobby-update", room.serializeLobby());
}

function socketFor(id) {
  return io.sockets.sockets.get(id);
}

function startStep(room) {
  const assignments = room.assignmentsForCurrentStep();
  for (const [pid, a] of Object.entries(assignments)) {
    const s = socketFor(pid);
    if (!s) continue;
    s.emit("your-turn", {
      step: room.currentStep,
      totalSteps: room.totalSteps,
      type: a.type,
      timeLimit: room.currentTimeLimit(),
      deadline: room.stepDeadlineForEmit,
      prevEntry: a.prevEntry,
      isBookOwner: a.isBookOwner,
      promptSuggestion: a.type === "text" ? room.randomPrompt() : undefined,
    });
  }
  io.to(room.code).emit("step-progress", {
    step: room.currentStep,
    totalSteps: room.totalSteps,
    submitted: 0,
    total: room.order.filter((pid) => room.players.has(pid)).length,
  });
}

function beginStepTimer(room) {
  const limitMs = room.currentTimeLimit() * 1000;
  room.stepDeadlineForEmit = Date.now() + limitMs;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => forceAdvance(room), limitMs);
}

function runStep(room) {
  beginStepTimer(room);
  startStep(room);
}

function doAdvance(room) {
  const more = room.advanceStep();
  if (more) {
    runStep(room);
  } else {
    clearTimeout(room.timer);
    io.to(room.code).emit("game-reveal", room.serializeReveal());
  }
}

function forceAdvance(room) {
  if (room.phase !== "playing") return;
  room.autoFillMissing();
  doAdvance(room);
}

function checkStepComplete(room) {
  const activeCount = room.order.filter((pid) => room.players.has(pid)).length;
  io.to(room.code).emit("step-progress", {
    step: room.currentStep,
    totalSteps: room.totalSteps,
    submitted: room.submitted.size,
    total: activeCount,
  });
  if (room.allSubmitted()) {
    clearTimeout(room.timer);
    doAdvance(room);
  }
}

io.on("connection", (socket) => {
  socket.on("create-room", ({ name }, cb) => {
    const code = newRoomCode();
    const room = new Room(code, socket.id);
    room.addPlayer(socket.id, cleanName(name));
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    cb && cb({ ok: true, code, playerId: socket.id });
    broadcastLobby(room);
  });

  socket.on("join-room", ({ name, code }, cb) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return cb && cb({ ok: false, error: "Room not found." });
    if (room.phase !== "lobby") return cb && cb({ ok: false, error: "Game already in progress." });
    if (room.players.size >= MAX_PLAYERS) return cb && cb({ ok: false, error: "Room is full." });
    room.addPlayer(socket.id, cleanName(name));
    socket.join(room.code);
    socket.data.roomCode = room.code;
    cb && cb({ ok: true, code: room.code, playerId: socket.id });
    broadcastLobby(room);
  });

  socket.on("update-settings", (settings) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.phase !== "lobby") return;
    const writeSeconds = Math.min(180, Math.max(15, parseInt(settings.writeSeconds, 10) || room.settings.writeSeconds));
    const drawSeconds = Math.min(240, Math.max(20, parseInt(settings.drawSeconds, 10) || room.settings.drawSeconds));
    room.settings = { writeSeconds, drawSeconds };
    broadcastLobby(room);
  });

  socket.on("start-game", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (!room.canStart()) return;
    room.startGame();
    runStep(room);
  });

  socket.on("get-random-prompt", (cb) => {
    const room = rooms.get(socket.data.roomCode);
    cb && cb(room ? room.randomPrompt() : "a flying taco");
  });

  socket.on("submit-entry", ({ content }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "playing") return;
    const ok = room.submitEntry(socket.id, content);
    if (ok) checkStepComplete(room);
  });

  socket.on("reveal-next", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "reveal" || room.hostId !== socket.id) return;
    const book = room.books[room.revealBookIndex];
    if (room.revealEntryIndex < book.entries.length - 1) {
      room.revealEntryIndex += 1;
    } else if (room.revealBookIndex < room.books.length - 1) {
      room.revealBookIndex += 1;
      room.revealEntryIndex = 0;
    }
    io.to(room.code).emit("reveal-state", {
      revealBookIndex: room.revealBookIndex,
      revealEntryIndex: room.revealEntryIndex,
    });
  });

  socket.on("reveal-prev", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "reveal" || room.hostId !== socket.id) return;
    if (room.revealEntryIndex > 0) {
      room.revealEntryIndex -= 1;
    } else if (room.revealBookIndex > 0) {
      room.revealBookIndex -= 1;
      room.revealEntryIndex = room.books[room.revealBookIndex].entries.length - 1;
    }
    io.to(room.code).emit("reveal-state", {
      revealBookIndex: room.revealBookIndex,
      revealEntryIndex: room.revealEntryIndex,
    });
  });

  socket.on("play-again", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.phase = "lobby";
    room.books = [];
    room.order = [];
    room.currentStep = 0;
    room.submitted = new Set();
    clearTimeout(room.timer);
    broadcastLobby(room);
  });

  socket.on("leave-room", () => handleLeave(socket));
  socket.on("disconnect", () => handleLeave(socket));
});

function handleLeave(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;

  if (room.phase === "playing" && room.order.includes(socket.id) && !room.submitted.has(socket.id)) {
    room.submitEntry(socket.id, room.currentStepType() === "text" ? "..." : null);
  }

  room.removePlayer(socket.id);
  socket.leave(code);
  socket.data.roomCode = null;

  if (room.isEmpty()) {
    clearTimeout(room.timer);
    rooms.delete(code);
    return;
  }

  if (room.phase === "playing") {
    checkStepComplete(room);
  }
  broadcastLobby(room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Drawphone server running at http://localhost:${PORT}`);
});
