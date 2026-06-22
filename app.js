const DEFAULTS = [
  { id: "deadbug", name: "死虫式变式", help: "左右交替：每侧 5 次为一组。", kind: "alternate", reps: 5, sets: 6, interval: 4, setRest: 30, nextRest: 60 },
  { id: "prone", name: "俯卧后抬腿", help: "默认每组左、右腿各 10 次；可改成只练一侧。", kind: "sides", reps: 10, sets: 6, interval: 3, setRest: 30, nextRest: 60, sides: "both" },
  { id: "bridge", name: "背桥", help: "每组 6 次。", kind: "plain", reps: 6, sets: 8, interval: 5, setRest: 30, nextRest: 0 }
];

const DEFAULT_PREFERENCES = { voiceStyle: "gentle", voiceRate: "slow", setAnnouncement: "full" };
const VOICE_STYLES = { gentle: { pitch: 0.88 }, standard: { pitch: 1 }, clear: { pitch: 1.08 } };
const VOICE_RATES = { slow: 0.84, normal: 0.96, fast: 1.1 };

const $ = selector => document.querySelector(selector);
const settingsEl = $("#exercise-settings");
const setupScreen = $("#setup-screen");
const workoutScreen = $("#workout-screen");
const phaseLabel = $("#phase-label");
const cueText = $("#cue-text");
const detailText = $("#detail-text");
const timerText = $("#timer-text");
const progressBar = $("#progress-bar");
const pauseButton = $("#pause-button");

let config = loadConfig();
let preferences = loadPreferences();
let wakeLock = null;
let stopped = false;
let paused = false;
let completed = 0;
let totalSteps = 1;

function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem("recoveryTimerConfig"));
    if (Array.isArray(saved) && saved.length === DEFAULTS.length) return saved;
  } catch (_) {}
  return structuredClone(DEFAULTS);
}

function saveConfig() { localStorage.setItem("recoveryTimerConfig", JSON.stringify(config)); }
function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem("recoveryTimerPreferences"));
    if (saved && typeof saved === "object") return { ...DEFAULT_PREFERENCES, ...saved };
  } catch (_) {}
  return { ...DEFAULT_PREFERENCES };
}
function savePreferences() { localStorage.setItem("recoveryTimerPreferences", JSON.stringify(preferences)); }
function renderPreferences() {
  $("#voice-style").value = preferences.voiceStyle;
  $("#voice-rate").value = preferences.voiceRate;
  $("#set-announcement").value = preferences.setAnnouncement;
}
function readPreferences() {
  preferences.voiceStyle = $("#voice-style").value;
  preferences.voiceRate = $("#voice-rate").value;
  preferences.setAnnouncement = $("#set-announcement").value;
  savePreferences();
}
function number(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function field(id, label, value, min = 0) {
  return `<label class="field">${label}<input data-field="${id}" type="number" min="${min}" step="1" value="${value}"></label>`;
}

function renderSettings() {
  settingsEl.innerHTML = config.map(item => {
    const sideChoice = item.kind === "sides" ? `<label class="field full">训练侧别<select data-field="sides"><option value="both" ${item.sides === "both" ? "selected" : ""}>左右腿各做</option><option value="left" ${item.sides === "left" ? "selected" : ""}>只做左腿</option><option value="right" ${item.sides === "right" ? "selected" : ""}>只做右腿</option></select></label>` : "";
    const repsLabel = item.kind === "alternate" ? "每侧次数" : item.kind === "sides" ? "每侧次数" : "每组次数";
    return `<article class="exercise-card" data-id="${item.id}"><h2>${item.name}</h2><p>${item.help}</p><div class="field-grid">${field("reps", repsLabel, item.reps, 1)}${field("sets", "组数", item.sets, 1)}${field("interval", "每次动作间隔（秒）", item.interval, 1)}${field("setRest", "组间休息（秒）", item.setRest)}${field("nextRest", "下一动作前休息（秒）", item.nextRest)}${sideChoice}</div></article>`;
  }).join("");
  settingsEl.querySelectorAll("input, select").forEach(control => control.addEventListener("change", readSettings));
}

function readSettings() {
  settingsEl.querySelectorAll(".exercise-card").forEach(card => {
    const item = config.find(entry => entry.id === card.dataset.id);
    card.querySelectorAll("[data-field]").forEach(control => {
      item[control.dataset.field] = control.tagName === "SELECT" ? control.value : number(control.value, item[control.dataset.field]);
    });
  });
  saveConfig();
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const style = VOICE_STYLES[preferences.voiceStyle] || VOICE_STYLES.gentle;
  utterance.lang = "zh-CN";
  utterance.pitch = style.pitch;
  utterance.rate = VOICE_RATES[preferences.voiceRate] || VOICE_RATES.slow;
  window.speechSynthesis.speak(utterance);
}

function setAnnouncement(item, setDetail) {
  return preferences.setAnnouncement === "short" ? setDetail : `${item.name}，${setDetail}`;
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || stopped || paused) return false;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
    return true;
  } catch (_) { return false; }
}

async function releaseWakeLock() {
  if (!wakeLock) return;
  try { await wakeLock.release(); } catch (_) {}
  wakeLock = null;
}

function show(phase, cue, detail, seconds = 0) {
  phaseLabel.textContent = phase;
  cueText.textContent = cue;
  detailText.textContent = detail;
  timerText.textContent = formatTime(seconds);
  progressBar.style.width = `${Math.min(100, (completed / totalSteps) * 100)}%`;
}

function formatTime(seconds) { return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
function shortWait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function wait(seconds, announceLastFive = false) {
  let end = Date.now() + seconds * 1000;
  let pausedAt = null;
  let lastCountdown = null;
  while (!stopped) {
    if (paused) {
      pausedAt ??= Date.now();
      await shortWait(150);
      continue;
    }
    if (pausedAt !== null) {
      end += Date.now() - pausedAt;
      pausedAt = null;
    }
    const remaining = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    timerText.textContent = formatTime(remaining);
    if (announceLastFive && remaining > 0 && remaining <= 5 && remaining !== lastCountdown) {
      lastCountdown = remaining;
      speak(String(remaining));
    }
    if (remaining <= 0) break;
    await shortWait(150);
  }
}

async function cue(text, detail, interval) {
  if (stopped) return;
  show("动作", text, detail, interval);
  speak(text);
  await wait(interval);
  completed += 1;
}

async function rest(seconds, label, announceLastFive = false) {
  if (!seconds || stopped) return;
  show("休息", label, `${seconds} 秒后自动继续`, seconds);
  speak(label);
  await wait(seconds, announceLastFive);
  completed += 1;
}

function countSteps(items) {
  let count = 1;
  items.forEach((item, i) => {
    const movements = item.kind === "alternate" ? item.reps * 2 : item.kind === "sides" ? item.reps * (item.sides === "both" ? 2 : 1) : item.reps;
    count += item.sets * movements;
    if (item.setRest) count += Math.max(0, item.sets - 1);
    if (i < items.length - 1 && item.nextRest) count += 1;
  });
  return count;
}

async function runExercise(item) {
  for (let set = 1; set <= item.sets && !stopped; set++) {
    const setDetail = `第 ${set} 组，共 ${item.sets} 组`;
    speak(setAnnouncement(item, setDetail));
    if (item.kind === "alternate") {
      for (let rep = 1; rep <= item.reps && !stopped; rep++) {
        await cue(`左 ${rep}`, `${item.name} · ${setDetail}`, item.interval);
        await cue(`右 ${rep}`, `${item.name} · ${setDetail}`, item.interval);
      }
    } else if (item.kind === "sides") {
      const sides = item.sides === "both" ? ["左腿", "右腿"] : [item.sides === "left" ? "左腿" : "右腿"];
      for (const side of sides) for (let rep = 1; rep <= item.reps && !stopped; rep++) await cue(`${side} ${rep}`, `${item.name} · ${setDetail}`, item.interval);
    } else {
      for (let rep = 1; rep <= item.reps && !stopped; rep++) await cue(`第 ${rep} 次`, `${item.name} · ${setDetail}`, item.interval);
    }
    if (set < item.sets) await rest(item.setRest, `第 ${set} 组完成，组间休息`, true);
  }
}

async function startWorkout() {
  readSettings();
  readPreferences();
  stopped = false; paused = false; completed = 0; totalSteps = countSteps(config);
  requestWakeLock();
  setupScreen.classList.add("hidden"); workoutScreen.classList.remove("hidden");
  pauseButton.textContent = "暂停";
  show("准备", "准备开始", "10 秒后开始第一个动作", 10);
  speak("准备开始，十秒后开始第一个动作");
  await wait(10); completed += 1;
  for (let i = 0; i < config.length && !stopped; i++) {
    await runExercise(config[i]);
    if (i < config.length - 1) await rest(config[i].nextRest, `${config[i].name}完成。下一项是${config[i + 1].name}，动作间休息`);
  }
  if (!stopped) {
    completed = totalSteps; show("完成", "今天的训练完成", "做得好。", 0); speak("今天的训练完成");
    pauseButton.classList.add("hidden");
    await releaseWakeLock();
  }
}

$("#start-button").addEventListener("click", startWorkout);
$("#reset-button").addEventListener("click", () => { config = structuredClone(DEFAULTS); saveConfig(); renderSettings(); });
pauseButton.addEventListener("click", () => {
  paused = !paused;
  pauseButton.textContent = paused ? "继续" : "暂停";
  if (paused) { window.speechSynthesis?.pause(); releaseWakeLock(); } else { window.speechSynthesis?.resume(); requestWakeLock(); }
});
$("#end-button").addEventListener("click", () => {
  stopped = true; paused = false; window.speechSynthesis?.cancel(); releaseWakeLock();
  workoutScreen.classList.add("hidden"); setupScreen.classList.remove("hidden"); pauseButton.classList.remove("hidden");
});
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !stopped && !paused) requestWakeLock();
});
["#voice-style", "#voice-rate", "#set-announcement"].forEach(selector => $(selector).addEventListener("change", readPreferences));
renderSettings();
renderPreferences();
