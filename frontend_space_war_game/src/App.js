import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

const PRIMARY = '#3b82f6';
const ACCENT = '#06b6d4';

const GAME_CONFIG = {
  logicalWidth: 800,
  logicalHeight: 600,
  maxCanvasWidth: 900,

  player: {
    radius: 18,
    speed: 320, // units/sec
    fireCooldownMs: 160,
    maxHealth: 100,
    invulnerableMsAfterHit: 900
  },

  bullet: {
    radius: 4,
    speed: 680,
    maxAliveMs: 1200
  },

  enemy: {
    radius: 18,
    baseSpeed: 130,
    baseSpawnIntervalMs: 900,
    minSpawnIntervalMs: 260
  },

  difficulty: {
    // difficulty grows over time: affects spawn interval, enemy speed, and wave size
    rampPerSecond: 0.05,
    maxDifficulty: 5
  },

  lives: 3
};

const STORAGE_KEYS = {
  playerName: 'spacewar.playerName.v1',
  scores: 'spacewar.scores.v1'
};

const MAX_HIGH_SCORES = 10;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function length2(x, y) {
  return Math.sqrt(x * x + y * y);
}

function circleHit(ax, ay, ar, bx, by, br) {
  const dx = ax - bx;
  const dy = ay - by;
  const rr = ar + br;
  return dx * dx + dy * dy <= rr * rr;
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function formatInt(n) {
  return new Intl.NumberFormat().format(n);
}

// Small utility: stable random between min and max
function rand(min, max) {
  return min + Math.random() * (max - min);
}

function safeGetLocalStorage() {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch (_) {
    return null;
  }
}

/**
 * Read the saved player name from localStorage.
 * Returns empty string if missing/unavailable.
 */
function readPlayerName() {
  const ls = safeGetLocalStorage();
  if (!ls) return '';
  const raw = ls.getItem(STORAGE_KEYS.playerName);
  return typeof raw === 'string' ? raw : '';
}

/**
 * Persist player name to localStorage.
 */
function writePlayerName(name) {
  const ls = safeGetLocalStorage();
  if (!ls) return;
  ls.setItem(STORAGE_KEYS.playerName, name);
}

/**
 * @typedef {{ player: string, score: number, timeAliveSec: number, at: string }} ScoreEntry
 */

/**
 * Read high score entries from localStorage.
 * @returns {ScoreEntry[]}
 */
function readHighScores() {
  const ls = safeGetLocalStorage();
  if (!ls) return [];
  try {
    const raw = ls.getItem(STORAGE_KEYS.scores);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        e =>
          e &&
          typeof e === 'object' &&
          typeof e.player === 'string' &&
          typeof e.score === 'number' &&
          typeof e.timeAliveSec === 'number' &&
          typeof e.at === 'string'
      )
      .map(e => ({
        player: e.player,
        score: e.score,
        timeAliveSec: e.timeAliveSec,
        at: e.at
      }));
  } catch (_) {
    return [];
  }
}

/**
 * Persist high score entries to localStorage.
 * @param {ScoreEntry[]} scores
 */
function writeHighScores(scores) {
  const ls = safeGetLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(STORAGE_KEYS.scores, JSON.stringify(scores));
  } catch (_) {
    // ignore storage quota errors etc.
  }
}

/**
 * Insert a new score into the high score list, keeping it sorted and trimmed.
 * @param {ScoreEntry[]} scores
 * @param {ScoreEntry} entry
 * @returns {ScoreEntry[]}
 */
function upsertHighScore(scores, entry) {
  const next = [...scores, entry]
    .sort((a, b) => b.score - a.score || b.timeAliveSec - a.timeAliveSec)
    .slice(0, MAX_HIGH_SCORES);
  return next;
}

function makeInitialState() {
  return {
    screen: 'start', // start | playing | gameover | leaderboard
    score: 0,
    lives: GAME_CONFIG.lives,
    health: GAME_CONFIG.player.maxHealth,
    difficulty: 1,
    timeAliveSec: 0,

    player: {
      x: GAME_CONFIG.logicalWidth / 2,
      y: GAME_CONFIG.logicalHeight - 70,
      vx: 0,
      vy: 0,
      radius: GAME_CONFIG.player.radius,
      lastShotAtMs: -Infinity,
      lastHitAtMs: -Infinity
    },

    bullets: [],
    enemies: [],
    particles: [],

    // spawning
    nextSpawnAtMs: 0
  };
}

function computeCanvasSize(containerWidthPx) {
  const maxW = Math.min(containerWidthPx, GAME_CONFIG.maxCanvasWidth);
  const aspect = GAME_CONFIG.logicalWidth / GAME_CONFIG.logicalHeight;
  let w = maxW;
  let h = w / aspect;

  // Clamp height to avoid extremely tall canvas on small viewports; keep aspect by reducing width.
  const maxH = Math.min(window.innerHeight * 0.62, 720);
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }

  return { cssWidth: Math.floor(w), cssHeight: Math.floor(h) };
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawShip(ctx, x, y, radius, color, facingUp = true) {
  // Simple triangular ship; facingUp means the tip is upward.
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 2;

  ctx.beginPath();
  if (facingUp) {
    ctx.moveTo(0, -radius);
    ctx.lineTo(radius * 0.85, radius);
    ctx.lineTo(0, radius * 0.55);
    ctx.lineTo(-radius * 0.85, radius);
  } else {
    ctx.moveTo(0, radius);
    ctx.lineTo(radius * 0.85, -radius);
    ctx.lineTo(0, -radius * 0.55);
    ctx.lineTo(-radius * 0.85, -radius);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // cockpit
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.ellipse(0, -radius * 0.15, radius * 0.28, radius * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawStarfield(ctx, w, h, t) {
  // Lightweight animated starfield; deterministic positions based on indices.
  ctx.save();
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < 70; i += 1) {
    const px = (i * 131) % w;
    const py = ((i * 71 + t * 0.04 * (1 + (i % 3))) % h + h) % h;
    const size = 1 + (i % 3);
    ctx.fillStyle = `rgba(255,255,255,${0.15 + (i % 5) * 0.06})`;
    ctx.fillRect(px, py, size, size);
  }
  ctx.restore();
}

// Simple audio hook (optional; gracefully no-ops if Audio isn't available)
function useSfx() {
  const ctxRef = useRef(null);

  const getCtx = () => {
    if (typeof window === 'undefined') return null;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!ctxRef.current) ctxRef.current = new AudioCtx();
    return ctxRef.current;
  };

  const playBeep = useCallback((frequency, durationMs, type = 'sine', gain = 0.04) => {
    const ctx = getCtx();
    if (!ctx) return;

    // Some browsers require user gesture; if suspended, try resume and continue.
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    g.gain.value = gain;

    osc.connect(g);
    g.connect(ctx.destination);

    const t0 = ctx.currentTime;
    osc.start(t0);
    osc.stop(t0 + durationMs / 1000);

    // gentle fade-out to avoid clicks
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + durationMs / 1000);
  }, []);

  return useMemo(
    () => ({
      shoot: () => playBeep(860, 50, 'square', 0.03),
      hit: () => playBeep(160, 90, 'sawtooth', 0.05),
      explode: () => playBeep(90, 160, 'triangle', 0.05),
      start: () => playBeep(520, 120, 'sine', 0.03)
    }),
    [playBeep]
  );
}

// PUBLIC_INTERFACE
function App() {
  /** Main entry point for the Space War game UI + canvas gameplay. */
  const sfx = useSfx();

  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  const keysDownRef = useRef(new Set());
  const pointerRef = useRef({ active: false, x: 0, y: 0 }); // for optional touch/mouse movement
  const rafRef = useRef(0);
  const lastFrameAtMsRef = useRef(0);

  const [state, setState] = useState(() => makeInitialState());
  const [canvasCssSize, setCanvasCssSize] = useState(() => ({ cssWidth: 800, cssHeight: 600 }));

  // Identity + storage-backed stats
  const [playerName, setPlayerName] = useState(() => readPlayerName());
  const [playerNameDraft, setPlayerNameDraft] = useState(() => readPlayerName());
  const [highScores, setHighScores] = useState(() => readHighScores());
  const previousScreenRef = useRef('start');

  const hasPlayerName = playerName.trim().length > 0;
  const currentTopScore = highScores.length > 0 ? highScores[0] : null;

  const refreshHighScores = useCallback(() => {
    setHighScores(readHighScores());
  }, []);

  const openLeaderboard = useCallback(() => {
    refreshHighScores();
    setState(prev => {
      previousScreenRef.current = prev.screen;
      return { ...prev, screen: 'leaderboard' };
    });
  }, [refreshHighScores]);

  const closeLeaderboard = useCallback(() => {
    setState(prev => ({ ...prev, screen: previousScreenRef.current || 'start' }));
  }, []);

  const persistPlayerName = useCallback(name => {
    const trimmed = name.trim();
    setPlayerName(trimmed);
    setPlayerNameDraft(trimmed);
    writePlayerName(trimmed);
  }, []);

  const clearPlayerName = useCallback(() => {
    persistPlayerName('');
  }, [persistPlayerName]);

  const resetToStart = useCallback(() => {
    setState(() => ({ ...makeInitialState(), screen: 'start' }));
  }, []);

  const startGame = useCallback(() => {
    if (!hasPlayerName) return; // safety: UI should prevent starting without a name
    sfx.start();
    const ms = nowMs();
    setState(() => {
      const st = makeInitialState();
      st.screen = 'playing';
      st.nextSpawnAtMs = ms + 600;
      return st;
    });
    lastFrameAtMsRef.current = ms;
  }, [hasPlayerName, sfx]);

  const restartGame = useCallback(() => {
    startGame();
  }, [startGame]);

  const recordScoreAndGameOver = useCallback(() => {
    setState(prev => {
      const entry = {
        player: playerName.trim() || 'Player',
        score: prev.score,
        timeAliveSec: prev.timeAliveSec,
        at: new Date().toISOString()
      };

      const updated = upsertHighScore(readHighScores(), entry);
      writeHighScores(updated);
      setHighScores(updated);

      return { ...prev, screen: 'gameover' };
    });
  }, [playerName]);

  // Resize observer-ish (window resize + initial)
  useEffect(() => {
    const recompute = () => {
      const containerW =
        containerRef.current?.getBoundingClientRect?.().width ?? Math.min(window.innerWidth, GAME_CONFIG.maxCanvasWidth);

      setCanvasCssSize(computeCanvasSize(containerW));
    };
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, []);

  // Keyboard controls
  useEffect(() => {
    const onKeyDown = e => {
      const key = e.key.toLowerCase();

      // prevent page scroll on arrows/space when playing
      if (state.screen === 'playing') {
        if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(e.key.toLowerCase())) {
          e.preventDefault();
        }
      }

      keysDownRef.current.add(key);

      // convenient shortcuts
      if (key === 'enter') {
        if (state.screen === 'start') startGame();
        if (state.screen === 'gameover') restartGame();
      }
      if (key === 'escape') {
        if (state.screen === 'leaderboard') {
          closeLeaderboard();
        } else if (state.screen === 'playing') {
          // soft pause by returning to start; keeps it simple
          resetToStart();
        }
      }
    };

    const onKeyUp = e => {
      keysDownRef.current.delete(e.key.toLowerCase());
    };

    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [closeLeaderboard, resetToStart, restartGame, startGame, state.screen]);

  // Pointer controls (optional): drag to move, tap to shoot when playing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const toLogical = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * GAME_CONFIG.logicalWidth;
      const y = ((clientY - rect.top) / rect.height) * GAME_CONFIG.logicalHeight;
      return { x, y };
    };

    const onPointerDown = e => {
      if (state.screen !== 'playing') return;
      pointerRef.current.active = true;
      const p = toLogical(e.clientX, e.clientY);
      pointerRef.current.x = p.x;
      pointerRef.current.y = p.y;
    };

    const onPointerMove = e => {
      if (!pointerRef.current.active) return;
      const p = toLogical(e.clientX, e.clientY);
      pointerRef.current.x = p.x;
      pointerRef.current.y = p.y;
    };

    const onPointerUp = () => {
      pointerRef.current.active = false;
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
    };
  }, [state.screen]);

  const spawnEnemy = useCallback((st, ms) => {
    const difficulty = st.difficulty;

    // Basic wave logic: sometimes spawn 2 at higher difficulty.
    const waveSize =
      1 +
      (difficulty >= 2.3
        ? Math.random() < Math.min(0.45, (difficulty - 2) * 0.18)
          ? 1
          : 0
        : 0);

    for (let i = 0; i < waveSize; i += 1) {
      const radius = GAME_CONFIG.enemy.radius;
      const x = rand(radius + 10, GAME_CONFIG.logicalWidth - radius - 10);
      const y = -radius - rand(0, 60);
      const speed = GAME_CONFIG.enemy.baseSpeed * (0.9 + 0.18 * difficulty) * rand(0.9, 1.15);
      const vx = rand(-0.22, 0.22) * speed;
      const vy = speed;
      st.enemies.push({
        id: `${ms}-${Math.random().toString(16).slice(2)}`,
        x,
        y,
        vx,
        vy,
        radius,
        hp: 1,
        kind: 'basic'
      });
    }

    // Spawn interval shrinks with difficulty.
    const base = GAME_CONFIG.enemy.baseSpawnIntervalMs;
    const min = GAME_CONFIG.enemy.minSpawnIntervalMs;
    const interval = clamp(base / (1 + 0.55 * (difficulty - 1)), min, base);
    st.nextSpawnAtMs = ms + interval;
  }, []);

  const shoot = useCallback(
    (st, ms) => {
      if (ms - st.player.lastShotAtMs < GAME_CONFIG.player.fireCooldownMs) return;
      st.player.lastShotAtMs = ms;

      st.bullets.push({
        id: `${ms}-${Math.random().toString(16).slice(2)}`,
        x: st.player.x,
        y: st.player.y - st.player.radius - 6,
        vx: 0,
        vy: -GAME_CONFIG.bullet.speed,
        radius: GAME_CONFIG.bullet.radius,
        bornAtMs: ms
      });

      sfx.shoot();
    },
    [sfx]
  );

  const step = useCallback(
    (prev, dtSec, ms) => {
      if (prev.screen !== 'playing') return prev;

      // Use structured clone-style updates for React state (cheap enough for this project).
      const st = {
        ...prev,
        player: { ...prev.player },
        bullets: prev.bullets.map(b => ({ ...b })),
        enemies: prev.enemies.map(en => ({ ...en })),
        particles: prev.particles.map(p => ({ ...p }))
      };

      st.timeAliveSec = prev.timeAliveSec + dtSec;

      // Difficulty ramps over time.
      const difficulty = clamp(
        1 + st.timeAliveSec * GAME_CONFIG.difficulty.rampPerSecond,
        1,
        GAME_CONFIG.difficulty.maxDifficulty
      );
      st.difficulty = difficulty;

      // Movement input
      const keys = keysDownRef.current;
      const up = keys.has('w') || keys.has('arrowup');
      const down = keys.has('s') || keys.has('arrowdown');
      const left = keys.has('a') || keys.has('arrowleft');
      const right = keys.has('d') || keys.has('arrowright');
      const firing = keys.has(' ') || keys.has('space');

      let ix = 0;
      let iy = 0;
      if (left) ix -= 1;
      if (right) ix += 1;
      if (up) iy -= 1;
      if (down) iy += 1;

      const mag = length2(ix, iy);
      const sp = GAME_CONFIG.player.speed * (pointerRef.current.active ? 0.85 : 1);

      if (mag > 0) {
        ix /= mag;
        iy /= mag;
      }

      // Optional pointer steering: move toward pointer when active
      if (pointerRef.current.active) {
        const dx = pointerRef.current.x - st.player.x;
        const dy = pointerRef.current.y - st.player.y;
        const d = length2(dx, dy);
        if (d > 5) {
          ix = dx / d;
          iy = dy / d;
        } else {
          ix = 0;
          iy = 0;
        }
      }

      st.player.vx = ix * sp;
      st.player.vy = iy * sp;

      st.player.x = clamp(
        st.player.x + st.player.vx * dtSec,
        st.player.radius,
        GAME_CONFIG.logicalWidth - st.player.radius
      );
      st.player.y = clamp(
        st.player.y + st.player.vy * dtSec,
        st.player.radius,
        GAME_CONFIG.logicalHeight - st.player.radius
      );

      if (firing) shoot(st, ms);

      // Spawn enemies
      if (ms >= st.nextSpawnAtMs) {
        spawnEnemy(st, ms);
      }

      // Update bullets
      st.bullets = st.bullets
        .map(b => {
          b.x += b.vx * dtSec;
          b.y += b.vy * dtSec;
          return b;
        })
        .filter(b => ms - b.bornAtMs < GAME_CONFIG.bullet.maxAliveMs && b.y > -40);

      // Update enemies
      const enemySpeedScale = 1 + 0.07 * (difficulty - 1);
      st.enemies = st.enemies
        .map(en => {
          en.x += en.vx * dtSec * enemySpeedScale;
          en.y += en.vy * dtSec * enemySpeedScale;

          // bounce off side walls softly
          if (en.x < en.radius) {
            en.x = en.radius;
            en.vx = Math.abs(en.vx);
          } else if (en.x > GAME_CONFIG.logicalWidth - en.radius) {
            en.x = GAME_CONFIG.logicalWidth - en.radius;
            en.vx = -Math.abs(en.vx);
          }

          return en;
        })
        .filter(en => en.y < GAME_CONFIG.logicalHeight + 80);

      // Collisions: bullets vs enemies
      const bulletsToRemove = new Set();
      const enemiesToRemove = new Set();

      for (let bi = 0; bi < st.bullets.length; bi += 1) {
        const b = st.bullets[bi];
        for (let ei = 0; ei < st.enemies.length; ei += 1) {
          const en = st.enemies[ei];
          if (circleHit(b.x, b.y, b.radius, en.x, en.y, en.radius)) {
            bulletsToRemove.add(b.id);
            enemiesToRemove.add(en.id);
            st.score += Math.floor(100 * (1 + 0.12 * (difficulty - 1)));

            // particles
            for (let i = 0; i < 8; i += 1) {
              st.particles.push({
                id: `${ms}-p-${Math.random().toString(16).slice(2)}`,
                x: en.x,
                y: en.y,
                vx: rand(-120, 120),
                vy: rand(-120, 120),
                bornAtMs: ms,
                aliveMs: 420,
                color: i % 2 === 0 ? ACCENT : PRIMARY
              });
            }

            sfx.hit();
            break;
          }
        }
      }

      if (bulletsToRemove.size > 0) {
        st.bullets = st.bullets.filter(b => !bulletsToRemove.has(b.id));
      }
      if (enemiesToRemove.size > 0) {
        st.enemies = st.enemies.filter(en => !enemiesToRemove.has(en.id));
      }

      // Collisions: enemies vs player
      const invuln = ms - st.player.lastHitAtMs < GAME_CONFIG.player.invulnerableMsAfterHit;
      if (!invuln) {
        for (const en of st.enemies) {
          if (circleHit(st.player.x, st.player.y, st.player.radius, en.x, en.y, en.radius)) {
            st.player.lastHitAtMs = ms;
            st.health -= 28;

            // remove the enemy on hit
            st.enemies = st.enemies.filter(e => e.id !== en.id);

            // more particles
            for (let i = 0; i < 14; i += 1) {
              st.particles.push({
                id: `${ms}-ph-${Math.random().toString(16).slice(2)}`,
                x: st.player.x,
                y: st.player.y,
                vx: rand(-180, 180),
                vy: rand(-180, 180),
                bornAtMs: ms,
                aliveMs: 520,
                color: '#ef4444'
              });
            }

            sfx.explode();
            break;
          }
        }
      }

      // Health/lives handling
      if (st.health <= 0) {
        st.lives -= 1;
        st.health = GAME_CONFIG.player.maxHealth;
        st.player.lastHitAtMs = ms; // brief invuln on respawn

        // reposition player
        st.player.x = GAME_CONFIG.logicalWidth / 2;
        st.player.y = GAME_CONFIG.logicalHeight - 70;

        if (st.lives <= 0) {
          // Persist score and go to gameover screen.
          return { ...st, screen: 'gameover' };
        }
      }

      // Particles
      st.particles = st.particles
        .map(p => {
          p.x += p.vx * dtSec;
          p.y += p.vy * dtSec;
          return p;
        })
        .filter(p => ms - p.bornAtMs < p.aliveMs);

      return st;
    },
    [shoot, spawnEnemy, sfx]
  );

  // When state transitions to gameover (from gameplay), persist score.
  useEffect(() => {
    if (state.screen !== 'gameover') return;
    // If we arrived here via recordScoreAndGameOver, it already wrote; but calling again is harmless
    // because we read/append/write idempotently by always adding an entry (still acceptable for now).
    // To avoid double entries, we only auto-record when we last came from playing.
    // We don't track previous screen in state, so we do a minimal guard:
    // only record if the last entry doesn't match this exact score/time/player.
    const existing = readHighScores();
    const latest = existing[0];
    const signatureMatches =
      latest &&
      latest.player === (playerName.trim() || 'Player') &&
      latest.score === state.score &&
      Math.abs(latest.timeAliveSec - state.timeAliveSec) < 0.001;

    if (!signatureMatches) {
      const entry = {
        player: playerName.trim() || 'Player',
        score: state.score,
        timeAliveSec: state.timeAliveSec,
        at: new Date().toISOString()
      };
      const updated = upsertHighScore(existing, entry);
      writeHighScores(updated);
      setHighScores(updated);
    }
  }, [playerName, state.score, state.screen, state.timeAliveSec]);

  const renderFrame = useCallback(st => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = GAME_CONFIG.logicalWidth;
    const h = GAME_CONFIG.logicalHeight;

    // Background
    drawStarfield(ctx, w, h, st.timeAliveSec);

    // Soft vignette / border
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, w - 2, h - 2);
    ctx.restore();

    // Entities
    // Bullets
    ctx.save();
    ctx.fillStyle = ACCENT;
    for (const b of st.bullets) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Enemies
    for (const en of st.enemies) {
      drawShip(ctx, en.x, en.y, en.radius, 'rgba(239, 68, 68, 0.95)', false);
    }

    // Player (blink while invulnerable)
    const invuln = st.screen === 'playing' && nowMs() - st.player.lastHitAtMs < GAME_CONFIG.player.invulnerableMsAfterHit;
    const shouldDrawPlayer = !invuln || Math.floor(nowMs() / 100) % 2 === 0;
    if (shouldDrawPlayer) {
      drawShip(ctx, st.player.x, st.player.y, st.player.radius, PRIMARY, true);
    }

    // Particles
    for (const p of st.particles) {
      const age = clamp((nowMs() - p.bornAtMs) / p.aliveMs, 0, 1);
      ctx.save();
      ctx.globalAlpha = 1 - age;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, 3, 3);
      ctx.restore();
    }

    // Overlay hints when playing
    if (st.screen === 'playing') {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      drawRoundedRect(ctx, 12, h - 48, 240, 34, 10);
      ctx.fill();

      ctx.fillStyle = 'rgba(255,255,255,0.78)';
      ctx.font = '600 12px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
      ctx.fillText('Move: WASD/Arrows  •  Shoot: Space', 24, h - 27);
      ctx.restore();
    }

    // If not playing, draw a subtle overlay to "dim" the canvas behind UI
    if (st.screen !== 'playing') {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }, []);

  // Game loop
  useEffect(() => {
    const loop = ms => {
      rafRef.current = requestAnimationFrame(loop);

      const last = lastFrameAtMsRef.current || ms;
      const dtMs = ms - last;
      const dtSec = clamp(dtMs / 1000, 0, 0.05);
      lastFrameAtMsRef.current = ms;

      setState(prev => {
        const next = step(prev, dtSec, ms);
        // Detect transition to gameover to persist score (avoid requiring deterministic gameplay in tests).
        if (prev.screen === 'playing' && next.screen === 'gameover') {
          // Persist score once when we hit gameover.
          // (We don't call recordScoreAndGameOver here to avoid nested setState.)
          const entry = {
            player: playerName.trim() || 'Player',
            score: next.score,
            timeAliveSec: next.timeAliveSec,
            at: new Date().toISOString()
          };
          const updated = upsertHighScore(readHighScores(), entry);
          writeHighScores(updated);
          setHighScores(updated);
        }
        return next;
      });
    };

    // Always run RAF: we render even on start/gameover (dimmed canvas) for a lively background.
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playerName, step]);

  // Canvas setup: keep a fixed logical resolution, scale with CSS for responsiveness.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = GAME_CONFIG.logicalWidth;
    canvas.height = GAME_CONFIG.logicalHeight;
  }, []);

  // Separate render pass to canvas (from React state)
  useEffect(() => {
    renderFrame(state);
  }, [renderFrame, state]);

  const healthPct = clamp(state.health / GAME_CONFIG.player.maxHealth, 0, 1);
  const difficultyLabel = state.difficulty.toFixed(1);

  const onSubmitPlayerName = e => {
    e.preventDefault();
    const trimmed = playerNameDraft.trim();
    if (!trimmed) return;
    persistPlayerName(trimmed);
  };

  const formatWhen = iso => {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
    } catch (_) {
      return iso;
    }
  };

  const leaderboardTitle = useMemo(() => {
    if (state.screen !== 'leaderboard') return '';
    const from = previousScreenRef.current;
    if (from === 'gameover') return 'Leaderboard';
    if (from === 'playing') return 'Leaderboard';
    return 'Leaderboard';
  }, [state.screen]);

  return (
    <div className="App">
      <main className="page">
        <header className="topbar">
          <div className="brand">
            <div className="brandMark" aria-hidden="true" />
            <div className="brandText">
              <div className="brandTitle">Space War</div>
              <div className="brandSubtitle">React + Canvas</div>
            </div>
          </div>

          <div className="hud" role="status" aria-live="polite">
            <div className="hudItem">
              <div className="hudLabel">Player</div>
              <div className="hudValue" data-testid="hud-player">
                {hasPlayerName ? playerName : '—'}
              </div>
            </div>

            <div className="hudItem">
              <div className="hudLabel">High Score</div>
              <div className="hudValue" data-testid="hud-high-score">
                {currentTopScore ? formatInt(currentTopScore.score) : '—'}
              </div>
            </div>

            <div className="hudItem">
              <div className="hudLabel">Score</div>
              <div className="hudValue" data-testid="hud-score">
                {formatInt(state.score)}
              </div>
            </div>

            <div className="hudItem hudHealth">
              <div className="hudLabel">Health</div>
              <div className="healthBar" aria-label={`Health ${Math.round(healthPct * 100)} percent`}>
                <div className="healthFill" style={{ width: `${Math.round(healthPct * 100)}%` }} />
              </div>
            </div>

            <div className="hudItem">
              <div className="hudLabel">Lives</div>
              <div className="hudValue" data-testid="hud-lives">
                {state.lives}
              </div>
            </div>

            <div className="hudItem">
              <div className="hudLabel">Difficulty</div>
              <div className="hudValue" data-testid="hud-difficulty">
                {difficultyLabel}
              </div>
            </div>

            <div className="hudItem">
              <div className="hudLabel">Menu</div>
              <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btnGhost" onClick={openLeaderboard} type="button">
                  Leaderboard
                </button>
              </div>
            </div>
          </div>
        </header>

        <section className="gameShell" ref={containerRef}>
          <div className="canvasFrame">
            <canvas
              ref={canvasRef}
              className="gameCanvas"
              style={{ width: `${canvasCssSize.cssWidth}px`, height: `${canvasCssSize.cssHeight}px` }}
              aria-label="Space War game canvas"
              role="img"
            />
          </div>

          {state.screen === 'start' && (
            <div className="overlay" role="dialog" aria-label="Start screen">
              <div className="card">
                <h1 className="title">Space War</h1>
                <p className="subtitle">Pilot your ship, shoot incoming enemies, and survive as the waves accelerate.</p>

                {!hasPlayerName && (
                  <>
                    <p className="subtitle" style={{ marginTop: 14 }}>
                      Enter a player name to begin. This is stored locally in your browser.
                    </p>

                    <form onSubmit={onSubmitPlayerName} aria-label="Player name form" style={{ marginTop: 12 }}>
                      <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', fontWeight: 700 }}>
                        Player name
                      </label>
                      <input
                        aria-label="Player name"
                        value={playerNameDraft}
                        onChange={e => setPlayerNameDraft(e.target.value)}
                        placeholder="e.g., NovaPilot"
                        autoFocus
                        style={{
                          marginTop: 6,
                          width: '100%',
                          boxSizing: 'border-box',
                          padding: '12px 12px',
                          borderRadius: 12,
                          border: '1px solid rgba(15, 23, 42, 0.14)',
                          background: 'rgba(255,255,255,0.9)',
                          outline: 'none',
                          fontWeight: 700
                        }}
                      />

                      <div className="actions">
                        <button className="btn btnPrimary" type="submit" disabled={!playerNameDraft.trim()}>
                          Save Name
                        </button>
                      </div>

                      <div className="hint">Tip: You can change this later from the start screen.</div>
                    </form>
                  </>
                )}

                {hasPlayerName && (
                  <>
                    <div className="statRow" aria-label="Player info">
                      <div className="statPill">
                        <div className="statLabel">Signed in as</div>
                        <div className="statValue">{playerName}</div>
                      </div>
                      <div className="statPill">
                        <div className="statLabel">Best</div>
                        <div className="statValue">{currentTopScore ? formatInt(currentTopScore.score) : '—'}</div>
                      </div>
                    </div>

                    <ul className="bullets">
                      <li>
                        <strong>Move:</strong> WASD / Arrow keys
                      </li>
                      <li>
                        <strong>Shoot:</strong> Space
                      </li>
                      <li>
                        <strong>Tip:</strong> Stay mobile — difficulty scales over time
                      </li>
                    </ul>

                    <div className="actions">
                      <button className="btn btnPrimary" onClick={startGame} autoFocus>
                        Start Game
                      </button>
                      <button className="btn btnGhost" onClick={clearPlayerName}>
                        Change Player
                      </button>
                      <button className="btn btnGhost" onClick={openLeaderboard} type="button">
                        View Leaderboard
                      </button>
                    </div>

                    <div className="hint">Press Enter to start • Esc to return here while playing</div>
                  </>
                )}

                {highScores.length > 0 && (
                  <>
                    <div className="hint" style={{ marginTop: 14, fontWeight: 800 }}>
                      High Scores
                    </div>
                    <ol className="bullets" aria-label="High scores list">
                      {highScores.slice(0, 5).map((s, idx) => (
                        <li key={`${s.at}-${idx}`}>
                          <strong>{s.player}</strong> — {formatInt(s.score)}
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </div>
            </div>
          )}

          {state.screen === 'gameover' && (
            <div className="overlay" role="dialog" aria-label="Game over screen">
              <div className="card">
                <h1 className="title">Game Over</h1>
                <p className="subtitle">
                  {hasPlayerName ? (
                    <>
                      {playerName}, your final score: <strong>{formatInt(state.score)}</strong>
                    </>
                  ) : (
                    <>
                      Final score: <strong>{formatInt(state.score)}</strong>
                    </>
                  )}
                </p>

                <div className="statRow">
                  <div className="statPill">
                    <div className="statLabel">Time Survived</div>
                    <div className="statValue">{state.timeAliveSec.toFixed(1)}s</div>
                  </div>
                  <div className="statPill">
                    <div className="statLabel">Peak Difficulty</div>
                    <div className="statValue">{difficultyLabel}</div>
                  </div>
                  <div className="statPill">
                    <div className="statLabel">Best</div>
                    <div className="statValue">{currentTopScore ? formatInt(currentTopScore.score) : '—'}</div>
                  </div>
                </div>

                {highScores.length > 0 && (
                  <ol className="bullets" aria-label="High scores list">
                    {highScores.slice(0, 5).map((s, idx) => (
                      <li key={`${s.at}-${idx}`}>
                        <strong>{s.player}</strong> — {formatInt(s.score)}
                      </li>
                    ))}
                  </ol>
                )}

                <div className="actions">
                  <button className="btn btnPrimary" onClick={restartGame} autoFocus>
                    Restart
                  </button>
                  <button className="btn btnGhost" onClick={resetToStart}>
                    Back to Start
                  </button>
                  <button className="btn btnGhost" onClick={openLeaderboard} type="button">
                    View Leaderboard
                  </button>
                </div>

                <div className="hint">Press Enter to restart</div>
              </div>
            </div>
          )}

          {state.screen === 'leaderboard' && (
            <div className="overlay" role="dialog" aria-label="Leaderboard screen">
              <div className="card">
                <h1 className="title">{leaderboardTitle || 'Leaderboard'}</h1>
                <p className="subtitle">Top scores stored locally in this browser.</p>

                <div className="cardToolbar" aria-label="Leaderboard actions">
                  <div className="hint" style={{ marginTop: 0 }}>
                    Showing {Math.min(highScores.length, MAX_HIGH_SCORES)} / {MAX_HIGH_SCORES}
                  </div>
                  <div className="actions" style={{ marginTop: 0 }}>
                    <button className="btn btnGhost" onClick={refreshHighScores} type="button">
                      Refresh
                    </button>
                    <button className="btn btnPrimary" onClick={closeLeaderboard} type="button" autoFocus>
                      Back
                    </button>
                  </div>
                </div>

                {highScores.length === 0 ? (
                  <div className="hint" style={{ marginTop: 14 }}>
                    No local scores yet. Play a round to add your first score.
                  </div>
                ) : (
                  <div className="leaderboardTableWrap" style={{ marginTop: 14 }}>
                    <table className="leaderboardTable" aria-label="Leaderboard table">
                      <thead>
                        <tr>
                          <th className="leaderboardRank">Rank</th>
                          <th>Player</th>
                          <th>Score</th>
                          <th>Time</th>
                          <th>When</th>
                        </tr>
                      </thead>
                      <tbody>
                        {highScores.slice(0, MAX_HIGH_SCORES).map((s, idx) => (
                          <tr key={`${s.at}-${idx}`}>
                            <td className="leaderboardRank">{idx + 1}</td>
                            <td style={{ fontWeight: 800 }}>{s.player}</td>
                            <td className="leaderboardScore">{formatInt(s.score)}</td>
                            <td className="leaderboardMuted">{s.timeAliveSec.toFixed(1)}s</td>
                            <td className="leaderboardMuted">{formatWhen(s.at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="hint">Tip: This leaderboard is per-device/browser. Press Esc to go back.</div>
              </div>
            </div>
          )}
        </section>

        <footer className="footer">
          <span className="kbd">W</span>
          <span className="kbd">A</span>
          <span className="kbd">S</span>
          <span className="kbd">D</span>
          <span className="sep">/</span>
          <span className="kbd">↑</span>
          <span className="kbd">←</span>
          <span className="kbd">↓</span>
          <span className="kbd">→</span>
          <span className="sep">+</span>
          <span className="kbd">Space</span>
          <span className="footerText">Shoot • Survive • Score</span>
        </footer>
      </main>
    </div>
  );
}

export default App;
