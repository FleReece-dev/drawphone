const socket = io();

const state = {
  name: "",
  code: "",
  myId: null,
  isHost: false,
  role: null, // 'drawer' | 'guesser' | 'spectator'
  myWord: "",
  hasGuessedCorrectly: false,
  lastScoreboard: { players: [], drawerId: null },
  countdownInterval: null,
};

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const views = {
  home: $("#view-home"),
  lobby: $("#view-lobby"),
  game: $("#view-game"),
  gameover: $("#view-gameover"),
};

function showView(name) {
  Object.values(views).forEach((v) => v.classList.remove("active"));
  views[name].classList.add("active");
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

function saveSession() {
  sessionStorage.setItem("drawphone_name", state.name);
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function nameFor(id) {
  const p = state.lastScoreboard.players.find((p) => p.id === id);
  return p ? p.name : "?";
}

// ---------- HOME ----------
const nameInput = $("#name-input");
nameInput.value = sessionStorage.getItem("drawphone_name") || "";

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $("#tab-" + btn.dataset.tab).classList.add("active");
  });
});

function setHomeError(msg) {
  const el = $("#home-error");
  if (!msg) {
    el.classList.add("hidden");
    el.textContent = "";
  } else {
    el.textContent = msg;
    el.classList.remove("hidden");
  }
}

$("#create-room-btn").addEventListener("click", () => {
  const name = nameInput.value.trim();
  if (!name) return setHomeError("Enter your name first.");
  state.name = name;
  saveSession();
  socket.emit("create-room", { name }, (res) => {
    if (!res.ok) return setHomeError(res.error || "Could not create room.");
    setHomeError(null);
    state.code = res.code;
    state.myId = res.playerId;
    history.replaceState(null, "", "?room=" + res.code);
  });
});

$("#join-room-btn").addEventListener("click", () => {
  const name = nameInput.value.trim();
  const code = $("#code-input").value.trim().toUpperCase();
  if (!name) return setHomeError("Enter your name first.");
  if (!code) return setHomeError("Enter a room code.");
  state.name = name;
  saveSession();
  socket.emit("join-room", { name, code }, (res) => {
    if (!res.ok) return setHomeError(res.error || "Could not join room.");
    setHomeError(null);
    state.code = res.code;
    state.myId = res.playerId;
    history.replaceState(null, "", "?room=" + res.code);
  });
});

const urlRoom = new URLSearchParams(location.search).get("room");
if (urlRoom) {
  $("#code-input").value = urlRoom.toUpperCase();
  document.querySelector('.tab-btn[data-tab="join"]').click();
}

// ---------- LOBBY ----------
$("#copy-link-btn").addEventListener("click", () => {
  const url = location.origin + "?room=" + state.code;
  navigator.clipboard?.writeText(url).then(
    () => toast("Invite link copied!"),
    () => toast(url)
  );
});

$("#leave-room-btn").addEventListener("click", () => {
  socket.emit("leave-room");
  state.code = "";
  history.replaceState(null, "", location.pathname);
  showView("home");
});

let roundSecondsDraft = 80;
$("#round-seconds").addEventListener("change", (e) => {
  roundSecondsDraft = e.target.value;
  socket.emit("update-settings", { roundSeconds: roundSecondsDraft });
});
$("#start-game-btn").addEventListener("click", () => socket.emit("start-game"));

socket.on("lobby-update", (room) => {
  state.isHost = room.hostId === socket.id;
  clearInterval(state.countdownInterval);
  showView("lobby");
  $("#room-code").textContent = room.code;
  $("#player-count").textContent = room.players.length;

  const list = $("#player-list");
  list.innerHTML = "";
  room.players.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="dot ${p.connected ? "" : "off"}"></span><span>${escapeHtml(p.name)}</span>${
      p.id === room.hostId ? '<span class="crown">👑</span>' : ""
    }`;
    list.appendChild(li);
  });

  roundSecondsDraft = room.settings.roundSeconds;
  $("#round-seconds").value = room.settings.roundSeconds;

  $("#host-settings").classList.toggle("hidden", !state.isHost);
  $("#lobby-wait-msg").classList.toggle("hidden", state.isHost);
  $("#start-game-btn").disabled = room.players.length < 2;
});

// ---------- SCOREBOARD ----------
function renderScoreboard(sb, targetId) {
  state.lastScoreboard = sb;
  const list = $(targetId);
  list.innerHTML = "";
  const sorted = [...sb.players].sort((a, b) => b.score - a.score);
  sorted.forEach((p) => {
    const li = document.createElement("li");
    if (p.id === sb.drawerId) li.classList.add("is-drawer");
    if (p.isSpectator) li.classList.add("is-spectator");
    li.innerHTML = `<span class="sb-name">${p.id === sb.drawerId ? "✏️" : ""}${p.isSpectator ? "👀" : ""} ${escapeHtml(
      p.name
    )}${p.id === state.myId ? " (you)" : ""}</span><span class="sb-score">${p.score}</span>`;
    list.appendChild(li);
  });
}

function determineRole(sb, drawerId) {
  const me = sb.players.find((p) => p.id === state.myId);
  if (!me) return "spectator";
  if (drawerId === state.myId) return "drawer";
  if (me.isSpectator) return "spectator";
  return "guesser";
}

socket.on("scoreboard-update", (sb) => {
  renderScoreboard(sb, "#scoreboard-list");
});

// ---------- COUNTDOWN ----------
function startCountdown(pillEl, deadline, onExpire) {
  clearInterval(state.countdownInterval);
  const tick = () => {
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    pillEl.textContent = remaining;
    pillEl.classList.toggle("low", remaining <= 10);
    if (remaining <= 0) {
      clearInterval(state.countdownInterval);
      onExpire && onExpire();
    }
  };
  tick();
  state.countdownInterval = setInterval(tick, 250);
}

// ---------- CHOOSING PHASE ----------
socket.on("round-choosing", (data) => {
  showView("game");
  $("#reveal-overlay").classList.add("hidden");
  $("#choosing-block").classList.remove("hidden");
  $("#drawing-block").classList.add("hidden");
  clearCanvas();
  $("#chat-feed").innerHTML = "";
  state.hasGuessedCorrectly = false;

  renderScoreboard(data.scoreboard, "#scoreboard-list");
  state.role = determineRole(data.scoreboard, data.drawerId);

  const isMe = data.drawerId === state.myId;
  $("#choosing-self").classList.toggle("hidden", !isMe);
  $("#choosing-other").classList.toggle("hidden", isMe);
  $("#choosing-drawer-name").textContent = data.drawerName;

  startCountdown($("#choosing-pill"), data.deadline);
});

socket.on("choose-word-options", (data) => {
  const wrap = $("#word-options");
  wrap.innerHTML = "";
  data.options.forEach((word) => {
    const btn = document.createElement("button");
    btn.className = "btn primary";
    btn.textContent = word;
    btn.addEventListener("click", () => {
      wrap.querySelectorAll("button").forEach((b) => (b.disabled = true));
      socket.emit("choose-word", { word });
    });
    wrap.appendChild(btn);
  });
});

socket.on("your-word", (data) => {
  state.myWord = data.word;
});

// ---------- DRAWING PHASE ----------
socket.on("round-drawing", (data) => {
  $("#choosing-block").classList.add("hidden");
  $("#drawing-block").classList.remove("hidden");
  $("#reveal-overlay").classList.add("hidden");

  renderScoreboard(data.scoreboard, "#scoreboard-list");
  state.role = determineRole(data.scoreboard, data.drawerId);
  state.hasGuessedCorrectly = false;

  const maskedWordEl = $("#masked-word");
  maskedWordEl.textContent = state.role === "drawer" ? state.myWord : data.maskedWord;

  const rolePill = $("#role-pill");
  rolePill.textContent =
    state.role === "drawer" ? "✏️ You are drawing" : state.role === "spectator" ? "👀 Spectating" : "🤔 Guessing";

  clearCanvas();
  canvas.classList.toggle("interactive", state.role === "drawer");
  $("#toolbar").classList.toggle("hidden", state.role !== "drawer");
  $("#guess-form").classList.toggle("hidden", state.role !== "guesser");
  $("#spectator-note").classList.toggle("hidden", state.role !== "spectator");

  $("#guess-input").value = "";
  $("#guess-input").disabled = false;
  $("#guess-form").querySelector("button").disabled = false;
  if (state.role === "guesser") setTimeout(() => $("#guess-input").focus(), 50);

  startCountdown($("#timer"), data.deadline);
});

// ---------- CHAT / GUESSES ----------
const chatFeed = $("#chat-feed");
function appendChat(html, cls) {
  const div = document.createElement("div");
  div.className = "msg" + (cls ? " " + cls : "");
  div.innerHTML = html;
  chatFeed.appendChild(div);
  chatFeed.scrollTop = chatFeed.scrollHeight;
}

socket.on("chat-message", (data) => {
  const name = escapeHtml(data.name);
  if (data.correct) {
    if (data.self) {
      appendChat("You guessed it! 🎉", "self-correct");
      state.hasGuessedCorrectly = true;
      $("#guess-input").disabled = true;
      $("#guess-form").querySelector("button").disabled = true;
    } else if (data.text) {
      appendChat(`<span class="name">${name}</span> guessed: "${escapeHtml(data.text)}" ✅`, "correct");
    } else {
      appendChat(`<span class="name">${name}</span> guessed the word! ✅`, "correct");
    }
  } else {
    appendChat(`<span class="name">${name}:</span> ${escapeHtml(data.text)}`);
  }
});

const guessForm = $("#guess-form");
guessForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.role !== "guesser" || state.hasGuessedCorrectly) return;
  const input = $("#guess-input");
  const text = input.value.trim();
  if (!text) return;
  socket.emit("submit-guess", { text });
  input.value = "";
});

// ---------- ROUND REVEAL ----------
socket.on("round-reveal", (data) => {
  clearInterval(state.countdownInterval);
  renderScoreboard(data.scoreboard, "#scoreboard-list");

  const overlay = $("#reveal-overlay");
  $("#reveal-word").textContent = data.word;

  let summary = "";
  if (data.reason === "win") {
    summary = `${escapeHtml(nameFor(data.winnerId))} nailed it and won the whole game! 🏆`;
  } else if (data.reason === "drawer-left") {
    summary = "The drawer left before finishing this round — no points changed.";
  } else {
    const others = data.scoreboard.players.filter((p) => p.id !== data.drawerId);
    const gotIt = others.filter((p) => data.correctGuessers.includes(p.id)).map((p) => p.name);
    const missed = others.filter((p) => !data.correctGuessers.includes(p.id)).map((p) => p.name);
    const prefix =
      data.reason === "ai"
        ? "The AI guessed it first!"
        : data.reason === "all-guessed"
        ? "Everyone beat the AI!"
        : "Time's up!";
    summary += `<div>${prefix}</div>`;
    summary += `<div>✅ Beat the AI: ${gotIt.length ? escapeHtml(gotIt.join(", ")) : "nobody"}</div>`;
    if (missed.length) summary += `<div>💔 Lost a point: ${escapeHtml(missed.join(", "))}</div>`;
    if (data.newlySpectating && data.newlySpectating.length) {
      summary += `<div>😢 Out of points, now spectating: ${escapeHtml(
        data.newlySpectating.map(nameFor).join(", ")
      )}</div>`;
    }
  }
  $("#reveal-summary").innerHTML = summary;
  overlay.classList.remove("hidden");
});

// ---------- GAME OVER ----------
socket.on("game-over", (data) => {
  clearInterval(state.countdownInterval);
  setTimeout(() => {
    showView("gameover");
    renderScoreboard(data.scoreboard, "#final-scoreboard");
    $("#winner-name").textContent = `${nameFor(data.winnerId)} wins!`;
    state.isHost = data.scoreboard.hostId === state.myId;
    $("#play-again-btn").classList.toggle("hidden", !state.isHost);
    $("#play-again-wait").classList.toggle("hidden", state.isHost);
  }, 2000);
});

$("#play-again-btn").addEventListener("click", () => socket.emit("play-again"));

// ---------- CANVAS DRAWING ----------
const canvas = $("#draw-canvas");
const ctx = canvas.getContext("2d");
let drawing = false;
let brushColor = "#111111";
let brushSize = 6;
let eraseMode = false;
let lastPos = null;
let remoteLastPos = null;
const PALETTE = ["#111111", "#e5484d", "#ff8a3d", "#f4c531", "#3ecf5e", "#3d8bff", "#7c5cff", "#ffffff"];

function buildSwatches() {
  const wrap = $("#color-swatches");
  wrap.innerHTML = "";
  PALETTE.forEach((c) => {
    const s = document.createElement("div");
    s.className = "swatch" + (c === brushColor ? " selected" : "");
    s.style.background = c;
    s.style.border = c === "#ffffff" ? "2px solid #ccc" : "2px solid white";
    s.addEventListener("click", () => {
      brushColor = c;
      eraseMode = false;
      $("#eraser-btn").classList.remove("selected");
      document.querySelectorAll(".swatch").forEach((el) => el.classList.remove("selected"));
      s.classList.add("selected");
    });
    wrap.appendChild(s);
  });
}
buildSwatches();

$("#color-picker").addEventListener("input", (e) => {
  brushColor = e.target.value;
  eraseMode = false;
  $("#eraser-btn").classList.remove("selected");
  document.querySelectorAll(".swatch").forEach((el) => el.classList.remove("selected"));
});
$("#brush-size").addEventListener("input", (e) => (brushSize = parseInt(e.target.value, 10)));
$("#eraser-btn").addEventListener("click", () => {
  eraseMode = !eraseMode;
  $("#eraser-btn").classList.toggle("selected");
});
$("#clear-btn").addEventListener("click", () => {
  if (state.role !== "drawer") return;
  clearCanvas();
  socket.emit("stroke", { type: "clear" });
});

function clearCanvas() {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
clearCanvas();

function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const point = e.touches ? e.touches[0] : e;
  return {
    x: (point.clientX - rect.left) * scaleX,
    y: (point.clientY - rect.top) * scaleY,
  };
}

function drawDotAt(pos, color, size) {
  ctx.beginPath();
  ctx.fillStyle = color;
  ctx.arc(pos.x, pos.y, size / 2, 0, Math.PI * 2);
  ctx.fill();
}
function drawLineBetween(from, to, color, size) {
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

function pointerDown(e) {
  if (state.role !== "drawer") return;
  e.preventDefault();
  drawing = true;
  lastPos = getPos(e);
  const color = eraseMode ? "#ffffff" : brushColor;
  drawDotAt(lastPos, color, brushSize);
  socket.emit("stroke", { type: "start", x: lastPos.x, y: lastPos.y, color, size: brushSize });
}
function pointerMove(e) {
  if (state.role !== "drawer" || !drawing) return;
  e.preventDefault();
  const pos = getPos(e);
  const color = eraseMode ? "#ffffff" : brushColor;
  drawLineBetween(lastPos, pos, color, brushSize);
  socket.emit("stroke", { type: "move", x: pos.x, y: pos.y, color, size: brushSize });
  lastPos = pos;
}
function pointerUp() {
  drawing = false;
  lastPos = null;
}

canvas.addEventListener("mousedown", pointerDown);
canvas.addEventListener("mousemove", pointerMove);
window.addEventListener("mouseup", pointerUp);
canvas.addEventListener("touchstart", pointerDown, { passive: false });
canvas.addEventListener("touchmove", pointerMove, { passive: false });
canvas.addEventListener("touchend", pointerUp);

socket.on("stroke", (stroke) => {
  if (stroke.type === "clear") {
    clearCanvas();
    remoteLastPos = null;
  } else if (stroke.type === "start" || stroke.type === "dot") {
    remoteLastPos = { x: stroke.x, y: stroke.y };
    drawDotAt(remoteLastPos, stroke.color, stroke.size);
  } else if (stroke.type === "move") {
    const to = { x: stroke.x, y: stroke.y };
    if (remoteLastPos) drawLineBetween(remoteLastPos, to, stroke.color, stroke.size);
    remoteLastPos = to;
  }
});

socket.on("connect_error", () => toast("Connection error — retrying…"));
