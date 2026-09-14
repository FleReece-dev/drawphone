const WORDS = require("./words");

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 12;

const START_SCORE = 5;
const WIN_SCORE = 20;
const CHOICE_SECONDS = 10;
const WORD_OPTIONS_COUNT = 3;

const AI_BASE_MIN_FRACTION = 0.55;
const AI_BASE_MAX_FRACTION = 0.85;
const AI_MIN_FRACTION = 0.25;
const STROKE_PULL_MS = 700;

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

function normalizeGuess(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ");
}

function pickWordOptions() {
  const pool = shuffle(WORDS);
  return pool.slice(0, WORD_OPTIONS_COUNT);
}

class Room {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.players = new Map(); // id -> {id, name, connected, score, isSpectator}
    this.phase = "lobby"; // lobby | choosing | drawing | round-end | gameover
    this.settings = { roundSeconds: 80 };

    this.order = []; // fixed rotation order of player ids, set at game start
    this.drawerPointer = -1;

    this.round = null; // current round state, see startRoundChoosing
    this.winnerId = null;

    this.choiceTimer = null;
    this.aiTimer = null;
    this.hardTimer = null;
    this.roundEndTimer = null;
  }

  get playerList() {
    return [...this.players.values()];
  }

  addPlayer(id, name) {
    this.players.set(id, { id, name, connected: true, score: START_SCORE, isSpectator: false });
    if (!this.hostId) this.hostId = id;
  }

  removePlayer(id) {
    this.players.delete(id);
    if (this.hostId === id) {
      const next = this.playerList[0];
      this.hostId = next ? next.id : null;
    }
  }

  isEmpty() {
    return this.players.size === 0;
  }

  canStart() {
    return this.phase === "lobby" && this.players.size >= MIN_PLAYERS && this.players.size <= MAX_PLAYERS;
  }

  activePlayers() {
    return this.playerList.filter((p) => !p.isSpectator);
  }

  activeGuessers() {
    const drawerId = this.round ? this.round.drawerId : null;
    return this.activePlayers().filter((p) => p.id !== drawerId);
  }

  startGame() {
    for (const p of this.players.values()) {
      p.score = START_SCORE;
      p.isSpectator = false;
    }
    this.order = shuffle(this.playerList.map((p) => p.id));
    this.drawerPointer = -1;
    this.winnerId = null;
  }

  // ---- drawer rotation ----
  pickNextDrawer() {
    if (this.activePlayers().length < MIN_PLAYERS) return null;
    const n = this.order.length;
    for (let step = 1; step <= n; step++) {
      const idx = (this.drawerPointer + step) % n;
      const pid = this.order[idx];
      const p = this.players.get(pid);
      if (p && !p.isSpectator && p.connected) {
        this.drawerPointer = idx;
        return pid;
      }
    }
    return null;
  }

  startRoundChoosing() {
    const drawerId = this.pickNextDrawer();
    if (!drawerId) {
      this.endGame();
      return false;
    }
    this.phase = "choosing";
    this.round = {
      drawerId,
      wordOptions: pickWordOptions(),
      word: null,
      correctGuessers: new Set(),
      guessLog: [],
      roundStartTime: null,
      aiDeadline: null,
      choiceDeadline: Date.now() + CHOICE_SECONDS * 1000,
    };
    return true;
  }

  chooseWord(playerId, word) {
    if (this.phase !== "choosing" || !this.round || this.round.drawerId !== playerId) return false;
    if (!this.round.wordOptions.includes(word)) return false;
    this.startDrawingPhase(word);
    return true;
  }

  autoChooseWord() {
    if (this.phase !== "choosing" || !this.round) return;
    const word = this.round.wordOptions[Math.floor(Math.random() * this.round.wordOptions.length)];
    this.startDrawingPhase(word);
  }

  startDrawingPhase(word) {
    const now = Date.now();
    const roundDurationMs = this.settings.roundSeconds * 1000;
    const wordLen = word.replace(/\s/g, "").length;
    const wordBonusMs = Math.min(4000, Math.max(0, (wordLen - 4) * 300));
    const fraction = AI_BASE_MIN_FRACTION + Math.random() * (AI_BASE_MAX_FRACTION - AI_BASE_MIN_FRACTION);

    this.round.word = word;
    this.round.roundStartTime = now;
    this.round.roundDurationMs = roundDurationMs;
    this.round.minAiDeadline = now + roundDurationMs * AI_MIN_FRACTION;
    this.round.aiDeadline = Math.min(
      now + roundDurationMs - 500,
      now + roundDurationMs * fraction + wordBonusMs
    );
    this.round.hardDeadline = now + roundDurationMs;
    this.phase = "drawing";
  }

  addStroke(playerId, stroke) {
    if (this.phase !== "drawing" || !this.round || this.round.drawerId !== playerId) return false;
    if (stroke.type === "start" || stroke.type === "move" || stroke.type === "dot") {
      this.round.aiDeadline = Math.max(this.round.minAiDeadline, this.round.aiDeadline - STROKE_PULL_MS);
    }
    return true;
  }

  submitGuess(playerId, text) {
    if (this.phase !== "drawing" || !this.round) return { ok: false };
    const player = this.players.get(playerId);
    if (!player || player.isSpectator || playerId === this.round.drawerId) return { ok: false };
    if (this.round.correctGuessers.has(playerId)) return { ok: false, alreadyGuessed: true };

    const normalized = normalizeGuess(text);
    const isCorrect = normalized.length > 0 && normalized === normalizeGuess(this.round.word);

    const entry = { playerId, name: player.name, text, correct: isCorrect, at: Date.now() };
    this.round.guessLog.push(entry);

    if (isCorrect) {
      this.round.correctGuessers.add(playerId);
      player.score += 1;
      if (player.score >= WIN_SCORE) {
        this.winnerId = playerId;
        this.phase = "gameover";
        return { ok: true, correct: true, gameOver: true, entry };
      }
      if (this.activeGuessers().every((p) => this.round.correctGuessers.has(p.id))) {
        return { ok: true, correct: true, allGuessed: true, entry };
      }
    }
    return { ok: true, correct: isCorrect, entry };
  }

  // Called when the round is over (AI guessed, everyone guessed, or drawer/timeout fallback).
  endRound() {
    const guessers = this.activeGuessers();
    const newlySpectating = [];
    for (const p of guessers) {
      if (!this.round.correctGuessers.has(p.id)) {
        p.score = Math.max(0, p.score - 1);
        if (p.score === 0) {
          p.isSpectator = true;
          newlySpectating.push(p.id);
        }
      }
    }
    const drawer = this.players.get(this.round.drawerId);
    if (drawer) drawer.score += this.round.correctGuessers.size;

    const winners = this.playerList.filter((p) => p.score >= WIN_SCORE);
    if (winners.length > 0) {
      winners.sort((a, b) => b.score - a.score);
      this.winnerId = winners[0].id;
      this.phase = "gameover";
      return { gameOver: true, newlySpectating };
    }

    if (this.activePlayers().length < MIN_PLAYERS) {
      this.endGame();
      return { gameOver: true, newlySpectating };
    }

    this.phase = "round-end";
    return { gameOver: false, newlySpectating };
  }

  endGame() {
    const active = this.activePlayers();
    let best = null;
    for (const p of this.playerList) {
      if (!best || p.score > best.score) best = p;
    }
    this.winnerId = best ? best.id : null;
    this.phase = "gameover";
  }

  resetToLobby() {
    this.phase = "lobby";
    this.round = null;
    this.order = [];
    this.drawerPointer = -1;
    this.winnerId = null;
    for (const p of this.players.values()) {
      p.score = START_SCORE;
      p.isSpectator = false;
    }
  }

  maskedWord() {
    if (!this.round || !this.round.word) return "";
    return this.round.word
      .split("")
      .map((ch) => (ch === " " ? " " : "_"))
      .join(" ");
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

  serializeScoreboard() {
    return {
      players: this.playerList.map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        isSpectator: p.isSpectator,
        connected: p.connected,
      })),
      drawerId: this.round ? this.round.drawerId : null,
      hostId: this.hostId,
    };
  }
}

module.exports = { Room, randomCode, normalizeGuess, MIN_PLAYERS, MAX_PLAYERS, START_SCORE, WIN_SCORE, CHOICE_SECONDS };
