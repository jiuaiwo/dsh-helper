/**
 * 「对话完成提示音」的纯逻辑核心：没有任何 JSX / DOM / React 依赖。
 *
 * 拆出来的理由与 schedule-cron.js 一样 —— **能在 Node 里判定的东西就别开浏览器**。
 * 边沿检测、去抖、子会话过滤这几件事是这一块最容易错的地方（错了只表现为
 * 「不该响的时候响了」或「该响的时候没响」，界面上完全看不出来），放在这里
 * 就能被 tools/client-smoke.mjs 直接 import 逐条断言。
 *
 * 触发信号取自 DSH 客户端既有的会话状态仓库（@deepseek-ai/dsh-client-ui-session）：
 *   `api-session/status(sessionId, running)` → `Map<sessionId, {running, …}>`，
 *   其中 host 侧 `running = agent.status === "running"`，即**整个 turn 的执行期**。
 *
 * 两个必须记住的约束（都是读源码得出的，不是猜的）：
 *
 * 1. **不能用 `completionUnread` 当触发信号。** `UiSession.observeRunning()` 只在
 *    `!isMain(sessionId)` 时给它置位 —— 它是给「你正在看的会话之外」的会话画绿点用的，
 *    当前主视图那个会话跑完**永远不会**进 unread。
 * 2. **turn 之间会抖动，必须去抖。** `AgentLoop.kick()` 收尾时若
 *    `wakeRequested && inbox.hasPending` 会立刻重新 `wakeDriver()`；
 *    `goal-round-driver` 在 `agent/status` 的 idle 上直接 `requestDrive()` 续下一轮。
 *    所以 `running` 会在几十毫秒内 true→false→true，不去抖就是一串连响。
 */

/* ------------------------------------------------------------------ 偏好键 */

/**
 * localStorage 键。前缀用本插件包名（呼吸灯那几个键沿用并入前的 `dsh-sidebar-glow:*`，
 * 那是为了不重置用户已有的风格选择；本功能是全新的，没有历史包袱，直接用自己的前缀）。
 */
export const SOUND_KEYS = {
  enabled: "dsh-helper:sound:enabled",
  tone: "dsh-helper:sound:tone",
  volume: "dsh-helper:sound:volume",
  awayOnly: "dsh-helper:sound:away-only",
  /** 最近一次播放的时间戳，用于「短窗口内不重复响」（多标签页去重 + turn 结束抖动冷却）。 */
  lastPlayedAt: "dsh-helper:sound:last-played-at",
};

/**
 * 确认「真的停下来了」的等待窗口。
 *
 * 为什么要等：一轮结束时，goal 自动续轮 / 团队消息会让引擎在很短时间内重新跑起来，
 * 不确认就响会连响。为什么是 300ms 而不是更长：同步的 inbox 唤醒间隙 ≈ 0ms，
 * 小/中会话的 goal checkpoint 续轮通常也在 300ms 内；而单轮对话里这段**纯属延迟**——
 * 之前 800ms 让用户「完成还要等约 1 秒」，太拖。300ms 落在「吃掉续轮」与「完成即响」之间。
 * 代价：万一某次 goal 续轮（大会话落盘）超过 300ms，会多响一声（可接受，可关）。
 */
export const DEBOUNCE_MS = 300;

/**
 * 「一声之后多久不再响」的窗口。
 *
 * 原意是多标签页去重（同一台机器开两个标签页，只让一个出声）。实测发现它还得兼任
 * **turn 结束抖动冷却**：turn 结束时客户端 `useSessionStatus` 的 running 有两条更新路径
 * （`api-session/status` 事件 vs `sessions.list` 投影的 `reconcileStatus`），时序不一致时
 * 会产生**好几次下降沿**，每次间隔都远超 300ms 去抖，于是「一轮结束叮好几下」。
 * 5 秒足够把这一串并成一声，又不至于吃掉「下一轮对话完成」的提醒（连续两轮通常 >5 秒）。
 */
export const DEDUPE_MS = 5000;

/**
 * 总增益上限。
 *
 * 为什么不是 1.0：合成音是多音叠加的（叮咚两个音有约 70ms 重叠），直接给满会让
 * 重叠瞬间超过 1.0 硬削波、听感发炸。0.8 落在「默认够响」与「留出防削波余量」之间：
 * 中档实际峰值约 0.52、响档约 0.8，接近系统提示音的响度。
 */
export const MASTER_GAIN = 0.8;

/* -------------------------------------------------------------------- 音色 */

/**
 * 合成音音色表。
 *
 * 全部现场用振荡器合成，不带音频文件：没有版权问题、不增加包体积、音量与音色
 * 都能直接由参数控制（内置 mp3 的话这三样都得预先烘焙）。
 *
 * `notes` 是**数据**而不是代码，好处是冒烟测试能直接断言「三连音有三个音」「叮咚是上行」，
 * 而不用去 mock 整个 Web Audio。
 *
 * 每个 note 除了 freq / at / duration / type / gain，还可以带一个可选的 `glide`（扫频终点）：
 * 有它就从 freq 指数滑到 glide（exponentialRamp），用来做「扫频」「激光」这类电子音效。
 */
export const TONES = [
  {
    id: "chime",
    label: "叮咚",
    hint: "两音上行 C6 → E6，像门铃，最不容易听腻。",
    notes: [
      { freq: 1046.5, at: 0, duration: 0.18, type: "triangle", gain: 1 },
      { freq: 1318.5, at: 0.11, duration: 0.34, type: "triangle", gain: 0.9 },
    ],
  },
  {
    id: "ding",
    label: "单音叮",
    hint: "单音带泛音，短促干净。",
    notes: [
      { freq: 880, at: 0, duration: 0.45, type: "sine", gain: 1 },
      { freq: 1760, at: 0, duration: 0.26, type: "sine", gain: 0.35 },
    ],
  },
  {
    id: "triple",
    label: "三连音",
    hint: "三音上行 G5 → C6 → E6，最显眼，适合把窗口切走时用。",
    notes: [
      { freq: 784, at: 0, duration: 0.12, type: "square", gain: 0.5 },
      { freq: 1046.5, at: 0.09, duration: 0.12, type: "square", gain: 0.5 },
      { freq: 1318.5, at: 0.18, duration: 0.3, type: "square", gain: 0.45 },
    ],
  },
  {
    id: "beep",
    label: "电子哔",
    hint: "两声短促方波，像老式电子设备的提示音。",
    notes: [
      { freq: 1000, at: 0, duration: 0.08, type: "square", gain: 0.6 },
      { freq: 1000, at: 0.16, duration: 0.08, type: "square", gain: 0.6 },
    ],
  },
  {
    id: "coin",
    label: "街机金币",
    hint: "上行方波琶音 B5 → E6 → G♯6，像游戏里捡到金币。",
    notes: [
      { freq: 987.77, at: 0, duration: 0.07, type: "square", gain: 0.5 },
      { freq: 1318.51, at: 0.07, duration: 0.07, type: "square", gain: 0.5 },
      { freq: 1661.22, at: 0.14, duration: 0.22, type: "square", gain: 0.45 },
    ],
  },
  {
    id: "sweep",
    label: "扫频",
    hint: "锯齿波从低到高滑，像设备开机的科技感。",
    notes: [
      { freq: 200, glide: 1500, at: 0, duration: 0.45, type: "sawtooth", gain: 0.5 },
    ],
  },
  {
    id: "laser",
    label: "激光",
    hint: "从高到低快速下坠，像科幻片里的激光。",
    notes: [
      { freq: 2200, glide: 180, at: 0, duration: 0.28, type: "sawtooth", gain: 0.5 },
    ],
  },
];

export const DEFAULT_TONE = "chime";

/**
 * 「自定义音频」这一档。
 *
 * 它不是合成音，不在 TONES 里 —— 选了它就去 IndexedDB 里取用户自己选的音频文件。
 * 但**必须能被音色偏好接受**（TONE_IDS 要含它），否则 normalize 会把它当成非法值
 * 打回默认档，用户选完自定义一刷新就变回「叮咚」。
 */
export const CUSTOM_TONE_ID = "custom";

export const TONE_IDS = [...TONES.map((tone) => tone.id), CUSTOM_TONE_ID];

/** 音色选项（含「自定义」），供设置卡片直接渲染。 */
export const TONE_CHOICES = [
  ...TONES.map((tone) => ({ id: tone.id, label: tone.label })),
  { id: CUSTOM_TONE_ID, label: "自定义" },
];

/**
 * 自定义音频的落库上限。
 *
 * 提示音是「叮」一声，几百 KB 足够；4 MB 是给无损 wav 留的余量。
 * 再往上就不该塞进 IndexedDB 了（每次解码都要一份完整的内存副本）。
 */
export const CUSTOM_SOUND_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 校验一条自定义音频记录。
 *
 * 存储里的东西**不能默认它是干净的**：用户可能手改过 IndexedDB、也可能是旧版本写下的
 * 形状。形状不对、空数据、超限一律拒绝 —— 拒绝的后果是"回退成内置音"，不是崩溃。
 *
 * @param value - 待校验的记录 `{ name, data }`。
 * @returns 形状是否可用。
 */
export function isCustomSoundRecord(value) {
  if (value === null || typeof value !== "object") return false;
  if (typeof value.name !== "string" || value.name === "") return false;
  const data = value.data;
  if (data === null || data === undefined) return false;
  const isBuffer = typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer;
  const isView = typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(data);
  if (!isBuffer && !isView) return false;
  const bytes = data.byteLength;
  if (!Number.isFinite(bytes) || bytes <= 0) return false;
  return bytes <= CUSTOM_SOUND_MAX_BYTES;
}

/**
 * 把字节数写成人看的大小（设置卡片里显示已选文件用）。
 *
 * @param bytes - 字节数。
 * @returns 形如 `248 KB` / `1.4 MB` 的字符串。
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 音量档。三档按钮组比滑块更贴合卡片里其它设置（也用 ChoiceGroup）。 */
export const VOLUMES = [
  { id: "soft", label: "轻", gain: 0.35 },
  { id: "medium", label: "中", gain: 0.65 },
  { id: "loud", label: "响", gain: 1 },
];

export const DEFAULT_VOLUME = "medium";
export const VOLUME_IDS = VOLUMES.map((volume) => volume.id);

/**
 * 把「音色 + 音量档」翻成一份可直接执行的排程：音符 + 已乘好增益的频率与时刻。
 *
 * 非法 id 一律退回默认档，不抛错 —— 偏好是用户手改 localStorage 也能碰到的输入，
 * 为一个提示音崩掉整个插件不值得。
 *
 * @param toneId - 音色 id。
 * @param volumeId - 音量档 id。
 * @returns `{ id, label, notes }`，notes 里每项含 freq / at / duration / type / gain（0~1 线性增益）。
 */
export function completionSoundSpec(toneId, volumeId) {
  const tone = TONES.find((item) => item.id === toneId) ?? TONES.find((item) => item.id === DEFAULT_TONE);
  const volume = VOLUMES.find((item) => item.id === volumeId) ?? VOLUMES.find((item) => item.id === DEFAULT_VOLUME);
  return {
    id: tone.id,
    label: tone.label,
    notes: tone.notes.map((note) => ({
      ...note,
      gain: note.gain * volume.gain * MASTER_GAIN,
    })),
  };
}

/* ---------------------------------------------------------------- 会话判定 */

/**
 * 顶级（主）会话判定。
 *
 * 只认一条：**没有 `parentSessionId` 的会话**。这一条同时排除两类：
 *   · 子代理会话 —— header.origin 只能是 "subagent"，且带 parentSession
 *     （dsh-session/lib/types/index.js 里会话头校验写死了这一点）；
 *   · Agent Teams 的队友 —— teammate 是 Team Lead 的 continuable 直接子会话
 *     （dsh-experimental-agent-team 的 roster 用 `header.parentSession` 找 root）。
 *
 * 拿不到行数据时**判定为"不是主会话"**：宁可漏响，也不要把一堆子代理的完成
 * 都播成提示音（那种噪声会直接让人把功能关掉）。
 *
 * @param row - `useSessions().byId[sessionId]` 这一行。
 * @returns 是否顶级会话。
 */
export function isTopLevelSession(row) {
  if (row === null || row === undefined) return false;
  // 同时排除 null 与 undefined：JSON 序列化/反序列化路径里，主会话的
  // parentSessionId 可能被写成 null 而不是缺省，写死 `=== undefined` 会把主会话
  // 误判成子会话、静默漏响。
  const pid = row.parentSessionId;
  return pid === undefined || pid === null;
}

/**
 * 从会话状态快照 + 会话目录里算出「正在跑的顶级会话」id 集合。
 *
 * @param statuses - `useSessionStatus` 的快照：`Map<sessionId, {running, …}>`。
 * @param byId - `useSessions().byId`：`{ [sessionId]: row }`。
 * @returns 顶级且 running === true 的会话 id 集合。
 */
export function collectRunningTopLevel(statuses, byId) {
  const running = new Set();
  if (statuses === null || statuses === undefined || typeof statuses.forEach !== "function") return running;
  const rows = byId !== null && typeof byId === "object" ? byId : {};
  statuses.forEach((status, sessionId) => {
    if (status?.running !== true) return;
    if (!isTopLevelSession(rows[sessionId])) return;
    running.add(sessionId);
  });
  return running;
}

/* ------------------------------------------------------------ 边沿 + 去抖 */

/**
 * 「停下来」检测器：观察一串快照，只在**确认停下**时回调。
 *
 * 为什么是"一批一个定时器"而不是"一个会话一个定时器"：同一次快照里可能有多个
 * 会话同时停下（例如 Lead 与几个后台会话一起收尾），那种情况应当**只响一声**。
 * 批内的 id 在等待窗口结束时逐个复核 —— 期间又跑起来的会被剔掉，剩下的才算数；
 * 全被剔掉就不响（这正是"自动续轮"被吃掉的那条路径）。
 *
 * 定时器可注入，好让冒烟用假时钟把去抖窗口一次性推过去，而不是真等。
 *
 * @param options - `debounceMs` 等待窗口；`schedule` / `cancel` 定时器实现；
 *                  `onComplete` 收到确认停下的 id 数组（至少一个元素）。
 */
export function createDetector({
  debounceMs = DEBOUNCE_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  onComplete = () => {},
} = {}) {
  let previous = new Set();
  let latest = new Set();
  let batch = [];
  let timer;

  const flush = () => {
    timer = undefined;
    const waiting = batch;
    batch = [];
    const completed = waiting.filter((id) => !latest.has(id));
    if (completed.length > 0) onComplete(completed);
  };

  /**
   * 喂一帧快照。
   *
   * 第一帧只建立基线、绝不触发：否则「打开页面时会话正好在跑」之后它会立刻
   * 被当成刚停下（那一声会响得莫名其妙）。
   *
   * @param runningIds - 当前正在跑的顶级会话 id 集合（或可迭代对象）。
   */
  const observe = (runningIds) => {
    const next = runningIds instanceof Set ? runningIds : new Set(runningIds ?? []);
    latest = next;
    const stopped = [...previous].filter((id) => !next.has(id));
    previous = next;
    if (stopped.length === 0) return;
    for (const id of stopped) if (!batch.includes(id)) batch.push(id);
    if (timer === undefined) timer = schedule(flush, debounceMs);
  };

  /** 关掉开关时清干净：基线与待确认批次都丢弃，免得重新打开时补响一声。 */
  const reset = () => {
    previous = new Set();
    latest = new Set();
    batch = [];
    if (timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
  };

  return {
    observe,
    reset,
    /** 待确认的 id 数量（测试用）。 */
    waiting: () => batch.length,
    /** 是否已有批定时器在等（测试用）。 */
    armed: () => timer !== undefined,
  };
}

/* ------------------------------------------------------ 页面可见性与去重 */

/**
 * 「人现在没在看这个页面」判定，供「只在切走时响」这一档使用。
 *
 * 用标准 API：`document.hidden`（切标签页 / 最小化）与 `document.hasFocus()`
 * （窗口还在但焦点在别的 app 上）。判不出来的环境（例如 Node 里的渲染冒烟）
 * 一律返回 false = 当人在看，**不响**：静音是安全的一侧。
 *
 * @param doc - 文档对象，默认取全局。
 * @returns 是否需要靠声音叫人。
 */
export function pageIsAway(doc = typeof document === "undefined" ? undefined : document) {
  if (doc === null || doc === undefined) return false;
  if (doc.hidden === true) return true;
  if (typeof doc.hasFocus === "function") return !doc.hasFocus();
  return false;
}

/**
 * 「一声之后多久不再响」的门卫。
 *
 * 同一台机器开两个标签页时，两边都会看到同一个会话停下来、于是同时出声——这是它原来的
 * 职责。实测还发现 turn 结束时 running 信号会抖几下（见 DEDUPE_MS 注释），所以它顺带
 * 兼任冷却：用 localStorage 里的时间戳，窗口内已经播过就闭嘴。
 *
 * 已知不足：两个标签页在同一毫秒级窗口内**同时**读到旧值时，仍可能都播（竞态）。
 * 这只影响声音重复，不影响任何状态，所以不值得为它上锁。
 *
 * @param options - `windowMs` 去重/冷却窗口；`now` 时钟；`read` / `write` 读写时间戳。
 * @returns 判定函数：允许播则返回 true，并顺手写下本次时间戳。
 */
export function createPlayGuard({
  windowMs = DEDUPE_MS,
  now = () => Date.now(),
  read = () => null,
  write = () => {},
} = {}) {
  return () => {
    const stamp = now();
    const last = Number(read());
    if (Number.isFinite(last) && last > 0 && stamp - last < windowMs) return false;
    try {
      write(String(stamp));
    } catch {
      /* 写不进去只意味着去重失效，不影响出声 */
    }
    return true;
  };
}
