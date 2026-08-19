"use strict";

(() => {
  const GAME_DURATION = 30;
  const PLAYER_SPEED = 440;
  const STORAGE_KEY = "dodge30.preferences.v1";
  const RANKING_LIMIT = 10;
  const DIFFICULTIES = {
    easy: {
      label: "이지",
      hint: "운석이 적고 느리며 유도력이 약합니다.",
      spawnInterval: 0.84,
      minSpeed: 180,
      speedVariance: 90,
      steeringMin: 20,
      steeringVariance: 14,
      maxDriftMin: 48,
      maxDriftVariance: 14,
      pointMultiplier: 0.85,
    },
    normal: {
      label: "노멀",
      hint: "현재 운석 속도와 유도 강도입니다.",
      spawnInterval: 0.6,
      minSpeed: 215,
      speedVariance: 115,
      steeringMin: 42,
      steeringVariance: 24,
      maxDriftMin: 74,
      maxDriftVariance: 20,
      pointMultiplier: 1,
    },
    hard: {
      label: "하드",
      hint: "운석이 빠르고 자주 등장하며 강하게 추적합니다.",
      spawnInterval: 0.44,
      minSpeed: 260,
      speedVariance: 135,
      steeringMin: 68,
      steeringVariance: 32,
      maxDriftMin: 108,
      maxDriftVariance: 26,
      pointMultiplier: 1.3,
    },
  };

  const elements = {
    arena: document.querySelector("#arena"),
    player: document.querySelector("#player"),
    overlay: document.querySelector("#overlay"),
    overlayKicker: document.querySelector("#overlayKicker"),
    overlayTitle: document.querySelector("#overlayTitle"),
    overlayMessage: document.querySelector("#overlayMessage"),
    overlayButton: document.querySelector("#overlayButton"),
    time: document.querySelector("#timeValue"),
    score: document.querySelector("#scoreValue"),
    best: document.querySelector("#bestValue"),
    statusPanel: document.querySelector("#statusPanel"),
    status: document.querySelector("#statusValue"),
    start: document.querySelector("#startButton"),
    pause: document.querySelector("#pauseButton"),
    restart: document.querySelector("#restartButton"),
    mute: document.querySelector("#muteButton"),
    motion: document.querySelector("#motionButton"),
    left: document.querySelector("#leftButton"),
    right: document.querySelector("#rightButton"),
    focusNote: document.querySelector("#focusNote"),
    pilotForm: document.querySelector("#pilotForm"),
    pilotInput: document.querySelector("#pilotName"),
    pilotSubmit: document.querySelector("#pilotForm button[type='submit']"),
    currentPilot: document.querySelector("#currentPilot"),
    pilotSummary: document.querySelector("#pilotSummary"),
    difficultyButtons: [...document.querySelectorAll(".difficulty-button")],
    difficultyHint: document.querySelector("#difficultyHint"),
    rankingList: document.querySelector("#rankingList"),
  };

  function createDefaults() {
    return {
      best: 0,
      muted: false,
      reducedMotion: false,
      difficulty: "normal",
      activePilot: "게스트",
      pilots: [],
      rankings: [],
    };
  }

  function normalizePilotName(value) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, 12);
  }

  function loadPreferences() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!parsed || typeof parsed !== "object") return createDefaults();
      const pilots = Array.isArray(parsed.pilots)
        ? [...new Set(parsed.pilots.map(normalizePilotName).filter(Boolean))].slice(0, 20)
        : [];
      const rankings = Array.isArray(parsed.rankings)
        ? parsed.rankings
            .map((entry) => {
              const pilot = normalizePilotName(entry?.pilot);
              const points = Number(entry?.points);
              const survived = Number(entry?.survived);
              if (!pilot || !Number.isFinite(points) || !Number.isFinite(survived)) return null;
              return {
                pilot,
                points: Math.max(0, Math.round(points)),
                survived: Math.min(GAME_DURATION, Math.max(0, survived)),
                dodged: Math.max(0, Math.round(Number(entry?.dodged) || 0)),
                difficulty: DIFFICULTIES[entry?.difficulty] ? entry.difficulty : "normal",
                result: entry?.result === "won" ? "won" : "lost",
                playedAt: Number(entry?.playedAt) || 0,
              };
            })
            .filter(Boolean)
            .sort((a, b) => b.points - a.points || b.survived - a.survived)
            .slice(0, RANKING_LIMIT)
        : [];
      const activePilot = normalizePilotName(parsed.activePilot) || "게스트";
      if (activePilot !== "게스트" && !pilots.includes(activePilot)) pilots.push(activePilot);
      return {
        best: Number.isInteger(parsed.best) && parsed.best >= 0 ? parsed.best : 0,
        muted: typeof parsed.muted === "boolean" ? parsed.muted : false,
        reducedMotion:
          typeof parsed.reducedMotion === "boolean" ? parsed.reducedMotion : false,
        difficulty: DIFFICULTIES[parsed.difficulty] ? parsed.difficulty : "normal",
        activePilot,
        pilots,
        rankings,
      };
    } catch {
      return createDefaults();
    }
  }

  const preferences = loadPreferences();
  let state = "ready";
  let remaining = GAME_DURATION;
  let score = 0;
  let playerX = 50;
  let spawnClock = 0;
  let lastFrame = 0;
  let frameId = 0;
  let audioContext = null;
  let obstacles = [];
  const pressed = new Set();

  function savePreferences() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // The game remains playable when storage is unavailable.
    }
  }

  function setStatus(nextState, text) {
    state = nextState;
    elements.statusPanel.dataset.state = nextState;
    elements.status.textContent = text;
    syncGameSetup();
  }

  function getDifficulty() {
    return DIFFICULTIES[preferences.difficulty] || DIFFICULTIES.normal;
  }

  function syncGameSetup() {
    const locked = state === "running" || state === "paused";
    const difficulty = getDifficulty();
    elements.currentPilot.textContent = preferences.activePilot;
    elements.pilotInput.disabled = locked;
    elements.pilotSubmit.disabled = locked;
    elements.pilotSummary.textContent = preferences.activePilot === "게스트"
      ? "게스트로 플레이 중 · 이름을 만들면 랭킹에 저장됩니다."
      : `등록 파일럿 ${preferences.pilots.length}명 · ${preferences.activePilot} 기록 저장 중`;
    for (const button of elements.difficultyButtons) {
      const active = button.dataset.difficulty === preferences.difficulty;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
      button.disabled = locked;
    }
    elements.difficultyHint.textContent = `${difficulty.label} · ${difficulty.hint}`;
  }

  function renderRanking() {
    elements.rankingList.replaceChildren();
    if (preferences.rankings.length === 0) {
      const empty = document.createElement("li");
      empty.className = "ranking-empty";
      empty.textContent = "아직 기록이 없습니다. 첫 작전을 시작하세요.";
      elements.rankingList.append(empty);
      return;
    }
    preferences.rankings.forEach((entry, index) => {
      const item = document.createElement("li");
      item.className = "ranking-entry";
      const rank = document.createElement("span");
      rank.className = "rank-number";
      rank.textContent = index === 0 ? "★" : String(index + 1);
      const pilot = document.createElement("div");
      pilot.className = "ranking-pilot";
      const name = document.createElement("strong");
      name.textContent = entry.pilot;
      const detail = document.createElement("small");
      detail.textContent = `${DIFFICULTIES[entry.difficulty].label} · ${entry.result === "won" ? "성공" : "실패"} · ${entry.survived.toFixed(1)}초 · ${entry.dodged}개 회피`;
      const points = document.createElement("strong");
      points.className = "ranking-points";
      points.textContent = `${entry.points.toLocaleString()} P`;
      pilot.append(name, detail);
      item.append(rank, pilot, points);
      elements.rankingList.append(item);
    });
  }

  function syncPreferences() {
    elements.best.textContent = String(preferences.best);
    elements.mute.setAttribute("aria-pressed", String(preferences.muted));
    elements.mute.innerHTML = preferences.muted
      ? '<span aria-hidden="true">🔇</span> 음소거됨'
      : '<span aria-hidden="true">🔊</span> 소리 켜짐';
    elements.motion.setAttribute("aria-pressed", String(preferences.reducedMotion));
    elements.motion.innerHTML = preferences.reducedMotion
      ? '<span aria-hidden="true">◼</span> 움직임 줄임'
      : '<span aria-hidden="true">✨</span> 움직임 기본';
    document.body.classList.toggle("reduce-motion", preferences.reducedMotion);
    syncGameSetup();
    renderRanking();
  }

  function calculatePoints(result) {
    const survived = Math.min(GAME_DURATION, Math.max(0, GAME_DURATION - remaining));
    const base = score * 120 + Math.floor(survived * 10) + (result === "won" ? 800 : 0);
    return Math.round(base * getDifficulty().pointMultiplier);
  }

  function recordRanking(result) {
    const points = calculatePoints(result);
    if (preferences.activePilot === "게스트") return points;
    preferences.rankings.push({
      pilot: preferences.activePilot,
      points,
      survived: Math.min(GAME_DURATION, Math.max(0, GAME_DURATION - remaining)),
      dodged: score,
      difficulty: preferences.difficulty,
      result,
      playedAt: Date.now(),
    });
    preferences.rankings.sort((a, b) => b.points - a.points || b.survived - a.survived);
    preferences.rankings = preferences.rankings.slice(0, RANKING_LIMIT);
    return points;
  }

  function updateBoard() {
    elements.time.textContent = Math.max(0, remaining).toFixed(1);
    elements.score.textContent = String(score);
    elements.player.style.left = `${playerX}%`;
  }

  function tone(frequency, duration = 0.08, type = "sine") {
    if (preferences.muted) return;
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = type;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.05, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + duration);
    } catch {
      // Audio is optional and browser policies can block it.
    }
  }

  function removeObstacles() {
    for (const obstacle of obstacles) obstacle.element.remove();
    obstacles = [];
  }

  function resetRound() {
    cancelAnimationFrame(frameId);
    pressed.clear();
    removeObstacles();
    remaining = GAME_DURATION;
    score = 0;
    playerX = 50;
    spawnClock = 0;
    lastFrame = 0;
    elements.pause.disabled = true;
    elements.pause.textContent = "일시정지";
    elements.start.disabled = false;
    elements.start.textContent = "게임 시작";
    setStatus("ready", "시작 전");
    updateBoard();
  }

  function showOverlay(kicker, title, message, buttonText) {
    elements.overlayKicker.textContent = kicker;
    elements.overlayTitle.textContent = title;
    elements.overlayMessage.textContent = message;
    elements.overlayButton.textContent = buttonText;
    elements.overlay.hidden = false;
  }

  function startGame() {
    resetRound();
    setStatus("running", "진행 중");
    elements.overlay.hidden = true;
    elements.start.disabled = true;
    elements.start.textContent = "진행 중";
    elements.pause.disabled = false;
    elements.arena.focus({ preventScroll: true });
    lastFrame = performance.now();
    tone(520, 0.12, "triangle");
    frameId = requestAnimationFrame(gameLoop);
  }

  function spawnObstacle() {
    const difficulty = getDifficulty();
    const size = 27 + Math.random() * 22;
    const element = document.createElement("div");
    element.className = "obstacle";
    element.setAttribute("aria-hidden", "true");
    element.style.width = `${size}px`;
    element.style.height = `${size}px`;
    const maxX = Math.max(0, elements.arena.clientWidth - size);
    const obstacle = {
      element,
      x: Math.random() * maxX,
      y: -size,
      size,
      speed: difficulty.minSpeed + Math.random() * difficulty.speedVariance + score * 1.2,
      drift: (Math.random() - 0.5) * 28,
      steering: difficulty.steeringMin + Math.random() * difficulty.steeringVariance,
      maxDrift: difficulty.maxDriftMin + Math.random() * difficulty.maxDriftVariance,
      rotation: Math.random() * 360,
    };
    obstacles.push(obstacle);
    elements.arena.append(element);
  }

  function isCollision(obstacle) {
    const arenaRect = elements.arena.getBoundingClientRect();
    const playerRect = elements.player.getBoundingClientRect();
    const padding = 7;
    const player = {
      left: playerRect.left - arenaRect.left + padding,
      right: playerRect.right - arenaRect.left - padding,
      top: playerRect.top - arenaRect.top + padding,
      bottom: playerRect.bottom - arenaRect.top - padding,
    };
    return (
      obstacle.x + obstacle.size - 4 > player.left &&
      obstacle.x + 4 < player.right &&
      obstacle.y + obstacle.size - 4 > player.top &&
      obstacle.y + 4 < player.bottom
    );
  }

  function finish(result) {
    cancelAnimationFrame(frameId);
    pressed.clear();
    elements.pause.disabled = true;
    elements.start.disabled = false;
    elements.start.textContent = "새 게임";

    if (score > preferences.best) preferences.best = score;
    const points = recordRanking(result);
    savePreferences();
    elements.best.textContent = String(preferences.best);
    renderRanking();

    if (result === "won") {
      remaining = 0;
      setStatus("won", "성공");
      tone(740, 0.22, "triangle");
      window.setTimeout(() => tone(980, 0.28, "triangle"), 120);
      showOverlay("MISSION COMPLETE", "생존 성공!", `운석 ${score}개 회피 · ${points.toLocaleString()} 포인트`, "한 번 더");
    } else {
      setStatus("lost", "실패");
      tone(135, 0.32, "sawtooth");
      showOverlay("MISSION FAILED", "운석과 충돌!", `${(GAME_DURATION - remaining).toFixed(1)}초 생존 · 운석 ${score}개 회피 · ${points.toLocaleString()} 포인트`, "다시 도전");
    }
    updateBoard();
  }

  function updatePlayer(delta) {
    const movingLeft = pressed.has("ArrowLeft") || pressed.has("KeyA") || pressed.has("touch-left");
    const movingRight = pressed.has("ArrowRight") || pressed.has("KeyD") || pressed.has("touch-right");
    if (movingLeft === movingRight) return;
    const arenaWidth = elements.arena.clientWidth;
    const direction = movingLeft ? -1 : 1;
    playerX += direction * (PLAYER_SPEED / arenaWidth) * 100 * delta;
    const halfWidth = (elements.player.offsetWidth / arenaWidth) * 50;
    playerX = Math.min(100 - halfWidth, Math.max(halfWidth, playerX));
  }

  function nudgePlayer(direction) {
    if (state !== "running") return;
    const arenaWidth = elements.arena.clientWidth;
    const halfWidth = (elements.player.offsetWidth / arenaWidth) * 50;
    playerX += direction * 3.5;
    playerX = Math.min(100 - halfWidth, Math.max(halfWidth, playerX));
    updateBoard();
  }

  function updateObstacles(delta) {
    const arenaHeight = elements.arena.clientHeight;
    const arenaWidth = elements.arena.clientWidth;
    const playerCenterX = (playerX / 100) * arenaWidth;
    const next = [];
    for (const obstacle of obstacles) {
      const meteorCenterX = obstacle.x + obstacle.size / 2;
      const steerDirection = Math.sign(playerCenterX - meteorCenterX);
      obstacle.drift += steerDirection * obstacle.steering * delta;
      obstacle.drift = Math.min(obstacle.maxDrift, Math.max(-obstacle.maxDrift, obstacle.drift));
      obstacle.x += obstacle.drift * delta;
      obstacle.x = Math.min(arenaWidth - obstacle.size, Math.max(0, obstacle.x));
      obstacle.y += obstacle.speed * delta;
      obstacle.rotation += 80 * delta;
      obstacle.element.style.transform = `translate(${obstacle.x}px, ${obstacle.y}px) rotate(${obstacle.rotation}deg)`;
      if (isCollision(obstacle)) {
        finish("lost");
        return false;
      }
      if (obstacle.y > arenaHeight) {
        obstacle.element.remove();
        score += 1;
        tone(260, 0.035, "square");
      } else {
        next.push(obstacle);
      }
    }
    obstacles = next;
    return true;
  }

  function gameLoop(timestamp) {
    if (state !== "running") return;
    const delta = Math.min((timestamp - lastFrame) / 1000, 0.05);
    lastFrame = timestamp;
    remaining -= delta;
    spawnClock += delta;

    updatePlayer(delta);
    const spawnInterval = getDifficulty().spawnInterval;
    if (spawnClock >= spawnInterval) {
      spawnClock %= spawnInterval;
      spawnObstacle();
    }
    if (!updateObstacles(delta)) return;
    updateBoard();

    if (remaining <= 0) {
      finish("won");
      return;
    }
    frameId = requestAnimationFrame(gameLoop);
  }

  function togglePause(automatic = false) {
    if (state === "running") {
      cancelAnimationFrame(frameId);
      pressed.clear();
      setStatus("paused", "일시정지");
      elements.pause.textContent = "계속하기";
      showOverlay(
        "GAME PAUSED",
        automatic ? "창을 벗어나 일시정지됨" : "게임 일시정지",
        "준비되면 계속하기를 누르세요.",
        "계속하기",
      );
    } else if (state === "paused") {
      setStatus("running", "진행 중");
      elements.pause.textContent = "일시정지";
      elements.overlay.hidden = true;
      lastFrame = performance.now();
      elements.arena.focus({ preventScroll: true });
      frameId = requestAnimationFrame(gameLoop);
    }
  }

  function prepareRestart() {
    resetRound();
    showOverlay("MISSION READY", "30초, 버틸 수 있나요?", "현재 판이 초기화됐습니다. 준비되면 시작하세요.", "게임 시작");
  }

  function handleKeyDown(event) {
    const gameKeys = ["ArrowLeft", "ArrowRight", "KeyA", "KeyD", "KeyP", "Escape", "Space"];
    if (gameKeys.includes(event.code)) event.preventDefault();
    if (["ArrowLeft", "ArrowRight", "KeyA", "KeyD"].includes(event.code)) {
      pressed.add(event.code);
      if (!event.repeat) nudgePlayer(["ArrowLeft", "KeyA"].includes(event.code) ? -1 : 1);
    }
    if (event.repeat) return;
    if (["KeyP", "Escape"].includes(event.code) && (state === "running" || state === "paused")) togglePause();
    if (event.code === "Space" && ["ready", "won", "lost"].includes(state)) startGame();
  }

  function bindHoldButton(element, key) {
    const press = (event) => {
      event.preventDefault();
      pressed.add(key);
      nudgePlayer(key === "touch-left" ? -1 : 1);
    };
    const release = () => pressed.delete(key);
    element.addEventListener("pointerdown", press);
    element.addEventListener("pointerup", release);
    element.addEventListener("pointercancel", release);
    element.addEventListener("pointerleave", release);
  }

  function handlePilotSubmit(event) {
    event.preventDefault();
    const pilot = normalizePilotName(elements.pilotInput.value);
    if (!pilot || pilot === "게스트") {
      elements.pilotSummary.textContent = "게스트가 아닌 파일럿 이름을 입력하세요.";
      elements.pilotInput.focus();
      return;
    }
    if (!preferences.pilots.includes(pilot)) preferences.pilots.push(pilot);
    preferences.activePilot = pilot;
    elements.pilotInput.value = "";
    savePreferences();
    syncGameSetup();
    tone(620, 0.1, "triangle");
  }

  function handleDifficultyChange(event) {
    const next = event.currentTarget.dataset.difficulty;
    if (!DIFFICULTIES[next] || state === "running" || state === "paused") return;
    preferences.difficulty = next;
    savePreferences();
    syncGameSetup();
    tone(next === "easy" ? 420 : next === "hard" ? 720 : 560, 0.08, "triangle");
  }

  elements.start.addEventListener("click", startGame);
  elements.overlayButton.addEventListener("click", () => {
    if (state === "paused") togglePause();
    else startGame();
  });
  elements.pause.addEventListener("click", () => togglePause());
  elements.restart.addEventListener("click", prepareRestart);
  elements.mute.addEventListener("click", () => {
    preferences.muted = !preferences.muted;
    savePreferences();
    syncPreferences();
    if (!preferences.muted) tone(520, 0.09, "triangle");
  });
  elements.motion.addEventListener("click", () => {
    preferences.reducedMotion = !preferences.reducedMotion;
    savePreferences();
    syncPreferences();
  });
  elements.pilotForm.addEventListener("submit", handlePilotSubmit);
  for (const button of elements.difficultyButtons) {
    button.addEventListener("click", handleDifficultyChange);
  }
  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", (event) => pressed.delete(event.code));
  window.addEventListener("blur", () => {
    if (state === "running") {
      togglePause(true);
      elements.focusNote.textContent = "포커스 이탈을 감지해 자동으로 일시정지했습니다.";
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state === "running") togglePause(true);
  });
  window.addEventListener("resize", () => {
    playerX = Math.min(96, Math.max(4, playerX));
    updateBoard();
  });
  bindHoldButton(elements.left, "touch-left");
  bindHoldButton(elements.right, "touch-right");

  syncPreferences();
  resetRound();
})();

