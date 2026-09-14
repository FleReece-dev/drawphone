const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Room, randomCode, MIN_PLAYERS, MAX_PLAYERS, CHOICE_SECONDS } = require("./Room");

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

function socketFor(id) {
  return io.sockets.sockets.get(id);
}

function broadcastLobby(room) {
  io.to(room.code).emit("lobby-update", room.serializeLobby());
}

function clearAllTimers(room) {
  clearTimeout(room.choiceTimer);
  clearTimeout(room.aiTimer);
  clearTimeout(room.hardTimer);
  clearTimeout(room.roundEndTimer);
}

function scheduleAiTimer(room) {
  clearTimeout(room.aiTimer);
  const delay = Math.max(0, room.round.aiDeadline - Date.now());
  room.aiTimer = setTimeout(() => onAiGuessed(room), delay);
}

function startChoosingRound(room) {
  const ok = room.startRoundChoosing();
  if (!ok) {
    io.to(room.code).emit("game-over", { winnerId: room.winnerId, scoreboard: room.serializeScoreboard() });
    return;
  }
  const drawer = room.players.get(room.round.drawerId);
  const drawerSocket = socketFor(room.round.drawerId);
  if (drawerSocket) {
    drawerSocket.emit("choose-word-options", {
      options: room.round.wordOptions,
      deadline: room.round.choiceDeadline,
    });
  }
  io.to(room.code).emit("round-choosing", {
    drawerId: room.round.drawerId,
    drawerName: drawer ? drawer.name : "?",
    deadline: room.round.choiceDeadline,
    scoreboard: room.serializeScoreboard(),
  });

  clearTimeout(room.choiceTimer);
  room.choiceTimer = setTimeout(() => {
    if (room.phase === "choosing") {
      room.autoChooseWord();
      beginDrawingBroadcast(room);
    }
  }, CHOICE_SECONDS * 1000 + 300);
}

function beginDrawingBroadcast(room) {
  const drawerSocket = socketFor(room.round.drawerId);
  if (drawerSocket) drawerSocket.emit("your-word", { word: room.round.word });

  io.to(room.code).emit("round-drawing", {
    drawerId: room.round.drawerId,
    maskedWord: room.maskedWord(),
    wordLength: room.round.word.replace(/\s/g, "").length,
    roundSeconds: room.settings.roundSeconds,
    deadline: room.round.hardDeadline,
    scoreboard: room.serializeScoreboard(),
  });

  scheduleAiTimer(room);
  clearTimeout(room.hardTimer);
  room.hardTimer = setTimeout(() => {
    if (room.phase === "drawing") finishRound(room, "timeout");
  }, room.round.roundDurationMs + 500);
}

function onAiGuessed(room) {
  if (room.phase !== "drawing") return;
  finishRound(room, "ai");
}

function finishRound(room, reason) {
  if (!room.round) return;
  const snapshot = {
    word: room.round.word,
    drawerId: room.round.drawerId,
    correctGuessers: [...room.round.correctGuessers],
  };
  const res = room.endRound();
  clearAllTimers(room);

  io.to(room.code).emit("round-reveal", {
    ...snapshot,
    reason,
    scoreboard: room.serializeScoreboard(),
    newlySpectating: res.newlySpectating,
    gameOver: res.gameOver,
    winnerId: room.winnerId,
  });

  if (res.gameOver) {
    io.to(room.code).emit("game-over", { winnerId: room.winnerId, scoreboard: room.serializeScoreboard() });
  } else {
    room.roundEndTimer = setTimeout(() => {
      if (room.phase === "round-end") startChoosingRound(room);
    }, 5000);
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
    const roundSeconds = Math.min(180, Math.max(30, parseInt(settings.roundSeconds, 10) || room.settings.roundSeconds));
    room.settings = { roundSeconds };
    broadcastLobby(room);
  });

  socket.on("start-game", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (!room.canStart()) return;
    room.startGame();
    startChoosingRound(room);
  });

  socket.on("choose-word", ({ word }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const ok = room.chooseWord(socket.id, word);
    if (ok) {
      clearTimeout(room.choiceTimer);
      beginDrawingBroadcast(room);
    }
  });

  socket.on("stroke", (stroke) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "drawing") return;
    const ok = room.addStroke(socket.id, stroke);
    if (!ok) return;
    socket.to(room.code).emit("stroke", stroke);
    if (stroke.type === "start" || stroke.type === "move" || stroke.type === "dot") {
      scheduleAiTimer(room);
    }
  });

  socket.on("submit-guess", ({ text }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const result = room.submitGuess(socket.id, text);
    if (!result.ok) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    if (result.correct) {
      const exceptIds = [player.id, room.round.drawerId];
      io.to(room.code).except(exceptIds).emit("chat-message", { name: player.name, text: null, correct: true });
      socket.emit("chat-message", { name: player.name, text: result.entry.text, correct: true, self: true });
      if (room.round.drawerId !== player.id) {
        const drawerSocket = socketFor(room.round.drawerId);
        if (drawerSocket) drawerSocket.emit("chat-message", { name: player.name, text: result.entry.text, correct: true });
      }
    } else {
      io.to(room.code).emit("chat-message", { name: player.name, text: result.entry.text, correct: false });
    }

    if (result.gameOver) {
      clearAllTimers(room);
      io.to(room.code).emit("round-reveal", {
        word: room.round.word,
        drawerId: room.round.drawerId,
        correctGuessers: [...room.round.correctGuessers],
        reason: "win",
        scoreboard: room.serializeScoreboard(),
        gameOver: true,
        winnerId: room.winnerId,
      });
      io.to(room.code).emit("game-over", { winnerId: room.winnerId, scoreboard: room.serializeScoreboard() });
    } else if (result.allGuessed) {
      finishRound(room, "all-guessed");
    } else if (result.correct) {
      io.to(room.code).emit("scoreboard-update", room.serializeScoreboard());
    }
  });

  socket.on("play-again", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    clearAllTimers(room);
    room.resetToLobby();
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

  const midRound = room.round && (room.phase === "choosing" || room.phase === "drawing");
  const wasDrawer = midRound && room.round.drawerId === socket.id;
  const wasChoosingPhase = room.phase === "choosing";

  room.removePlayer(socket.id);
  socket.leave(code);
  socket.data.roomCode = null;

  if (room.isEmpty()) {
    clearAllTimers(room);
    rooms.delete(code);
    return;
  }

  if (room.phase === "lobby") {
    broadcastLobby(room);
    return;
  }

  if (wasDrawer) {
    clearAllTimers(room);
    if (wasChoosingPhase) {
      startChoosingRound(room);
    } else {
      const word = room.round.word;
      room.phase = "round-end";
      io.to(room.code).emit("round-reveal", {
        word,
        drawerId: null,
        correctGuessers: [...room.round.correctGuessers],
        reason: "drawer-left",
        scoreboard: room.serializeScoreboard(),
        gameOver: false,
      });
      if (room.activePlayers().length < MIN_PLAYERS) {
        room.endGame();
        io.to(room.code).emit("game-over", { winnerId: room.winnerId, scoreboard: room.serializeScoreboard() });
      } else {
        room.roundEndTimer = setTimeout(() => {
          if (room.phase === "round-end") startChoosingRound(room);
        }, 4000);
      }
    }
  } else {
    io.to(room.code).emit("scoreboard-update", room.serializeScoreboard());
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Drawphone server running at http://localhost:${PORT}`);
});
