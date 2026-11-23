const app = document.querySelector("#app");
const homeTemplate = document.querySelector("#homeTemplate");
const toast = document.querySelector("#toast");
const apiStatus = document.querySelector("#apiStatus");

const state = {
  status: null,
  exam: null,
  mode: "full",
  tasks: [],
  index: 0,
  answers: [],
  mediaRecorder: null,
  stream: null,
  chunks: [],
  recordStarted: 0,
  timerId: null,
  discussionHistory: [],
  introducedSections: new Set(),
  autoStopped: false,
  narrationId: 0,
  meterContext: null,
  meterFrame: null,
  peakInputLevel: 0,
  soundDetected: false,
  selectedDeviceId: localStorage.getItem("cet6-microphone-device") || "",
  selectedDeviceLabel: localStorage.getItem("cet6-microphone-label") || "",
  recentPart1Questions: [],
};

try {
  const savedQuestions = JSON.parse(localStorage.getItem("cet6-recent-part1-questions") || "[]");
  state.recentPart1Questions = Array.isArray(savedQuestions) ? savedQuestions.slice(-30) : [];
} catch {
  state.recentPart1Questions = [];
}

function notify(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove("show"), 3600);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

async function checkStatus() {
  try {
    state.status = await api("/api/status");
    apiStatus.className = `status-pill ${state.status.ready ? "ready" : state.status.demoMode ? "" : "error"}`;
    apiStatus.querySelector("span").textContent = state.status.ready ? "AI 服务已连接" : state.status.demoMode ? "演示模式" : "API 未配置";
  } catch {
    apiStatus.className = "status-pill error";
    apiStatus.querySelector("span").textContent = "服务未连接";
  }
}

function renderHome() {
  stopStreams();
  app.innerHTML = "";
  app.append(homeTemplate.content.cloneNode(true));
  updateSelectedMicLabel();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function updateSelectedMicLabel() {
  const label = document.querySelector("#selectedMicLabel");
  if (label) label.textContent = state.selectedDeviceLabel || "尚未选择，将自动优先使用笔记本内置麦克风";
}

function isVirtualMicrophone(label = "") {
  return /(cable|vb-audio|virtual|stereo mix|立体声混音|wave out|voicemeeter)/i.test(label);
}

function microphoneRank(device) {
  const label = device.label || "";
  if (isVirtualMicrophone(label)) return -100;
  if (/(microphone array|麦克风阵列|internal|内置|built-in|realtek|smart sound)/i.test(label)) return 100;
  if (/(microphone|mic|麦克风)/i.test(label)) return 50;
  return 10;
}

async function listMicrophones(requestPermission = true) {
  let permissionStream;
  try {
    if (requestPermission) permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default" && device.deviceId !== "communications");
  } finally {
    permissionStream?.getTracks().forEach((track) => track.stop());
  }
}

function saveMicrophone(device) {
  state.selectedDeviceId = device.deviceId;
  state.selectedDeviceLabel = device.label || "已选择的麦克风";
  localStorage.setItem("cet6-microphone-device", state.selectedDeviceId);
  localStorage.setItem("cet6-microphone-label", state.selectedDeviceLabel);
  updateSelectedMicLabel();
  const inline = document.querySelector("#inlineDevice");
  if (inline) inline.textContent = `麦克风：${state.selectedDeviceLabel}　⌄`;
}

async function ensureMicrophoneSelection() {
  const devices = await listMicrophones(true);
  if (!devices.length) throw new Error("系统没有找到可用的麦克风输入设备。 ");
  const saved = devices.find((device) => device.deviceId === state.selectedDeviceId);
  if (saved && !isVirtualMicrophone(saved.label)) {
    saveMicrophone(saved);
    return saved;
  }
  const physicalDevices = devices.filter((device) => !isVirtualMicrophone(device.label));
  if (!physicalDevices.length) throw new Error("只检测到虚拟音频设备，没有找到笔记本内置或外接麦克风。 ");
  const preferred = [...physicalDevices].sort((a, b) => microphoneRank(b) - microphoneRank(a))[0];
  saveMicrophone(preferred);
  return preferred;
}

async function selectMicrophone() {
  try {
    const devices = await listMicrophones(true);
    if (!devices.length) throw new Error("系统没有找到可用的麦克风输入设备。 ");
    const saved = devices.find((device) => device.deviceId === state.selectedDeviceId && !isVirtualMicrophone(device.label));
    const physicalDevices = devices.filter((device) => !isVirtualMicrophone(device.label));
    const recommended = saved || [...(physicalDevices.length ? physicalDevices : devices)].sort((a, b) => microphoneRank(b) - microphoneRank(a))[0];
    const overlay = document.createElement("div");
    overlay.className = "device-overlay";
    overlay.innerHTML = `
      <div class="device-dialog" role="dialog" aria-modal="true" aria-labelledby="deviceTitle">
        <span class="briefing-kicker">AUDIO INPUT</span>
        <h2 id="deviceTitle">选择录音麦克风</h2>
        <p>已自动避开 VB-Audio CABLE 等虚拟输入，优先选择笔记本的麦克风阵列。你也可以手动更改。</p>
        <select id="microphoneSelect">${devices.map((device) => `<option value="${escapeHtml(device.deviceId)}" ${device.deviceId === recommended.deviceId ? "selected" : ""} ${isVirtualMicrophone(device.label) ? "disabled" : ""}>${escapeHtml(device.label || "未命名麦克风")}${isVirtualMicrophone(device.label) ? "（虚拟设备，已禁用）" : microphoneRank(device) >= 100 ? "（推荐）" : ""}</option>`).join("")}</select>
        <div class="device-actions"><button class="button ghost" id="cancelDevice">取消</button><button class="button primary" id="confirmDevice">使用此麦克风 <span>→</span></button></div>
      </div>`;
    document.body.append(overlay);
    document.querySelector("#cancelDevice").addEventListener("click", () => overlay.remove());
    document.querySelector("#confirmDevice").addEventListener("click", () => {
      const selected = devices.find((device) => device.deviceId === document.querySelector("#microphoneSelect").value);
      if (selected) saveMicrophone(selected);
      overlay.remove();
      notify(`已切换到：${selected?.label || "所选麦克风"}`);
    });
  } catch (error) {
    notify(error.name === "NotAllowedError" ? "请先允许浏览器访问麦克风，才能显示设备列表。" : `无法读取麦克风列表：${error.message}`);
  }
}

async function getSelectedAudioStream() {
  const device = await ensureMicrophoneSelection();
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: device.deviceId },
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

function loading(message = "AI 正在生成本次试题") {
  app.innerHTML = `<section class="loading-screen"><div><div class="loader"></div><h2>${message}</h2><p class="prompt-note">正在避开重复题目，并校准到 CET-SET6 难度…</p></div></section>`;
}

async function startExam(mode) {
  try {
    state.mode = mode;
    state.index = 0;
    state.answers = [];
    state.discussionHistory = [];
    state.introducedSections = new Set();
    loading();
    state.exam = await api("/api/exam/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ difficulty: "challenging", recentPart1Questions: state.recentPart1Questions }),
    });
    state.recentPart1Questions = [...state.recentPart1Questions, ...safeArray(state.exam?.part1?.questions)].slice(-30);
    localStorage.setItem("cet6-recent-part1-questions", JSON.stringify(state.recentPart1Questions));
    state.tasks = buildTasks(state.exam, mode);
    renderSectionIntro();
  } catch (error) {
    renderHome();
    notify(error.message);
  }
}

const SECTION_INFO = {
  "Part 1": {
    title: "自我介绍和问答",
    duration: "考试时间约 2 分钟",
    requirement: "先进行 20 秒自由自我介绍，不限定必须包含哪些内容；随后回答考官提出的两个日常或校园生活问题。",
    timings: ["自我介绍：自由介绍，不设内容要求", "每个问题：30 秒", "录音倒计时结束后自动停止"],
  },
  "Part 2": {
    title: "陈述和讨论",
    duration: "考试时间约 8 分钟",
    requirement: "先根据提示准备并作个人陈述，然后与 AI 考生围绕指定话题展开多轮讨论。",
    timings: ["准备时间：1 分钟", "个人陈述：1 分 30 秒", "双人讨论：总计约 3 分钟"],
  },
  "Part 3": {
    title: "问答",
    duration: "考试时间约 1 分钟",
    requirement: "回答考官围绕本套主题提出的一个问题。需要明确表达观点并给出理由。",
    timings: ["作答时间：45 秒", "两位考生在正式考试中同步进行", "录音倒计时结束后自动停止"],
  },
};

function buildTasks(exam, mode) {
  const safeExam = exam && typeof exam === "object" ? exam : {};
  const part1 = safeExam.part1 && typeof safeExam.part1 === "object" ? safeExam.part1 : {};
  const part2 = safeExam.part2 && typeof safeExam.part2 === "object" ? safeExam.part2 : {};
  const part3 = safeExam.part3 && typeof safeExam.part3 === "object" ? safeExam.part3 : {};
  const all = [
    { section: "Part 1", label: "自我介绍", task: part1.introPrompt || "Good morning. Please introduce yourself briefly.", seconds: 20, kind: "answer" },
    ...safeArray(part1.questions).map((task, i) => ({ section: "Part 1", label: `考官问答 ${i + 1}`, task, seconds: 30, kind: "answer" })),
    { section: "Part 2", label: "个人陈述", task: part2.statementPrompt || "Please state your opinion and support it with reasons and examples.", seconds: 90, prep: 60, keyPoints: safeArray(part2.keyPoints), kind: "answer" },
    { section: "Part 2", label: "双人讨论", task: part2.discussionOpening || "What is your opinion on this issue?", topic: part2.statementPrompt || "the assigned topic", seconds: 45, kind: "discussion", rounds: 3, round: 1 },
    ...safeArray(part3.questions).slice(0, 1).map((task) => ({ section: "Part 3", label: "主题问答", task, seconds: 45, kind: "answer" })),
  ];
  if (mode === "part1") return all.filter((x) => x.section === "Part 1");
  if (mode === "part2") return all.filter((x) => x.section === "Part 2");
  if (mode === "part3") return all.filter((x) => x.section === "Part 3");
  return all;
}

function renderSectionIntro() {
  const task = state.tasks[state.index];
  const info = SECTION_INFO[task.section];
  state.introducedSections.add(task.section);
  app.innerHTML = `
    <section class="briefing-screen">
      <div class="briefing-number">${task.section.replace("Part ", "0")}</div>
      <div class="briefing-card">
        <span class="briefing-kicker">${task.section.toUpperCase()} · SECTION BRIEFING</span>
        <h1>${info.title}</h1>
        <p class="briefing-duration">${info.duration}</p>
        <div class="briefing-requirement"><b>本环节要求</b><p>${info.requirement}</p></div>
        <div class="timing-list">${info.timings.map((item, i) => `<div><span>0${i + 1}</span><p>${item}</p></div>`).join("")}</div>
        <button class="button primary" id="beginSection">我已了解，进入本环节 <span>→</span></button>
      </div>
    </section>`;
  document.querySelector("#beginSection").addEventListener("click", renderTask);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForSpeechVoices(timeout = 1200) {
  if (!("speechSynthesis" in window)) return Promise.resolve([]);
  const existing = window.speechSynthesis.getVoices();
  if (existing.length) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const finish = () => {
      window.speechSynthesis.removeEventListener("voiceschanged", finish);
      resolve(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener("voiceschanged", finish, { once: true });
    setTimeout(finish, timeout);
  });
}

async function speak(text) {
  if (!("speechSynthesis" in window) || !text) return false;
  const speechId = ++state.narrationId;
  const synth = window.speechSynthesis;
  synth.cancel();
  const voices = await waitForSpeechVoices();
  await delay(350);
  if (speechId !== state.narrationId) return false;

  return new Promise((resolve) => {
    let settled = false;
    const utterance = new SpeechSynthesisUtterance(`Please listen. ${text}`);
    const englishVoice = voices.find((voice) => /^en-US$/i.test(voice.lang)) || voices.find((voice) => /^en[-_]/i.test(voice.lang));
    if (englishVoice) utterance.voice = englishVoice;
    utterance.lang = englishVoice?.lang || "en-US";
    utterance.rate = 0.9;
    utterance.pitch = 1;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      resolve(completed);
    };
    utterance.onend = () => finish(true);
    utterance.onerror = () => finish(false);
    synth.speak(utterance);
    const fallbackMs = Math.max(5000, text.split(/\s+/).length * 850);
    setTimeout(() => finish(false), fallbackMs);
  });
}

function renderTask() {
  const task = state.tasks[state.index];
  const progress = (state.index / state.tasks.length) * 100;
  app.innerHTML = `
    <section class="exam-shell">
      <aside class="exam-sidebar">
        <h4>${state.exam.title.toUpperCase()}</h4>
        <div class="progress-track"><span style="width:${progress}%"></span></div>
        <ol class="step-list">${state.tasks.map((x, i) => `<li class="${i === state.index ? "active" : ""} ${i < state.index ? "done" : ""}">${i >= state.index ? `<span>${String(i + 1).padStart(2, "0")}</span>` : ""}${x.label}${x.kind === "discussion" ? ` · ${x.round}/3` : ""}</li>`).join("")}</ol>
      </aside>
      <article class="exam-card" id="examCard">
        <div class="part-label"><b>${task.section.toUpperCase()}</b><span>${task.label.toUpperCase()} · 限时 ${formatDuration(task.seconds)}</span></div>
        <h1>${escapeHtml(task.task)}</h1>
        <p class="prompt-note">${task.label === "自我介绍" ? "请自由介绍自己，不限定学校、专业、家乡、爱好或其他固定内容。" : task.kind === "discussion" ? "请像真实搭档讨论一样，回应对方观点、补充理由，并推动对话。" : "请直接用英语回答。内容应有观点、理由与具体例子。"}</p>
        ${safeArray(task.keyPoints).length ? `<div class="key-points">${safeArray(task.keyPoints).map((x) => `<span>${escapeHtml(x)}</span>`).join("")}</div>` : ""}
        ${task.prep ? `<div class="prep-panel waiting" id="prepPanel"><div><b>题目朗读中</b><br><small>朗读结束后开始 1 分钟准备倒计时</small></div><span class="timer" id="prepTimer">--:--</span></div>` : ""}
        <div class="record-zone" id="recordZone">
          <div class="wave">${"<i></i>".repeat(22)}</div>
          <button class="inline-device" id="inlineDevice" type="button">麦克风：${escapeHtml(state.selectedDeviceLabel || "自动选择笔记本麦克风")}　⌄</button>
          <div class="mic-status" id="micStatus">麦克风尚未启动</div>
          <button class="record-button" id="recordButton" aria-label="开始录音"></button>
          <div class="record-limit"><span>作答限时</span><b>${formatTime(task.seconds)}</b></div>
          <div class="record-hint" id="recordHint">题目朗读中，请稍候…</div>
        </div>
      </article>
    </section>`;
  document.querySelector("#recordButton").addEventListener("click", toggleRecording);
  document.querySelector("#inlineDevice").addEventListener("click", selectMicrophone);
  document.querySelector("#recordButton").disabled = true;
  runTaskNarration(task);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function runTaskNarration(task) {
  const taskIndex = state.index;
  const completed = await speak(task.task);
  if (taskIndex !== state.index || !document.querySelector("#recordButton")) return;
  if (!completed) notify("题目朗读未正常完成，已继续进入作答流程。 ");
  if (task.prep) startPrepTimer(task.prep);
  else {
    document.querySelector("#recordButton").disabled = false;
    document.querySelector("#recordHint").textContent = "题目朗读结束 · 点击开始录音";
  }
}

function startPrepTimer(seconds) {
  const button = document.querySelector("#recordButton");
  button.disabled = true;
  let remaining = seconds;
  const el = document.querySelector("#prepTimer");
  const panel = document.querySelector("#prepPanel");
  panel.classList.remove("waiting");
  panel.querySelector("div").innerHTML = "<b>PREPARATION</b><br><small>组织观点，不要写完整稿件</small>";
  const tick = () => {
    el.textContent = formatTime(remaining);
    if (remaining-- <= 0) {
      clearInterval(state.timerId);
      button.disabled = false;
      document.querySelector("#prepPanel").innerHTML = "<b>准备时间结束，可以开始作答。</b>";
      notify("准备时间结束");
    }
  };
  tick();
  state.timerId = setInterval(tick, 1000);
}

async function toggleRecording() {
  if (state.mediaRecorder?.state === "recording") return stopRecording();
  try {
    if (!navigator.mediaDevices?.getUserMedia || !("MediaRecorder" in window)) {
      throw new Error("当前浏览器不支持麦克风录音，请使用最新版 Chrome 或 Edge。 ");
    }
    state.stream = await getSelectedAudioStream();
    const audioTrack = state.stream.getAudioTracks()[0];
    if (!audioTrack || audioTrack.readyState !== "live") {
      throw new Error("麦克风已授权，但当前输入设备没有提供音频，请检查系统默认麦克风。 ");
    }
    const mimeTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
    const type = mimeTypes.find((value) => MediaRecorder.isTypeSupported(value));
    state.mediaRecorder = type ? new MediaRecorder(state.stream, { mimeType: type }) : new MediaRecorder(state.stream);
    state.chunks = [];
    state.mediaRecorder.ondataavailable = (event) => event.data.size && state.chunks.push(event.data);
    state.mediaRecorder.onstop = async () => {
      stopInputMeter();
      state.stream?.getTracks().forEach((track) => track.stop());
      await processRecording();
    };
    state.mediaRecorder.start(250);
    state.recordStarted = performance.now();
    state.autoStopped = false;
    state.peakInputLevel = 0;
    state.soundDetected = false;
    document.querySelector("#recordZone").classList.add("recording");
    document.querySelector("#recordHint").textContent = `剩余 ${formatTime(state.tasks[state.index].seconds)} · 可提前点击停止`;
    const deviceName = audioTrack.label || "当前麦克风";
    document.querySelector("#micStatus").textContent = `${deviceName} · 等待检测声音`;
    await startInputMeter(state.stream);
    startRecordClock();
  } catch (error) {
    stopInputMeter();
    state.stream?.getTracks().forEach((track) => track.stop());
    notify(error.name === "NotAllowedError" ? "麦克风权限被拒绝，请在浏览器地址栏中允许后重试。" : `无法启动麦克风：${error.message}`);
  }
}

async function startInputMeter(stream) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  state.meterContext = new AudioContextClass();
  await state.meterContext.resume();
  const source = state.meterContext.createMediaStreamSource(stream);
  const analyser = state.meterContext.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.65;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const bars = [...document.querySelectorAll(".wave i")];
  const update = () => {
    if (!state.mediaRecorder || state.mediaRecorder.state !== "recording") return;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const rms = Math.sqrt(sum / samples.length);
    state.peakInputLevel = Math.max(state.peakInputLevel, rms);
    if (rms >= 0.012) state.soundDetected = true;
    const visualLevel = Math.min(1, rms * 28);
    bars.forEach((bar, index) => {
      const variation = 0.45 + ((index * 7) % 10) / 18;
      bar.style.height = `${Math.max(5, 8 + visualLevel * 42 * variation)}px`;
    });
    const status = document.querySelector("#micStatus");
    if (status) {
      status.textContent = state.soundDetected ? "已检测到你的声音" : "未检测到声音，请靠近麦克风说话";
      status.className = `mic-status ${state.soundDetected ? "active" : "warning"}`;
    }
    state.meterFrame = requestAnimationFrame(update);
  };
  update();
}

function stopInputMeter() {
  if (state.meterFrame) cancelAnimationFrame(state.meterFrame);
  state.meterFrame = null;
  if (state.meterContext && state.meterContext.state !== "closed") state.meterContext.close().catch(() => {});
  state.meterContext = null;
}

function startRecordClock() {
  clearInterval(state.timerId);
  const update = () => {
    const elapsed = (performance.now() - state.recordStarted) / 1000;
    const max = state.tasks[state.index].seconds;
    const remaining = Math.max(0, Math.ceil(max - elapsed));
    const hint = document.querySelector("#recordHint");
    const limit = document.querySelector(".record-limit b");
    if (hint) hint.textContent = `剩余 ${formatTime(remaining)} · 可提前点击停止`;
    if (limit) limit.textContent = formatTime(remaining);
    if (elapsed >= max && !state.autoStopped) {
      state.autoStopped = true;
      notify("本题作答时间结束，录音已自动停止。 ");
      stopRecording();
    }
  };
  update();
  state.timerId = setInterval(update, 250);
}

function stopRecording() {
  clearInterval(state.timerId);
  if (state.mediaRecorder?.state === "recording") {
    const button = document.querySelector("#recordButton");
    const hint = document.querySelector("#recordHint");
    if (button) button.disabled = true;
    if (hint) hint.textContent = "正在保存录音，请稍候…";
    try { state.mediaRecorder.requestData(); } catch { /* Some browsers do not need an explicit flush. */ }
    state.mediaRecorder.stop();
  }
}

async function processRecording() {
  const duration = (performance.now() - state.recordStarted) / 1000;
  const task = state.tasks[state.index];
  if (duration < 1.5) {
    notify("录音太短，请重新作答。 ");
    renderTask();
    return;
  }
  const zone = document.querySelector("#recordZone");
  zone.classList.remove("recording");
  zone.innerHTML = `<div class="processing"><i></i><i></i><i></i><span>AI 正在听取并严格分析</span></div>`;
  try {
    const webm = new Blob(state.chunks, { type: state.mediaRecorder.mimeType });
    if (!webm.size) throw new Error("浏览器没有生成录音数据，请检查麦克风权限和输入设备。 ");
    const { wav, metrics } = await convertToWavAndMeasure(webm);
    if (metrics.averageRms < 0.0025 || metrics.silenceRatio > 0.985) {
      throw new Error("录音中没有检测到清晰的人声。请确认系统选择了正确的麦克风，并观察录音时音量条是否跳动。 ");
    }
    const form = new FormData();
    form.append("audio", wav, `answer-${Date.now()}.wav`);
    form.append("task", task.task);
    form.append("duration", String(duration));
    form.append("maxSeconds", String(task.seconds));
    form.append("metrics", JSON.stringify(metrics));
    const result = await api("/api/answer/analyze", { method: "POST", body: form });
    const answer = { section: task.section, label: task.label, task: task.task, duration, metrics, ...result };
    state.answers.push(answer);
    if (task.kind === "discussion") {
      state.discussionHistory.push({ role: "AI partner", text: task.task }, { role: "Candidate", text: result.transcript });
    }
    renderAnswerFeedback(answer);
  } catch (error) {
    zone.innerHTML = `<p class="prompt-note">分析失败：${escapeHtml(error.message)}</p><button class="button ghost" id="retryButton">重新录音</button>`;
    document.querySelector("#retryButton").addEventListener("click", renderTask);
  }
}

function renderAnswerFeedback(answer) {
  const a = answer.analysis && typeof answer.analysis === "object" ? answer.analysis : {};
  const isIntroduction = state.tasks[state.index]?.label === "自我介绍";
  const averageScore = Number(a.averageScore ?? ((a.accuracyRange + a.coherence + a.flexibility + a.pronunciation + a.relevance) / 5));
  const grade = a.grade || gradeFromFive(averageScore);
  const qualified = typeof a.qualified === "boolean" ? a.qualified : isQualifiedGrade(grade);
  const zone = document.querySelector("#recordZone");
  zone.innerHTML = `
    <div class="analysis-panel">
      <div class="analysis-scores">
        ${miniScore(a.accuracyRange, "准确与范围")}${miniScore(a.coherence, "连贯性")}${miniScore(a.flexibility, "灵活适切")}${miniScore(a.pronunciation, "语音表现")}${miniScore(a.relevance, "切题程度")}
      </div>
      <div class="grade-banner ${qualified ? "pass" : "fail"}">
        <div><span>本题评级</span><strong>${grade}</strong></div>
        <div><b>${qualified ? "合格" : "未合格"}</b><small>C 及以上为合格</small></div>
      </div>
      <div class="transcript"><b>TRANSCRIPT</b><br>${escapeHtml(answer.transcript || "未识别到有效语音")}</div>
      <div class="feedback-summary"><h3>本题点评</h3><p>${escapeHtml(a.summary)}</p></div>
      <p class="prompt-note"><b>下一步：</b>${escapeHtml(a.nextStep)}</p>
      <div class="answer-templates">
        ${renderAnswerTemplate("你的作答优化版", "保留你的观点，只修正并补齐结构", a.optimizedAnswer, "optimized", isIntroduction)}
        ${renderAnswerTemplate("标准答案", "独立参考答案，使用相同固定模板", a.standardAnswer, "standard", isIntroduction)}
      </div>
      <div class="next-row"><button class="button primary" id="nextButton">${nextButtonText()} <span>→</span></button></div>
    </div>`;
  document.querySelector("#speakOptimized")?.addEventListener("click", () => speak(a.optimizedAnswer?.fullAnswer));
  document.querySelector("#speakStandard")?.addEventListener("click", () => speak(a.standardAnswer?.fullAnswer));
  document.querySelector("#nextButton").addEventListener("click", advance);
}

function renderAnswerTemplate(title, subtitle, answer, type, isIntroduction) {
  const safe = answer || {};
  const labels = isIntroduction
    ? ["开场与基本信息", "个人细节一", "具体例子一", "个人细节二", "具体例子二", "结尾"]
    : ["观点", "理由一", "例子一", "理由二", "例子二", "总结"];
  const values = [safe.opinion, safe.reason1, safe.example1, safe.reason2, safe.example2, safe.conclusion];
  const speakId = type === "optimized" ? "speakOptimized" : "speakStandard";
  return `
    <article class="template-answer ${type}">
      <div class="template-heading">
        <div><span>${type === "optimized" ? "YOUR IMPROVED ANSWER" : "MODEL ANSWER"}</span><h3>${title}</h3><p>${subtitle}</p></div>
        <b>约 ${Number(safe.estimatedSeconds || state.tasks[state.index].seconds)} 秒</b>
      </div>
      <div class="template-steps">
        ${values.map((value, index) => `<div><span>${String(index + 1).padStart(2, "0")}</span><b>${labels[index]}</b><p>${escapeHtml(value || "—")}</p></div>`).join("")}
      </div>
      <div class="full-answer"><span>可直接作答</span><p>${escapeHtml(safe.fullAnswer || "暂未生成。")}</p></div>
      <button class="sample-speak" id="${speakId}">朗读完整答案 ▶</button>
    </article>`;
}

function miniScore(value, label) {
  return `<div class="mini-score"><b>${Number(value).toFixed(1)}</b><span>${label} / 5</span></div>`;
}

function gradeFromFive(score) {
  if (score >= 4.75) return "A+";
  if (score >= 4.5) return "A";
  if (score >= 4.25) return "A-";
  if (score >= 4) return "B+";
  if (score >= 3.75) return "B";
  if (score >= 3.5) return "B-";
  if (score >= 3.25) return "C+";
  if (score >= 3) return "C";
  if (score >= 2.75) return "C-";
  if (score >= 2.5) return "D+";
  if (score >= 2) return "D";
  return "D-";
}

function isQualifiedGrade(grade) {
  return ["A+", "A", "A-", "B+", "B", "B-", "C+", "C"].includes(grade);
}

function nextButtonText() {
  const task = state.tasks[state.index];
  if (task.kind === "discussion" && task.round < task.rounds) return "继续讨论";
  return state.index === state.tasks.length - 1 ? "生成最终评价" : "下一题";
}

async function advance() {
  const task = state.tasks[state.index];
  if (task.kind === "discussion" && task.round < task.rounds) {
    loading("AI 搭档正在回应");
    try {
      const next = await api("/api/discussion/next", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: task.topic, history: state.discussionHistory }),
      });
      task.task = next.prompt;
      task.round += 1;
      renderTask();
      return;
    } catch (error) {
      notify(error.message);
      renderTask();
      return;
    }
  }
  state.index += 1;
  if (state.index >= state.tasks.length) return finishExam();
  const nextTask = state.tasks[state.index];
  if (!state.introducedSections.has(nextTask.section)) renderSectionIntro();
  else renderTask();
}

async function finishExam() {
  loading("正在生成全卷综合评价");
  try {
    const result = await api("/api/exam/final-score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: state.answers }),
    });
    renderResult(result);
  } catch (error) {
    notify(error.message);
    state.index = Math.max(0, state.tasks.length - 1);
    renderTask();
  }
}

function renderResult(r) {
  r = r && typeof r === "object" ? r : {};
  const angle = Math.max(0, Math.min(100, (r.total / 15) * 100));
  const grade = r.grade || gradeFromFive(r.total / 3);
  const qualified = typeof r.qualified === "boolean" ? r.qualified : isQualifiedGrade(grade);
  app.innerHTML = `
    <section class="result-page">
      <div class="result-hero">
        <div class="score-ring" style="--score-angle:${angle}%"><div><b>${Number(r.total).toFixed(1)}</b><span>OUT OF 15</span></div></div>
        <div class="result-copy"><span class="level">${escapeHtml(r.level)}</span><div class="overall-grade ${qualified ? "pass" : "fail"}"><strong>${grade}</strong><div><b>${qualified ? "总体合格" : "总体未合格"}</b><span>C 及以上为合格</span></div></div><h1>${state.mode === "full" ? "模拟考试总体评级" : "本次训练总体评级"}</h1><p>${escapeHtml(r.verdict)}</p><button class="button primary" data-mode="${state.mode}">再练一套 <span>↗</span></button></div>
      </div>
      <div class="dimension-grid">
        ${dimension(r.accuracyRange, "准确性与范围")}${dimension(r.coherence, "话语长短与连贯性")}${dimension(r.flexibility, "灵活性与适切性")}
      </div>
      <div class="feedback-grid">
        <article class="feedback-card"><h3>表现优势</h3><ul>${safeArray(r.strengths).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></article>
        <article class="feedback-card"><h3>主要失分点</h3><ul>${safeArray(r.weaknesses).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></article>
        <article class="feedback-card wide"><h3>下一阶段行动计划</h3><ol>${safeArray(r.actionPlan).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ol></article>
        <article class="feedback-card wide"><h3>分环节评价</h3>${safeArray(r.sectionReviews).map((x) => `<p><b>${escapeHtml(x?.section)}</b>　${escapeHtml(x?.comment)}</p>`).join("")}</article>
      </div>
      <p class="disclaimer">等级为训练性映射，AI 结果不等同于官方 CET-SET6 成绩。</p>
    </section>`;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function dimension(score, name) {
  return `<article class="dimension"><small>${name}</small><br><b>${Number(score).toFixed(1)}</b> / 5<div class="bar"><i style="width:${score / 5 * 100}%"></i></div></article>`;
}

async function testMicrophone() {
  let stream;
  let context;
  try {
    stream = await getSelectedAudioStream();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    context = new AudioContextClass();
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let peak = 0;
    notify("麦克风测试中，请连续说话 2 秒…");
    const started = performance.now();
    while (performance.now() - started < 2200) {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      peak = Math.max(peak, Math.sqrt(sum / samples.length));
      await delay(80);
    }
    const label = stream.getAudioTracks()[0]?.label || "当前麦克风";
    notify(peak >= 0.008 ? `麦克风正常：${label} 已检测到声音。` : `${label} 已连接，但没有检测到明显声音，请检查系统输入设备和音量。`);
  } catch (error) {
    notify(error.name === "NotAllowedError" ? "未获得麦克风权限，请在浏览器地址栏中允许麦克风。" : `麦克风测试失败：${error.message}`);
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
    if (context && context.state !== "closed") await context.close().catch(() => {});
  }
}

async function convertToWavAndMeasure(blob) {
  const context = new AudioContext();
  const arrayBuffer = await blob.arrayBuffer();
  const decoded = await context.decodeAudioData(arrayBuffer);
  const targetRate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
  const source = offline.createBufferSource();
  const mono = offline.createBuffer(1, decoded.length, decoded.sampleRate);
  const monoData = mono.getChannelData(0);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const channel = decoded.getChannelData(c);
    for (let i = 0; i < channel.length; i++) monoData[i] += channel[i] / decoded.numberOfChannels;
  }
  source.buffer = mono;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);
  const wav = encodeWav(samples, targetRate);
  const frameSize = Math.floor(targetRate * 0.02);
  let silent = 0;
  let rmsSum = 0;
  let frames = 0;
  for (let start = 0; start < samples.length; start += frameSize) {
    let sum = 0;
    const end = Math.min(samples.length, start + frameSize);
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    rmsSum += rms;
    frames++;
    if (rms < 0.012) silent++;
  }
  await context.close();
  return { wav, metrics: { duration: decoded.duration, silenceRatio: Number((silent / Math.max(1, frames)).toFixed(3)), averageRms: Number((rmsSum / Math.max(1, frames)).toFixed(4)) } };
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  write(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (const sample of samples) { const clipped = Math.max(-1, Math.min(1, sample)); view.setInt16(offset, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true); offset += 2; }
  return new Blob([view], { type: "audio/wav" });
}

function formatTime(seconds) { return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
function formatDuration(seconds) { return seconds >= 60 ? `${Math.floor(seconds / 60)} 分${seconds % 60 ? ` ${seconds % 60} 秒` : "钟"}` : `${seconds} 秒`; }
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = String(value ?? ""); return div.innerHTML; }
function stopStreams() { clearInterval(state.timerId); state.narrationId += 1; stopInputMeter(); window.speechSynthesis?.cancel?.(); state.stream?.getTracks().forEach((track) => track.stop()); }

document.addEventListener("click", (event) => {
  const mode = event.target.closest("[data-mode]")?.dataset.mode;
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (mode) startExam(mode);
  if (action === "home") renderHome();
  if (action === "mic-select") selectMicrophone();
  if (action === "mic-test") testMicrophone();
});

window.addEventListener("beforeunload", stopStreams);
renderHome();
checkStatus();
