const socket = io();

const state = {
  name: "",
  code: "",
  playerId: null,
  isHost: false,
  currentType: null, // 'text' | 'drawing'
  deadline: 0,
  timerInterval: null,
  hasSubmittedThisStep: false,
  books: [],
};

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const views = {
  home: $("#view-home"),
  lobby: $("#view-lobby"),
  game: $("#view-game"),
  reveal: $("#view-reveal"),
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
    state.playerId = res.playerId;
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
    state.playerId = res.playerId;
    history.replaceState(null, "", "?room=" + res.code);
  });
});

// auto-fill room code from URL (?room=CODE)
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

let writeSecondsDraft = 45;
let drawSecondsDraft = 80;
$("#write-seconds").addEventListener("change", (e) => {
  writeSecondsDraft = e.target.value;
  socket.emit("update-settings", { writeSeconds: writeSecondsDraft, drawSeconds: drawSecondsDraft });
});
$("#draw-seconds").addEventListener("change", (e) => {
  drawSecondsDraft = e.target.value;
  socket.emit("update-settings", { writeSeconds: writeSecondsDraft, drawSeconds: drawSecondsDraft });
});
$("#start-game-btn").addEventListener("click", () => socket.emit("start-game"));

socket.on("lobby-update", (room) => {
  state.isHost = room.hostId === socket.id;
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

  writeSecondsDraft = room.settings.writeSeconds;
  drawSecondsDraft = room.settings.drawSeconds;
  $("#write-seconds").value = room.settings.writeSeconds;
  $("#draw-seconds").value = room.settings.drawSeconds;

  $("#host-settings").classList.toggle("hidden", !state.isHost);
  $("#lobby-wait-msg").classList.toggle("hidden", state.isHost);
  $("#start-game-btn").disabled = room.players.length < 3;
});

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ---------- GAME ----------
const textEntry = $("#text-entry");
const drawEntry = $("#draw-entry");
const textInput = $("#text-input");
const canvas = $("#draw-canvas");
const ctx = canvas.getContext("2d");

textInput.addEventListener("input", () => {
  $("#char-count").textContent = `${textInput.value.length} / 80`;
});

let lastSuggestion = "";

$("#random-prompt-btn").addEventListener("click", () => {
  socket.emit("get-random-prompt", (prompt) => {
    lastSuggestion = prompt;
    textInput.value = prompt;
    $("#char-count").textContent = `${textInput.value.length} / 80`;
    textInput.focus();
  });
});

function resetGameView() {
  clearInterval(state.timerInterval);
  state.hasSubmittedThisStep = false;
  $("#waiting-overlay").classList.add("hidden");
  textEntry.classList.add("hidden");
  drawEntry.classList.add("hidden");
  $("#prompt-box").classList.add("hidden");
  $("#prev-drawing-box").classList.add("hidden");
}

socket.on("your-turn", (data) => {
  showView("game");
  resetGameView();
  state.currentType = data.type;
  state.deadline = data.deadline;
  lastSuggestion = data.promptSuggestion || "";

  $("#step-indicator").textContent = `Round ${data.step + 1} / ${data.totalSteps}`;

  if (data.prevEntry) {
    if (data.prevEntry.type === "text") {
      $("#prompt-box").classList.remove("hidden");
      $("#prompt-text").textContent = data.prevEntry.content;
    } else if (data.prevEntry.type === "drawing" && data.prevEntry.content) {
      $("#prev-drawing-box").classList.remove("hidden");
      $("#prev-drawing-img").src = data.prevEntry.content;
    }
  }

  if (data.type === "text") {
    textEntry.classList.remove("hidden");
    textInput.value = "";
    textInput.disabled = false;
    $("#char-count").textContent = "0 / 80";
    $("#submit-text-btn").disabled = false;
    setTimeout(() => textInput.focus(), 50);
  } else {
    drawEntry.classList.remove("hidden");
    initCanvasForNewTurn();
  }

  startTimer();
});

function startTimer() {
  clearInterval(state.timerInterval);
  const tick = () => {
    const remaining = Math.max(0, Math.round((state.deadline - Date.now()) / 1000));
    const el = $("#timer");
    el.textContent = remaining;
    el.classList.toggle("low", remaining <= 10);
    if (remaining <= 0) clearInterval(state.timerInterval);
  };
  tick();
  state.timerInterval = setInterval(tick, 250);
}

socket.on("step-progress", (data) => {
  $("#progress-indicator").textContent = `${data.submitted} / ${data.total} done`;
  $("#waiting-progress").textContent = `${data.submitted} / ${data.total} players have submitted`;
});

$("#submit-text-btn").addEventListener("click", () => {
  const val = textInput.value.trim();
  submitEntry(val.length ? val : lastSuggestion || "...");
});

function submitEntry(content) {
  if (state.hasSubmittedThisStep) return;
  state.hasSubmittedThisStep = true;
  socket.emit("submit-entry", { content });
  clearInterval(state.timerInterval);
  $("#waiting-overlay").classList.remove("hidden");
}

// ----- Drawing canvas -----
let drawing = false;
let brushColor = "#111111";
let brushSize = 6;
let eraseMode = false;
let undoStack = [];
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
  document.querySelectorAll(".swatch").forEach((el) => el.classList.remove("selected"));
});
$("#brush-size").addEventListener("input", (e) => (brushSize = parseInt(e.target.value, 10)));
$("#eraser-btn").addEventListener("click", () => {
  eraseMode = !eraseMode;
  $("#eraser-btn").classList.toggle("selected");
});
$("#clear-btn").addEventListener("click", () => {
  pushUndo();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
});
$("#undo-btn").addEventListener("click", () => {
  if (undoStack.length) {
    const img = undoStack.pop();
    ctx.putImageData(img, 0, 0);
  }
});

function initCanvasForNewTurn() {
  undoStack = [];
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  eraseMode = false;
  $("#eraser-btn").classList.remove("selected");
}

function pushUndo() {
  undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  if (undoStack.length > 25) undoStack.shift();
}

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

let lastPos = null;
function pointerDown(e) {
  e.preventDefault();
  pushUndo();
  drawing = true;
  lastPos = getPos(e);
  drawDot(lastPos);
}
function pointerMove(e) {
  if (!drawing) return;
  e.preventDefault();
  const pos = getPos(e);
  drawLine(lastPos, pos);
  lastPos = pos;
}
function pointerUp() {
  drawing = false;
  lastPos = null;
}

function drawDot(pos) {
  ctx.beginPath();
  ctx.fillStyle = eraseMode ? "#ffffff" : brushColor;
  ctx.arc(pos.x, pos.y, brushSize / 2, 0, Math.PI * 2);
  ctx.fill();
}
function drawLine(from, to) {
  ctx.strokeStyle = eraseMode ? "#ffffff" : brushColor;
  ctx.lineWidth = brushSize;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

canvas.addEventListener("mousedown", pointerDown);
canvas.addEventListener("mousemove", pointerMove);
window.addEventListener("mouseup", pointerUp);
canvas.addEventListener("touchstart", pointerDown, { passive: false });
canvas.addEventListener("touchmove", pointerMove, { passive: false });
canvas.addEventListener("touchend", pointerUp);

$("#submit-draw-btn").addEventListener("click", () => {
  submitEntry(canvas.toDataURL("image/png"));
});

// ---------- REVEAL ----------
socket.on("game-reveal", (data) => {
  clearInterval(state.timerInterval);
  state.books = data.books;
  state.isHost = data.hostId === socket.id;
  showView("reveal");
  $("#reveal-controls").classList.toggle("hidden", !state.isHost);
  $("#play-again-btn").classList.toggle("hidden", !state.isHost);
  renderReveal(data.revealBookIndex, data.revealEntryIndex);
});

socket.on("reveal-state", (data) => {
  renderReveal(data.revealBookIndex, data.revealEntryIndex);
});

function renderReveal(bookIndex, entryIndex) {
  const book = state.books[bookIndex];
  if (!book) return;
  $("#reveal-book-indicator").textContent = `Book ${bookIndex + 1} / ${state.books.length}`;
  $("#reveal-owner").textContent = `${book.ownerName}'s book`;

  const content = $("#reveal-content");
  content.innerHTML = "";
  const author = $("#reveal-author");

  if (entryIndex === -1 || book.entries.length === 0) {
    content.innerHTML = `<div class="reveal-text">(no entries)</div>`;
    author.textContent = "";
  } else {
    const entry = book.entries[entryIndex];
    if (entry.type === "text") {
      const div = document.createElement("div");
      div.className = "reveal-text";
      div.textContent = entry.content || "...";
      content.appendChild(div);
    } else {
      const img = document.createElement("img");
      img.src = entry.content || "";
      content.appendChild(img);
    }
    author.textContent = `— by ${entry.authorName}`;
  }

  const nextBtn = $("#reveal-next-btn");
  const atVeryEnd = bookIndex === state.books.length - 1 && entryIndex === book.entries.length - 1;
  nextBtn.textContent = atVeryEnd ? "Finished 🎉" : "Next ▶";
  nextBtn.disabled = atVeryEnd;

  const prevBtn = $("#reveal-prev-btn");
  prevBtn.disabled = bookIndex === 0 && entryIndex === 0;
}

$("#reveal-next-btn").addEventListener("click", () => socket.emit("reveal-next"));
$("#reveal-prev-btn").addEventListener("click", () => socket.emit("reveal-prev"));
$("#play-again-btn").addEventListener("click", () => socket.emit("play-again"));

socket.on("connect_error", () => toast("Connection error — retrying…"));
