/**
 * 对话完成提示音：会话跑完时出一声，把人从别的窗口叫回来。
 *
 * 定位：呼吸灯解决的是「哪个工作区有事」，这块解决的是「**什么时候**有事而且你可能没在看」。
 * 两者读的是同一份会话状态快照（见 sound-core.js 顶部对信号来源与两个坑的说明），
 * 所以也挂在同一个槽位 `shell.overlay` 上 —— 那是 shell 级的常驻覆盖层，
 * 不随侧边栏折叠或切换会话视图卸载。
 *
 * 三件事都在这个文件里：
 *   1. 观察组件 `CompletionWatcher`：把 running 的边沿喂给检测器；
 *   2. 合成音 `playTone`：振荡器 + 指数包络，现场合成，不带音频文件；
 *   3. 设置组 `SoundSettings`：渲染进「插件信息 → 本插件」的那张卡片。
 *
 * 浏览器自动播放策略是这块唯一的硬约束：AudioContext 出厂是 suspended，
 * 必须**在用户手势里**resume 一次才会出声。所以挂载时先注册一次性的
 * pointerdown / keydown 解锁；没解锁过就静默跳过（不报错、不弹窗），
 * 设置卡片里那颗「试听」按钮同样是手势，点一下也就解锁了。
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { S, Row, ChoiceGroup, ActionButton } from "./ui.jsx";
import { createPreference } from "./prefs.js";
import {
  CUSTOM_SOUND_MAX_BYTES,
  CUSTOM_TONE_ID,
  DEFAULT_TONE,
  DEFAULT_VOLUME,
  MASTER_GAIN,
  SOUND_KEYS,
  TONE_CHOICES,
  TONE_IDS,
  TONES,
  VOLUME_IDS,
  VOLUMES,
  collectRunningTopLevel,
  completionSoundSpec,
  createDetector,
  createPlayGuard,
  formatBytes,
  isCustomSoundRecord,
  pageIsAway,
} from "./sound-core.js";

/** 槽位注册 id / 样式命名空间。 */
const NS = "dsh-helper-sound";

/* ------------------------------------------------------------------ 偏好 */

const enabledPref = createPreference(SOUND_KEYS.enabled, (raw) => raw !== "false", true);
const tonePref = createPreference(SOUND_KEYS.tone, (raw) => (TONE_IDS.includes(raw) ? raw : DEFAULT_TONE), DEFAULT_TONE);
const volumePref = createPreference(
  SOUND_KEYS.volume,
  (raw) => (VOLUME_IDS.includes(raw) ? raw : DEFAULT_VOLUME),
  DEFAULT_VOLUME,
);
/** 默认「每次都响」：这是用户要的行为；切走才响是更安静的那一档，留给嫌吵的人。 */
const awayOnlyPref = createPreference(SOUND_KEYS.awayOnly, (raw) => raw === "true", false);

/* -------------------------------------------------------------------- 音频 */

/** 模块级单例：一个 AudioContext 够用，反复创建会撞上浏览器的上下文数量上限。 */
let audioContext;
/** 记录下来给设置卡片提示用：true 表示这个环境压根没有 Web Audio。 */
let audioUnsupported = false;

/**
 * 取（或惰性创建）AudioContext。
 *
 * @returns AudioContext；环境不支持时返回 null（不抛错）。
 */
function ensureAudioContext() {
  if (audioContext !== undefined) return audioContext;
  const Ctor = typeof window === "undefined" ? undefined : (window.AudioContext ?? window.webkitAudioContext);
  if (typeof Ctor !== "function") {
    audioUnsupported = true;
    audioContext = null;
    return null;
  }
  try {
    audioContext = new Ctor();
  } catch {
    audioUnsupported = true;
    audioContext = null;
  }
  return audioContext;
}

/** 在用户手势里解锁：没这一步，resume 之前的所有排程都是无声的。 */
function unlockAudio() {
  const audio = ensureAudioContext();
  // interrupted（iOS Safari 常见）同样需要 resume，不只 suspended。
  if (audio === null || audio.state === "running") return;
  // 失败（不是手势、或被策略拒绝）就算了，下次手势再试。
  audio.resume().catch(() => {});
}

/**
 * 按音色规格出声。
 *
 * 注意 `start` 的时机：suspended 状态下 `currentTime` 是**冻结**的，所以等
 * resume 成功之后再按 currentTime 排程，声音不会被排到"已经过去的时刻"。
 *
 * @param toneId - 音色 id。
 * @param volumeId - 音量档 id。
 * @returns 是否真的排上了（false = 环境不支持或还没解锁）。
 */
export function playTone(toneId, volumeId) {
  // 自定义音：文件已解码就直接用它（音量档同样生效）。
  if (toneId === CUSTOM_TONE_ID && customSound.buffer !== undefined) return playCustomSound(volumeId);
  // 选了自定义但文件还没就绪（还没读完 / 解码失败 / 清过浏览器数据）→ 回退内置合成音：
  // completionSoundSpec 对认不出的 id 本来就会退回默认档。静默不出声会让人以为功能坏了，
  // 响一声「叮咚」至少说明提示音这条链路是通的。
  const spec = completionSoundSpec(toneId, volumeId);
  const audio = ensureAudioContext();
  if (audio === null) return false;

  const start = () => {
    const base = audio.currentTime + 0.02;
    for (const note of spec.notes) {
      const oscillator = audio.createOscillator();
      const envelope = audio.createGain();
      oscillator.type = note.type;
      const at = base + note.at;
      // 频率用 setValueAtTime 锚在发声时刻（而不是 .value 直接赋值）：
      // 普通音恒定；带 glide 的从 freq 指数滑到 glide —— 这是「扫频 / 激光」的由来。
      oscillator.frequency.setValueAtTime(note.freq, at);
      if (Number.isFinite(note.glide) && note.glide > 0) {
        oscillator.frequency.exponentialRampToValueAtTime(note.glide, at + note.duration);
      }
      // 包络：起音 → 保持 → 平滑衰减。
      // 之前是「8ms 起音 + 立即指数衰减」：峰值只存在几毫秒，有效响度（RMS）极低，
      // 试听时专注能捕捉到尖峰、真实场景里注意力一分散就显得"很小"——这就是根因。
      // 现在起音后保持到 60% 再衰减，声音饱满得多。指数斜坡不能碰 0，两端都用极小值兜底。
      envelope.gain.setValueAtTime(0.0001, at);
      envelope.gain.exponentialRampToValueAtTime(Math.max(note.gain, 0.0002), at + 0.01);
      envelope.gain.setValueAtTime(note.gain, at + note.duration * 0.6);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + note.duration);
      oscillator.connect(envelope);
      envelope.connect(audio.destination);
      oscillator.start(at);
      oscillator.stop(at + note.duration + 0.02);
    }
  };

  if (audio.state !== "running") {
    audio.resume().then(start, () => {});
    return true;
  }
  start();
  return true;
}

/* -------------------------------------------------------------- 自定义音频 */

/**
 * 自定义提示音：用户在设置卡片里选一个音频文件（mp3 / wav / m4a / ogg…），
 * 存在浏览器 IndexedDB 里，播放时用 AudioBufferSourceNode 出声。
 *
 * 为什么是 IndexedDB + 文件选择器，而不是「把文件放进插件目录、由 host 开一条读取路由」：
 *   1. 提示音是纯浏览器侧的行为，为它给宿主加一条「按名字读本地文件」的路由，
 *      等于凭空多出一个文件读取面 —— 本插件的 /send-file 正是在那类面上栽过（见 KNOWN-ISSUES）；
 *   2. 文件选择器对用户更直接：不用知道插件装在哪、不用重启。
 * 代价是文件只存在**这个浏览器**里：换浏览器或清站点数据后要重新选。
 */
const CUSTOM_DB = "dsh-helper";
const CUSTOM_STORE = "sounds";
const CUSTOM_KEY = "completion-sound";

/**
 * 内存镜像：UI 与播放都读它，不每次都碰 IndexedDB。
 * `version` 是给 useSyncExternalStore 比较用的快照（对象引用会被复用，数字更稳）。
 */
export const customSound = {
  version: 0,
  /**
   * 每次 import 发起时递增。load / import 在 decode 完成、写回内存镜像前都比对它：
   * 对不上就说明期间有更新的 import 发起（用户又换了文件），这次的结果必须作废。
   * 没有它，挂载时的读库会在「库里已有旧文件、用户换新文件」的窗口里用旧记录覆盖新文件。
   */
  revision: 0,
  status: "idle", // idle | loading | ready | error
  name: "",
  bytes: 0,
  /** false = 解码成功但没能落库（隐私模式 / 无 IndexedDB），本次会话内照常可用。 */
  persisted: true,
  error: "",
  buffer: undefined,
  subscribers: new Set(),
  subscribe(listener) {
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  },
  emit() {
    this.version += 1;
    for (const listener of [...this.subscribers]) listener();
  },
};

/** 读一次内存镜像（含订阅）。 */
function useCustomSound() {
  const snapshot = () => customSound.version;
  return useSyncExternalStore((listener) => customSound.subscribe(listener), snapshot, snapshot);
}

/** 打开库。假环境（Node 渲染冒烟、隐私模式）里没有 indexedDB，一律 reject，由调用方降级。 */
function openCustomDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("这个浏览器不允许存本地文件"));
      return;
    }
    let request;
    try {
      request = indexedDB.open(CUSTOM_DB, 1);
    } catch (cause) {
      reject(cause);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CUSTOM_STORE)) db.createObjectStore(CUSTOM_STORE);
    };
    let abandoned = false;
    request.onsuccess = () => {
      // onblocked 之后若旧连接随后关闭，upgrade 仍会完成并触发 onsuccess ——
      // 这时要主动 close 掉这个已经没人要的连接，否则永久泄漏。
      if (abandoned) {
        request.result.close();
        return;
      }
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("打不开 IndexedDB"));
    // upgrade 被旧连接占住时触发（我们每次事务后都 close，正常不该走到这里，兜底而已）。
    request.onblocked = () => {
      abandoned = true;
      reject(new Error("IndexedDB 被其它连接占住，打不开"));
    };
  });
}

/** 跑一次单条事务；无论成败都关掉连接（不然打开着的连接会卡住后续 upgrade）。 */
function withCustomStore(mode, run) {
  return openCustomDb().then((db) => new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(CUSTOM_STORE, mode);
    } catch (cause) {
      db.close();
      reject(cause);
      return;
    }
    let request;
    try {
      request = run(transaction.objectStore(CUSTOM_STORE));
    } catch (cause) {
      db.close();
      reject(cause);
      return;
    }
    transaction.oncomplete = () => { db.close(); resolve(request?.result); };
    transaction.onerror = () => { db.close(); reject(transaction.error ?? new Error("IndexedDB 事务失败")); };
    transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error("IndexedDB 事务被中断")); };
  }));
}

/**
 * 解码成 AudioBuffer。
 *
 * `decodeAudioData` 会**接管**（detach）传进去的 ArrayBuffer，所以给它一份副本 ——
 * 否则要落库的那份原始字节会被清空，存下去的就是个空壳。
 */
async function decodeCustomSound(data) {
  const audio = ensureAudioContext();
  if (audio === null) throw new Error("这个浏览器没有 Web Audio");
  const copy = data instanceof ArrayBuffer
    ? data.slice(0)
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return await audio.decodeAudioData(copy);
}

/**
 * 从库里的记录刷新内存镜像与 AudioBuffer（挂载时调一次）。
 *
 * 与下面两个一起导出，是为了能在**真实浏览器**里跑一遍存储链路
 * （IndexedDB 的事务语义 + decodeAudioData 在冒烟的假环境里都验不了）。
 */
export async function loadCustomSound() {
  if (customSound.status === "loading") return;
  // 捕获当前 revision：这次读库/解码期间若有人发起 import（revision 变了），
  // 说明用户已经在换文件，读到的旧记录必须作废，不能覆盖新文件。
  const revision = customSound.revision;
  customSound.status = "loading";
  customSound.error = "";
  customSound.emit();
  let record;
  try {
    record = await withCustomStore("readonly", (store) => store.get(CUSTOM_KEY));
  } catch (cause) {
    if (customSound.revision === revision) {
      customSound.status = "idle";
      customSound.error = `读不到已保存的音频：${cause?.message ?? String(cause)}`;
      customSound.emit();
    }
    return;
  }
  if (customSound.revision !== revision) return; // 读库期间有 import，放弃
  if (!isCustomSoundRecord(record)) {
    // 没存过、或形状不可用（旧版本 / 手改过）——安静地当没有，不报错。
    customSound.status = "idle";
    customSound.name = "";
    customSound.bytes = 0;
    customSound.buffer = undefined;
    customSound.emit();
    return;
  }
  try {
    const buffer = await decodeCustomSound(record.data);
    if (customSound.revision !== revision) return; // decode 期间又有 import，放弃
    customSound.buffer = buffer;
    customSound.name = record.name;
    customSound.bytes = record.data.byteLength;
    customSound.status = "ready";
  } catch (cause) {
    if (customSound.revision === revision) {
      customSound.status = "error";
      customSound.error = `已保存的音频解不开：${cause?.message ?? String(cause)}`;
    }
  }
  customSound.emit();
}

/**
 * 用户选了一个文件：校验 → 解码 → 落库。
 *
 * 顺序是有意的：**先解码再落库**。解码失败就不该写进去（否则下次打开会读出一个解不开的
 * 文件，用户还找不到地方删）。反过来，落库失败不影响这次成功 —— 只是下次要重新选。
 *
 * @param file - `<input type="file">` 拿到的 File。
 */
export async function importCustomSound(file) {
  // 声明「我才是最新的一次选择」：并发中的旧 load / 旧 import 在写回前会发现
  // revision 对不上而放弃。
  const revision = ++customSound.revision;
  customSound.status = "loading";
  customSound.error = "";
  customSound.persisted = true;
  customSound.emit();

  let data;
  try {
    if (file.size > CUSTOM_SOUND_MAX_BYTES) {
      throw new Error(`文件 ${formatBytes(file.size)}，超过 ${formatBytes(CUSTOM_SOUND_MAX_BYTES)} 的上限`);
    }
    data = await file.arrayBuffer();
    if (!isCustomSoundRecord({ name: file.name, data })) throw new Error("读不出音频数据");
    const buffer = await decodeCustomSound(data);
    if (customSound.revision !== revision) {
      customSound.emit();
      return; // 解码期间有更新的 import，这次作废
    }
    customSound.buffer = buffer;
    customSound.name = file.name;
    customSound.bytes = data.byteLength;
    customSound.status = "ready";
  } catch (cause) {
    if (customSound.revision === revision) {
      customSound.status = "error";
      customSound.error = `用不了这个文件：${cause?.message ?? String(cause)}`;
      customSound.emit();
    }
    return;
  }
  // 解码成功先让 UI 从「正在读取…」跳到「已选 xxx」；落库结果（persisted）再单独同步。
  customSound.emit();

  try {
    await withCustomStore("readwrite", (store) => store.put(
      { name: file.name, type: file.type, bytes: data.byteLength, data },
      CUSTOM_KEY,
    ));
  } catch {
    customSound.persisted = false;
  }
  customSound.emit();
}

/** 移除自定义音（内存 + 库一起清）。 */
export async function clearCustomSound() {
  customSound.buffer = undefined;
  customSound.name = "";
  customSound.bytes = 0;
  customSound.error = "";
  customSound.status = "idle";
  customSound.persisted = true;
  customSound.emit();
  try {
    await withCustomStore("readwrite", (store) => store.delete(CUSTOM_KEY));
  } catch {
    /* 删不掉也不影响本次会话：内存里已经清干净了 */
  }
}

/**
 * 播自定义音。每次都要新建 BufferSource（AudioBufferSourceNode 是一次性的，不能重播）。
 *
 * @param volumeId - 音量档 id。
 * @returns 是否真的排上了。
 */
function playCustomSound(volumeId) {
  const audio = ensureAudioContext();
  if (audio === null || customSound.buffer === undefined) return false;
  const volume = VOLUMES.find((item) => item.id === volumeId) ?? VOLUMES.find((item) => item.id === DEFAULT_VOLUME);
  const start = () => {
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    source.buffer = customSound.buffer;
    gain.gain.value = volume.gain * MASTER_GAIN;
    source.connect(gain);
    gain.connect(audio.destination);
    source.start(audio.currentTime + 0.02);
  };
  if (audio.state !== "running") {
    audio.resume().then(start, () => {});
    return true;
  }
  start();
  return true;
}

/**
 * 跨标签页去重：同一个页面开在两个标签页时，只让一个出声。
 * 读写 localStorage 都可能抛（隐私模式），所以两边都包起来。
 */
const playGuard = createPlayGuard({
  read: () => {
    try {
      return window.localStorage.getItem(SOUND_KEYS.lastPlayedAt);
    } catch {
      return null;
    }
  },
  write: (value) => {
    try {
      window.localStorage.setItem(SOUND_KEYS.lastPlayedAt, value);
    } catch {
      /* 去重失效而已，不影响出声 */
    }
  },
});

/**
 * 真正决定"这一声要不要出"的地方。
 *
 * 三个判断都放在**播放时刻**而不是边沿时刻：去抖窗口有 300ms，期间用户完全可能
 * 已经把开关关掉、或者切回来看见了 —— 那时就不该再出声。
 */
function playCompletionSound() {
  if (!enabledPref.read()) return;
  if (awayOnlyPref.read() && !pageIsAway()) return;
  if (!playGuard()) return;
  playTone(tonePref.read(), volumePref.read());
}

/**
 * 模块级检测器：**跨渲染**保存上一帧的 running 集合与待确认批次。
 *
 * 为什么不用 useRef：react 的 useRef 才是常规做法，但本仓库的假 React（client-smoke）
 * 里 useRef 每次渲染都返回新对象，边沿检测放到 ref 里就测不出来了。放模块级还顺带
 * 与 scheduleSwitch / 各偏好保持一致 —— 这个插件里"跨渲染的状态"一律是模块级 store。
 */
const detector = createDetector({ onComplete: () => playCompletionSound() });

/* -------------------------------------------------------------- 观察组件 */

/** selector hook 需要返回快照本身；用同一个函数免得每次渲染都换引用。 */
function selectSelf(snapshot) {
  return snapshot;
}

/** 宿主没注入对应 selector hook 时的占位：保持 hooks 顺序恒定，返回 undefined。 */
const absentSelector = () => undefined;

/**
 * 只读状态、不出声、不渲染界面的常驻观察者。
 *
 * @param props - 框架注入的会话 selector hook。
 * @returns 一个隐藏占位节点。
 */
function CompletionWatcher({ useSessionStatus, useSessions }) {
  const enabled = enabledPref.use();
  // 两个 hook 由槽位渲染器按 root hooks 注入，同一次挂载期间不会变。
  // 用 `?? absentSelector` 兜底而不是 `typeof … ? … : …`：这样调用位置**始终有一次调用**，
  // hooks 顺序恒定；宿主没注入（root hooks 改名/版本差异）时退化成"什么都检测不到"，
  // 总比让整个 shell.overlay 组件抛错强。
  const statuses = (useSessionStatus ?? absentSelector)(selectSelf);
  const sessions = (useSessions ?? absentSelector)(selectSelf);

  useEffect(() => {
    if (!enabled) {
      // 关掉时清干净：不清的话，重新打开那一刻会把关闭期间"停下的会话"补响一声。
      detector.reset();
      return;
    }
    detector.observe(collectRunningTopLevel(statuses, sessions?.byId));
  }, [enabled, statuses, sessions]);

  // 组件卸载时清掉还没到点的去抖定时器。独立 effect（空依赖）：不能放进上面那个 effect
  // 的 cleanup，否则每次依赖变化都 reset，把边沿检测的基线清掉，检测就失灵了。
  useEffect(() => () => { detector.reset(); }, []);

  return React.createElement("span", { style: { display: "none" }, "aria-hidden": true });
}

/* -------------------------------------------------------------- 设置面板 */

/** 一颗小按钮，观感对齐卡片里其它可点元素（ChoiceGroup 的那套）。 */
function PreviewButton({ onClick, children }) {
  // 走官方 Button（见 ui.jsx）：悬停/按下/聚焦的观感交给宿主那一套，别自己调色。
  return React.createElement(ActionButton, { onClick }, children);
}

/**
 * 卡片里的「完成提示音」那一组。
 *
 * 选音色 / 选音量**立即试听**（「自定义」档除外——没文件时试听只会响「叮咚」，反而误导）：
 * 这几个参数是"听着调"才调得准的，让人选完再去找别处的试听按钮属于为难人。
 * （试听不走 playGuard：那是显式点击，不是提醒，去重会把它吞掉。）
 */
export function SoundSettings() {
  const enabled = enabledPref.use();
  const tone = tonePref.use();
  const volume = volumePref.use();
  const awayOnly = awayOnlyPref.use();
  const [message, setMessage] = useState("");
  // 订阅自定义音的加载状态：选完文件后这一组要立刻从「选择音频文件」变成「已选 xxx.mp3」。
  useCustomSound();
  const fileInput = useRef(null);

  const custom = tone === CUSTOM_TONE_ID;

  const preview = () => {
    const willFallback = custom && customSound.buffer === undefined;
    // 自定义音没就绪时也照常 playTone：它会回退成「叮咚」——这样文案说「响的是叮咚」
    // 就真的是响了一声，而不是嘴上说说却没动静。
    if (playTone(tone, volume)) {
      setMessage(willFallback ? "自定义音还没就绪，先响一声「叮咚」代替" : "已试听");
      return;
    }
    setMessage(audioUnsupported ? "这个浏览器没有 Web Audio，播不了提示音" : "还没解锁音频：先点一下页面任意处");
  };

  /** 选内置音色立即试听；选「自定义」不试听——没文件时响「叮咚」反而误导，改成读库 + 提示。 */
  const selectTone = (id) => {
    tonePref.write(id);
    if (id === CUSTOM_TONE_ID) {
      if (customSound.buffer === undefined) void loadCustomSound();
      setMessage(customSound.buffer === undefined ? "还没选音频文件，先用「叮咚」顶上" : "");
      return;
    }
    if (!playTone(id, volumePref.read())) setMessage("还没解锁音频：先点一下页面任意处");
    else setMessage("");
  };

  const activeTone = TONES.find((item) => item.id === tone) ?? TONES[0];
  const toneHint = custom
    ? "用你自己选的音频文件；文件还没就绪时回退成「叮咚」。"
    : `${activeTone.hint}点一下即试听。`;

  // 外层容器与分组标题交给设置卡片（index.jsx 的 Card「完成提示音」），这里只出内容。
  return React.createElement(React.Fragment, null,
    React.createElement(Row, {
      title: "对话完成时播放提示音",
      hint: "会话跑完（包括出错的收尾）出一声，把人从别的窗口叫回来。子代理与 Agent Teams 队友的完成不算 —— 否则一个多代理任务会响个不停。",
      checked: enabled,
      onToggle: () => enabledPref.write(!enabled),
    }),
    React.createElement(ChoiceGroup, {
      label: "音色",
      hint: toneHint,
      options: TONE_CHOICES,
      value: tone,
      onSelect: selectTone,
    }),
    custom ? React.createElement("div", { style: S.row },
      React.createElement("div", null,
        React.createElement("div", { style: S.label }, "自定义音频文件"),
        React.createElement("div", { style: S.hint },
          customSound.status === "loading"
            ? "正在读取…"
            : customSound.name === ""
              ? `支持浏览器能解码的格式（mp3 / wav / m4a / ogg 等），单个文件不超过 ${formatBytes(CUSTOM_SOUND_MAX_BYTES)}。文件只存在本机浏览器里，不会上传；换浏览器或清站点数据后要重新选。`
              : `已选：${customSound.name}（${formatBytes(customSound.bytes)}）${customSound.persisted ? "" : " —— 没能存进浏览器，刷新后要重新选"}`),
        customSound.error === "" ? null : React.createElement("div", { style: S.error }, customSound.error),
      ),
      React.createElement("div", { style: { display: "flex", gap: "8px", flex: "0 0 auto" } },
        React.createElement(PreviewButton, {
          onClick: () => fileInput.current?.click(),
        }, customSound.buffer === undefined ? "选择音频文件" : "更换文件"),
        customSound.name === "" ? null : React.createElement(PreviewButton, {
          onClick: () => { void clearCustomSound(); setMessage("已移除自定义音"); },
        }, "移除"),
      ),
    ) : null,
    custom ? React.createElement("input", {
      ref: fileInput,
      type: "file",
      accept: "audio/*",
      style: { display: "none" },
      onChange: (event) => {
        const file = event?.target?.files?.[0];
        // 清空 value：同一个文件连选两次也要能触发 change。
        if (event?.target !== undefined) event.target.value = "";
        if (file === undefined) return;
        setMessage("");
        void importCustomSound(file);
      },
    }) : null,
    React.createElement(ChoiceGroup, {
      label: "音量",
      hint: "选完立刻试听，以实际听到的为准。",
      options: VOLUMES.map((item) => ({ id: item.id, label: item.label })),
      value: volume,
      onSelect: (id) => {
        volumePref.write(id);
        if (!playTone(tonePref.read(), id)) setMessage("还没解锁音频：先点一下页面任意处");
        else setMessage("");
      },
    }),
    React.createElement(Row, {
      title: "只在切走时响",
      hint: "打开后，只有当页面在后台（切了标签页）或窗口失去焦点时才出声；你正盯着这个会话看时保持安静。",
      checked: awayOnly,
      onToggle: () => awayOnlyPref.write(!awayOnly),
    }),
    React.createElement("div", { style: { ...S.row, justifyContent: "flex-start", gap: "10px" } },
      React.createElement(PreviewButton, { onClick: preview }, "试听"),
      message === "" ? null : React.createElement("span", { style: S.hint }, message),
    ),
  );
}

/* ------------------------------------------------------------------ 挂载 */

/**
 * 装提示音：解锁监听 + shell.overlay 观察组件。
 *
 * @param ctx - 客户端 cordis 上下文。
 */
export function installSound(ctx) {
  // 解锁必须在用户手势里做，所以要挂到 document 上。桩环境（冒烟里的假 document）
  // 没有 addEventListener，这里不假设它有。
  ctx.effect(() => {
    // 注意别写 `document?.addEventListener`：可选链防不住「变量本身没声明」，
    // Node 里跑渲染冒烟时那会直接抛 ReferenceError。
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return undefined;
    const unlock = () => unlockAudio();
    document.addEventListener("pointerdown", unlock, true);
    document.addEventListener("keydown", unlock, true);
    return () => {
      document.removeEventListener("pointerdown", unlock, true);
      document.removeEventListener("keydown", unlock, true);
    };
  }, "dsh-helper: 提示音音频解锁");

  // 跨标签页同步偏好：一侧改音量/音色/开关，另一侧靠 storage 事件失效缓存、跟着变。
  // 呼吸灯那边也是这么做的（sidebar-glow.jsx 的 installGlow）。
  ctx.effect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
    const onStorage = (event) => {
      if (event.key === enabledPref.key) enabledPref.invalidate();
      if (event.key === tonePref.key) tonePref.invalidate();
      if (event.key === volumePref.key) volumePref.invalidate();
      if (event.key === awayOnlyPref.key) awayOnlyPref.invalidate();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, "dsh-helper: 提示音偏好同步");

  // 选了自定义音的话，挂载时就把文件读出来解码好：播放路径必须**同步**可用
  // （去抖回调里没有 await 的机会），不能等第一次要响的时候才去读 IndexedDB。
  if (tonePref.read() === CUSTOM_TONE_ID) void loadCustomSound();

  ctx.slots.inject("shell.overlay", () => ctx.slots.register({
    name: "shell.overlay",
    id: NS,
  }, CompletionWatcher));
}
