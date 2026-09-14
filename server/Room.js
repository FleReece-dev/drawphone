const PROMPTS = require("./words");

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 12;

function randomCode(len = 5) {
  let s = "";
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class Room {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.players = new Map(); // id -> {id, name, connected}
    this.phase = "lobby"; // lobby | playing | reveal
    this.settings = { writeSeconds: 45, drawSeconds: 80 };

    this.order = []; // player ids, fixed at game start -> book index mapping
    this.books = []; // [{id, ownerId, ownerName, entries: [{type, authorId, authorName, content}]}]
    this.currentStep = 0;
    this.totalSteps = 0;
    this.submitted = new Set();
    this.stepDeadline = 0;
    this.timer = null;

    this.revealBookIndex = 0;
    this.revealEntryIndex = 0;
  }

  get playerList() {
    return [...this.players.values()];
  }

  addPlayer(id, name) {
    this.players.set(id, { id, name, connected: true });
    if (!this.hostId) this.hostId = id;
  }

  removePlayer(id) {
    this.players.delete(id);
    if (this.hostId === id) {
      const next = this.playerList[0];
      this.hostId = next ? next.id : null;
    }
  }

  markConnected(id, connected) {
    const p = this.players.get(id);
    if (p) p.connected = connected;
  }

  isEmpty() {
    return this.players.size === 0;
  }

  canStart() {
    return this.phase === "lobby" && this.players.size >= MIN_PLAYERS && this.players.size <= MAX_PLAYERS;
  }

  startGame() {
    this.order = shuffle(this.playerList.map((p) => p.id));
    const n = this.order.length;
    this.books = this.order.map((pid, i) => ({
      id: i,
      ownerId: pid,
      ownerName: this.players.get(pid)?.name || "?",
      entries: [],
    }));
    this.currentStep = 0;
    this.totalSteps = n;
    this.phase = "playing";
    this.revealBookIndex = 0;
    this.revealEntryIndex = 0;
  }

  currentStepType() {
    return this.currentStep % 2 === 0 ? "text" : "drawing";
  }

  currentTimeLimit() {
    return this.currentStepType() === "text" ? this.settings.writeSeconds : this.settings.drawSeconds;
  }

  bookIndexForPlayer(playerId) {
    const n = this.order.length;
    const pIndex = this.order.indexOf(playerId);
    if (pIndex === -1) return -1;
    return ((pIndex - this.currentStep) % n + n) % n;
  }

  previousEntryFor(bookIndex) {
    const entries = this.books[bookIndex].entries;
    return entries.length ? entries[entries.length - 1] : null;
  }

  assignmentsForCurrentStep() {
    // Map playerId -> { bookIndex, type, prevEntry }
    const out = {};
    for (const pid of this.order) {
      const bookIndex = this.bookIndexForPlayer(pid);
      out[pid] = {
        bookIndex,
        type: this.currentStepType(),
        prevEntry: this.previousEntryFor(bookIndex),
        isBookOwner: this.books[bookIndex].ownerId === pid,
      };
    }
    return out;
  }

  submitEntry(playerId, content) {
    if (this.phase !== "playing") return false;
    if (this.submitted.has(playerId)) return false;
    const bookIndex = this.bookIndexForPlayer(playerId);
    if (bookIndex === -1) return false;
    const player = this.players.get(playerId);
    this.books[bookIndex].entries.push({
      type: this.currentStepType(),
      authorId: playerId,
      authorName: player ? player.name : "?",
      content,
    });
    this.submitted.add(playerId);
    return true;
  }

  allSubmitted() {
    return this.order.every((pid) => this.submitted.has(pid) || !this.players.has(pid));
  }

  autoFillMissing() {
    for (const pid of this.order) {
      if (!this.submitted.has(pid)) {
        const fallback = this.currentStepType() === "text" ? "..." : null;
        this.submitEntry(pid, fallback);
      }
    }
  }

  advanceStep() {
    this.currentStep += 1;
    this.submitted = new Set();
    if (this.currentStep >= this.totalSteps) {
      this.phase = "reveal";
      return false; // no more steps
    }
    return true;
  }

  randomPrompt() {
    return PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
  }

  serializeLobby() {
    return {
      code: this.code,
      hostId: this.hostId,
      players: this.playerList,
      settings: this.settings,
      phase: this.phase,
    };
  }

  serializeReveal() {
    return {
      hostId: this.hostId,
      books: this.books,
      revealBookIndex: this.revealBookIndex,
      revealEntryIndex: this.revealEntryIndex,
    };
  }
}

module.exports = { Room, randomCode, MIN_PLAYERS, MAX_PLAYERS };
