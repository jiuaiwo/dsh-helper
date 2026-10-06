/**
 * dsh-helper 客户端：设置挂在 DSH 官方的「插件信息」页里，不再自建设置分区。
 *
 * 按官方要求，插件设置应落在插件自己的信息页：注册 `plugins.bundle.config`
 * 键控槽位（key 用包名 dsh-helper），卡片就渲染在「插件列表 → 本插件
 * 详情页」的描述与「包含的组件」之间——与 dsh-context 同一处。宿主正是靠这个
 * 槽位的 key 集合判断 bundle 有配置可展示（`configured`），key 写错就等于卡片
 * 不出现。
 *
 * 卡片按**用途**分六张（2026-09-28 重排，用户报「功能选项有点乱」）：文件投递 / 定时任务 /
 * 活动提示 / 完成提示音 / 界面外观 / 宿主操作。每张卡片只放同一用途的东西——此前「启用定时任务」
 * 被塞在「文件投递」标题下、活跃指示那一行干脆没有标题，正是用户看到的"乱"。
 *
 * 卡片里两类东西：
 *   1. host 侧配置的开关（投递 / 图片消息 / 定时任务总开关 / 重启按钮），与 host 的
 *      通信走同源 HTTP 路由 /api/dsh-helper/config，不引入 Typert remote——少一层，
 *      开关够用。
 *   2. 纯浏览器侧的那几组——「活动呼吸灯」（原本是独立的 dsh-sidebar-glow 插件，整体并入
 *      这里，见 sidebar-glow.jsx）、「对话完成提示音」（sound.jsx）、「界面外观」
 *      （appearance.jsx，盖掉 macOS 桌面端的原生窗口毛玻璃）与「活跃指示」
 *      （attention.jsx，会话标题栏那枚心电图，2026-09-28 从 T专家 迁来）。
 *      它们不依赖 host 配置。
 *
 * 设置页头部那颗「重启 DeepSeek Harness」按钮仍走 `settings.action`：它是宿主级
 * 动作，不属于本插件的设置，留在设置页头更好找。
 */
import React, { useCallback, useEffect, useState } from "react";
import { AppearanceSettings, installAppearance } from "./appearance.jsx";
import { PulseSettings, installAttention } from "./attention.jsx";
import { S, Card, Row, Divider, TextField, ActionButton } from "./ui.jsx";
import { SCHEDULE_CSS } from "./schedule-css.js";
import { t as scheduleText } from "./schedule-copy.js";
import { SCHEDULE_PANEL_KEY, ScheduleGlyph, SchedulePanel } from "./schedule.jsx";
import { TYPERT_REMOTE } from "./schedule-remote.js";
import { GlowSettings, installGlow } from "./sidebar-glow.jsx";
import { SoundSettings, installSound } from "./sound.jsx";

// `remote`：定时任务的面板通过 Typert remote 读写任务（wire 名 helperPatch）。
// 命名空间必须写进静态 inject，否则 ctx.get("remote.helperPatch") 拿到 undefined。
// `typert`：`ctx.remote.$mount(...)` 内部要拿 typert 注册表 —— 没声明它时 $mount 会抛
// `cannot get property "typert" without inject`，而那个异常只在浏览器的 console 里，
// 界面上只表现为「定时任务服务暂时不可用」。这是实测出来的（2026-09-25）。
export const inject = ["slots", "remote", "typert"];

/** 注入定时任务那份样式（一次，随插件卸载移除）。 */
function installScheduleStyles(ctx) {
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-helper";
    tag.textContent = SCHEDULE_CSS;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, "dsh-helper: schedule styles");
}

const CONFIG_PATH = "/api/dsh-helper/config";
const RESTART_STATUS_PATH = "/api/dsh-helper/restart/status";
const RESTART_PATH = "/api/dsh-helper/restart";
/** 本插件的包名：既是 HTTP 路由前缀的由来，也是插件信息页设置卡片的槽位 key。 */
const PLUGIN_ID = "dsh-helper";

/**
 * 「当前用哪个后端」的说明文案。
 *
 * 投递是**复用 IM 插件的内部实现**做的（本插件自己不含任何 IM 协议），所以用户换了 IM 插件、
 * 或两个都装/都没装时，这句话是他唯一能看出"文件会走哪条路"的地方。后端由 host 侧探测得出，
 * 客户端只显示、不设置。
 */
const BACKEND_HINT = {
  "im-connect": "文件投递当前走 @michengai/dsh-im-connect：复用它的微信通道实例（只发不收）。",
  "dsh-im": "文件投递当前走 @xmanrui/dsh-im：复用它的微信协议模块。",
  "": "没有检测到可用的 IM 插件：投递会失败。请先装 @michengai/dsh-im-connect 或 @xmanrui/dsh-im，并在它自己的设置里接入微信。",
};

/**
 * 定时任务总开关的客户端镜像（服务端 `config.json` 的 `scheduleEnabled`）。
 *
 * 为什么非要一个模块级状态：侧栏那行入口是**注册进宿主槽位**的（宿主画行、我们只交图标），
 * 不是我们自己渲染的组件——「关掉就不显示」只能靠**注销那条注册**，组件里 `return null`
 * 对宿主渲染的行不起作用。这本是 T专家 的行为（`scheduleEntryVisible` + `subscribeUiPrefs`），
 * 迁到本插件时只搬了注册、丢了注销，表现为「关了开关左侧入口还在」。
 *
 * 默认 `true`，与服务端 `ensureConfig` 的默认一致；**读不到时保持默认**——
 * 宁可多显示一个入口，也不要因为一次读失败把入口永久藏掉（那样用户只能进设置卡片找回来）。
 */
const scheduleSwitch = {
  value: true,
  listeners: new Set(),
  set(next) {
    const value = next !== false;
    if (value === this.value) return;
    this.value = value;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.warn("[dsh-helper] 定时任务入口同步失败：", error);
      }
    }
  },
  subscribe(listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  },
};

/** 把 reason 翻成给用户看的按钮 title。 */
function restartDisabledTitle(reason) {
  switch (reason) {
    case "disabled-in-config":
      return "重启功能已在「插件列表 → dsh-helper」的设置里关闭";
    case "debugger":
      return "宿主正被调试器附着，不能重启";
    case "supervisor":
      return "宿主由 systemd 等监督器管理，重启功能已禁用";
    case "untrusted":
      return "请求来源不是同源环回";
    default:
      return `重启不可用（${String(reason)}）`;
  }
}

async function readConfig() {
  const response = await fetch(CONFIG_PATH, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);
  return response.json();
}

async function writeConfig(patch) {
  const response = await fetch(CONFIG_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`保存失败（HTTP ${response.status}）`);
  return response.json();
}

// 卡片、开关与选项组的实现在 ui.jsx：六张卡片共用同一套观感（官方 primitives 的 Switch/Button）。

function SettingsPanel() {
  const [settings, setSettings] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    readConfig()
      .then((value) => {
        if (!alive) return;
        // 顺手把总开关同步给侧栏入口：apply 里那次读取可能失败或晚到，这里以卡片读到的为准。
        scheduleSwitch.set(value.scheduleEnabled !== false);
        setSettings({
          enabled: value.enabled !== false,
          imageAsPicture: value.imageAsPicture !== false,
          restartEnabled: value.restartEnabled !== false,
          scheduleEnabled: value.scheduleEnabled !== false,
          backend: typeof value.backend === "string" ? value.backend : "",
          // 口令只有"设没设"这一个比特会到前端：明文永不出 host（理由见 SendHardening）。
          sendTokenSet: value.sendTokenSet === true,
          sendAllowRoots: Array.isArray(value.sendAllowRoots) ? value.sendAllowRoots : [],
        });
      })
      .catch((cause) => { if (alive) setError(cause?.message ?? String(cause)); });
    return () => { alive = false; };
  }, []);

  // 以 host 返回的结果为准，而不是本地翻转——保存失败时界面不会说谎。
  const save = useCallback(async (patch) => {
    setPending(true);
    setError("");
    try {
      const saved = await writeConfig(patch);
      // 关掉总开关要**立即**摘掉侧栏入口，不用等刷新：save 是设置卡片唯一的写入口，
      // 这里同步后由 scheduleSwitch 的订阅者去注销/重挂那一行。
      scheduleSwitch.set(saved.scheduleEnabled !== false);
      setSettings((prev) => ({
        enabled: saved.enabled !== false,
        imageAsPicture: saved.imageAsPicture !== false,
        restartEnabled: saved.restartEnabled !== false,
        scheduleEnabled: saved.scheduleEnabled !== false,
        // POST 不回 backend：它是探测结果、不是可写字段，沿用上一次读到的值。
        backend: prev?.backend ?? "",
        // 以 host 回的结果为准：保存口令/白名单后界面立刻反映，不必重新 GET。
        sendTokenSet: saved.sendTokenSet === true,
        sendAllowRoots: Array.isArray(saved.sendAllowRoots) ? saved.sendAllowRoots : [],
      }));
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setPending(false);
    }
  }, []);

  return React.createElement(SettingsCards, { settings, pending, error, onSave: save });
}

/**
 * 六张卡片本体（host 配置的**读与写**都在 SettingsPanel 里，这里只拿结果渲染）。
 *
 * 单独导出有两个用处：
 *   1. `tools/preview-settings.mjs` 直接渲染它出静态 HTML —— 改版面时先看图，不必重启宿主；
 *   2. client-smoke 的结构断言盯的就是它的返回值（卡片顺序、谁归哪张卡）。
 *
 * `settings === null` = host 配置还没读回来：那张卡片只显示「正在读取…」、行不渲染
 * —— 拿默认值先画一排开关是在骗人（真值可能是关的）。
 */
/**
 * 「投递加固」两项：HTTP 口令 + 目录白名单。**都默认关**（2026-09-28 用户口径：
 * 「可选 token + 可选路径白名单，默认都关」）—— 不开就与加固前逐字节同行为，
 * 既有的 curl 用法一个字都不用改；在多用户机器或不信任同机其它进程时可以打开。
 *
 * 单独抽一个组件是因为它需要本地 state：输入框不能每敲一个字就 POST 一次，
 * 而 SettingsCards 本身是「settings 进、onSave 出」的无状态展示组件。
 *
 * 口令只显示"设没设"、不回明文（host 的 GET /config 也不返回它）：那条路由与
 * /send-file 同属"无 Origin 的本机请求也放行"，回明文等于任何同机进程都能读到口令，
 * 这道闸门就形同虚设了。所以改口令靠三段式：不传 = 不改、传空串 = 清除、传非空 = 设置。
 */
function SendHardening({ settings, pending, save }) {
  const [token, setToken] = useState("");
  const savedRoots = Array.isArray(settings.sendAllowRoots) ? settings.sendAllowRoots : [];
  const [roots, setRoots] = useState(savedRoots.join("\n"));
  const tokenSet = settings.sendTokenSet === true;
  const nextRoots = roots.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const rootsChanged = nextRoots.length !== savedRoots.length
    || nextRoots.some((root, index) => root !== savedRoots[index]);
  return React.createElement(React.Fragment, null,
    React.createElement(TextField, {
      title: "HTTP 投递口令（可选）",
      hint: tokenSet
        ? "已设置：POST /send-file 现在必须带口令（请求头 x-dsh-helper-token，或 body 的 token 字段），否则回 401。留空点保存不会改动它；要取消限制请用「清除口令」。"
        // 未设状态也要把请求头名字写出来：用户得**在设之前**就知道既有的 curl 脚本要怎么改，
        // 否则他设完才发现脚本全 401 了 —— 那时候排查成本比现在读一句话高得多。
        : "默认关闭。不设口令时，本机任何进程都能调 POST /send-file 把文件发到微信（跨站请求另由 Origin 校验拦下）。不信任同机其它进程时可以设一个 —— 设了之后每个请求都必须带口令（请求头 x-dsh-helper-token，或 body 的 token 字段），现有的 curl 脚本要同步加上，否则会收到 401。",
      value: token,
      type: "password",
      placeholder: tokenSet ? "已设置（留空 = 不修改）" : "留空 = 不启用口令",
      disabled: pending,
      onChange: setToken,
    },
      React.createElement(ActionButton, {
        disabled: pending || token.trim() === "",
        onClick: () => { save({ sendToken: token }); setToken(""); },
        title: "把输入框里的内容设为投递口令",
      }, "保存口令"),
      tokenSet === true ? React.createElement(ActionButton, {
        disabled: pending,
        onClick: () => save({ sendToken: "" }),
        title: "取消口令限制（回到「本机任意进程都能投递」）",
      }, "清除口令") : null,
    ),
    React.createElement(TextField, {
      title: "允许投递的目录（可选）",
      hint: "默认关闭：留空时任何本机路径都能投递（包括 ~/.ssh、浏览器配置这类敏感目录）。"
        + "填了之后，只有这些目录及其子目录里的文件能发出去，其余一律拒绝；"
        + "工具（send_file_to_im）与 HTTP 两条入口都受这个限制。每行一个目录，可用 ~ 表示家目录。",
      value: roots,
      multiline: true,
      rows: 3,
      placeholder: "每行一个目录，例如：\n~/Downloads\n~/Desktop/reports",
      disabled: pending,
      onChange: setRoots,
    },
      React.createElement(ActionButton, {
        disabled: pending || rootsChanged !== true,
        onClick: () => save({ sendAllowRoots: nextRoots }),
        title: rootsChanged === true ? "保存目录白名单" : "与已保存的内容一致，无需保存",
      }, "保存目录"),
      React.createElement("div", { style: S.hint },
        savedRoots.length === 0
          ? "当前不限制目录。"
          : `当前允许 ${savedRoots.length} 个目录：${savedRoots.join("、")}`),
    ),
  );
}

export function SettingsCards({ settings, pending, error, onSave }) {
  const save = onSave;
  // 六张卡片的骨架在下面**一次搭完**：host 配置读回来之前也照常渲染这六张，
  // 卡内换成一行「正在读取…」。此前 loading 分支只画了四张（文件投递 + 浏览器侧三张），
  // 打开插件页的瞬间卡片会从 4 张跳成 6 张，肉眼看得见 —— 2026-09-28 审计时改掉的。
  const reading = error !== "" ? React.createElement("span", { style: S.error }, error) : "正在读取…";
  const placeholder = () => React.createElement("div", { style: S.hint }, reading);
  const browserSide = [
    React.createElement(Card, { key: "activity", title: "活动提示", hint: "标题栏那枚心电图与侧栏文件夹图标：把「有会话在跑 / 有事等你」变成看得见的提示。" },
      React.createElement(PulseSettings),
      React.createElement(Divider),
      React.createElement(GlowSettings),
    ),
    React.createElement(Card, { key: "sound", title: "完成提示音", hint: "会话跑完出一声，把人从别的窗口叫回来。" },
      React.createElement(SoundSettings),
    ),
    React.createElement(Card, { key: "appearance", title: "界面外观" },
      React.createElement(AppearanceSettings),
    ),
  ];
  const fileCard = React.createElement(Card, {
    key: "file",
    title: "文件投递",
    hint: settings === null ? undefined : (BACKEND_HINT[settings.backend] ?? BACKEND_HINT[""]),
  },
    settings === null ? placeholder() : React.createElement(React.Fragment, null,
      React.createElement(Row, {
        title: "允许把文件投递到 IM",
        hint: "打开后，任意会话（包括从 DSH 对话框发起的会话）都能用 send_file_to_im 把文件发到微信。关闭后工具仍在，但会拒绝投递。",
        checked: settings.enabled,
        disabled: pending,
        onToggle: () => save({ enabled: !settings.enabled }),
      }),
      React.createElement(Divider),
      React.createElement(Row, {
        title: "图片以图片消息发送",
        hint: settings.backend === "im-connect"
          ? "im-connect 后端下图片/视频按文件名后缀分流（名不副实时会按内容自动纠正发送后缀），这个开关只对旧后端（dsh-im）生效。"
          : "打开后，jpg / png / gif / webp / bmp 会作为图片消息发送，微信里可直接预览；关闭后一律按文件发送。判定以文件内容（魔数）为准，扩展名只在魔数认不出时兜底。",
        checked: settings.imageAsPicture,
        disabled: pending,
        onToggle: () => save({ imageAsPicture: !settings.imageAsPicture }),
      }),
      React.createElement(Divider),
      // 两项加固都默认关，所以放在卡片末尾：它们是"想收紧的人才会碰"的东西，
      // 不该在打开设置页时抢在两个日常开关前面。
      React.createElement(SendHardening, { settings, pending, save }),
    ),
  );
  const scheduleCard = React.createElement(Card, {
    key: "schedule",
    title: "定时任务",
    hint: "到点自动开一个新会话执行提示词；入口在左侧栏「新会话」按钮下方那一组里。",
  },
    settings === null ? placeholder() : React.createElement(Row, {
      title: "启用定时任务",
      hint: "打开后，到点的任务会自动开新会话执行提示词。关闭后停止全部定时触发，并拒绝手动「立即执行」；已有任务与执行记录完整保留，重新打开后自动恢复。",
      checked: settings.scheduleEnabled,
      disabled: pending,
      onToggle: () => save({ scheduleEnabled: !settings.scheduleEnabled }),
    }),
  );
  // 「宿主操作」单开一张卡：它作用于宿主进程本身，塞进「文件投递」或「界面外观」都是错位
  // （用户 2026-09-28 正是拿「启用定时任务」被塞在文件投递标题下举例说乱）。
  const hostCard = React.createElement(Card, {
    key: "host",
    title: "宿主操作",
    hint: "作用于宿主进程本身，与上面那些界面偏好无关。",
  },
    settings === null ? placeholder() : React.createElement(Row, {
      title: "启用「重启 DeepSeek Harness」按钮",
      hint: "打开后，设置页头部会出现一颗「重启」按钮，点击会调用宿主的安全闸并真的拉一个新进程替换当前实例。关闭后按钮变灰，悬停会说明原因。",
      checked: settings.restartEnabled,
      disabled: pending,
      onToggle: () => save({ restartEnabled: !settings.restartEnabled }),
    }),
  );

  return React.createElement("div", { style: S.wrap },
    fileCard,
    scheduleCard,
    ...browserSide,
    hostCard,
    // 配置已读回来时的错误提示（读失败时那一行已经在卡里了，不重复）
    settings !== null && error !== "" ? React.createElement("div", { style: S.error }, error) : null,
  );
}

function RestartAction() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let alive = true;
    fetch(RESTART_STATUS_PATH, { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((value) => { if (alive) setStatus(value); })
      .catch((cause) => {
        if (!alive) return;
        setStatus({ allowed: false, reason: "fetch-failed", error: cause?.message ?? String(cause) });
      });
    return () => { alive = false; };
  }, []);

  const handleClick = useCallback(async () => {
    if (busy || (status && !status.allowed)) return;
    // 与现有 SettingsDocumentAction 视觉一致：native confirm，不引 dialog 依赖
    if (typeof window !== "undefined" && !window.confirm("确定重启 DeepSeek Harness 吗？所有会话会断开。")) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(RESTART_PATH, {
        method: "POST",
        headers: { accept: "application/json" },
      });
      if (response.status === 202) {
        setMessage("已请求重启，等待新进程接管…");
        // 本进程 500ms 后自杀；浏览器自然重连
        return;
      }
      const body = await response.json().catch(() => ({}));
      setMessage(`重启失败：${body.error ?? `HTTP ${response.status}`}`);
    } catch (cause) {
      setMessage(`重启失败：${cause?.message ?? String(cause)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, status]);

  const allowed = status?.allowed === true;
  const disabled = busy || (status !== null && !allowed);
  const title = !status
    ? "正在检测重启状态…"
    : allowed
      ? "重启 DeepSeek Harness"
      : restartDisabledTitle(status.reason);

  // 视觉对齐 host 的 SettingsDocumentAction（@deepseek-ai/dsh-client-ui-primitives Button
  // variant="outline" size="sm"）：28px 高 / 12px 字号 / 10px 横向 padding / 8px 圆角 /
  // 0.5px 边 / 透明底 / hover 取 token；不引外部依赖，避免带进 clsx / simple-icons 全家桶。
  //
  // 圆角取 --dsw-radius-sm：primitives 的 Button.module.css 里 `.sm` 就是这一档
  // （`:root{--dsw-radius-sm:8px}`，见 @deepseek-ai/dsh-client-ui-theme 的 base.css）。
  // 2026-09-25 前这里写死 14px（当成了胶囊），比「打开配置文件」那颗明显更圆，已改正。
  // box-sizing 也照官方显式写 border-box：button 的 UA 默认值本来就是它，但宿主没有
  // 全局 box-sizing reset，哪天补上一条 `*{box-sizing:content-box}` 或页面级覆盖，
  // 0.5px 边框就会额外撑出 1px，两颗粒按钮便不再等高 —— 写死等于不依赖那个默认值。
  const buttonStyle = {
    boxSizing: "border-box",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "4px",
    height: "28px",
    padding: "0 10px",
    borderRadius: "var(--dsw-radius-sm, 8px)",
    border: "0.5px solid var(--dsw-alias-border-l3, #d8dadc)",
    background: "transparent",
    color: "var(--dsw-alias-label-primary, #1d1d1f)",
    fontSize: "12px",
    lineHeight: "18px",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    transition: "background 0.12s ease",
  };

  return React.createElement("div", {
    style: { display: "inline-flex", alignItems: "center", gap: "8px" },
  },
    React.createElement("button", {
      type: "button",
      onClick: handleClick,
      disabled,
      title,
      "aria-label": title,
      style: buttonStyle,
      onMouseEnter: (event) => {
        if (!disabled) event.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06))";
      },
      onMouseLeave: (event) => {
        event.currentTarget.style.background = "transparent";
      },
    }, busy ? "正在重启…" : "重启"),
    message ? React.createElement("span", {
      style: {
        fontSize: "12px",
        lineHeight: "18px",
        opacity: 0.75,
        color: message.startsWith("重启失败") ? "#d64545" : "#22a06b",
      },
    }, message) : null,
  );
}

/**
 * 插件信息页上的那张设置卡片（槽位 `plugins.bundle.config`，key 是本 bundle 的包名）。
 *
 * 宿主在插件详情页里只要 `page` 视图；`summary` 按槽位契约给一句一行说明，
 * 万一别处问起也不会渲染出整张表单。卡片外壳（标题、返回、包含的组件）
 * 由页面自己画，所以这里只出设置行本身。
 */
function PluginConfigCard(props) {
  if (props?.view === "summary") {
    return React.createElement("span", null, "文件投递、定时任务开关、工作区活动呼吸灯、活跃指示、对话完成提示音与界面外观");
  }
  return React.createElement(SettingsPanel);
}

/**
 * 分阶段执行：任何一步失败都只记日志并降级，**不把异常抛给宿主**。
 *
 * 为什么必须这样：客户端插件 entry 一旦变成 FAILED，宿主的启动审计
 * （`web boot: N entry did not activate`，见 dsh 的 boot-client/assertEntriesActive）
 * 会让**整个 Web GUI** 停在 "Failed to load plugins" 页 —— mountClient 根本不执行。
 * 一个可选的呼吸灯、一声提示音、或某个槽位在某个宿主版本上不兼容，
 * 不该有"整个 GUI 打不开"这种后果。（T专家 那边踩过，这里照它的做法。）
 *
 * 与 T专家 那份的差别：这是**同步**版。本插件的 apply 必须保持同步（见 apply 里的说明：
 * 槽位注册排在异步之后会表现为"入口时有时无"），所以不能用 async stage。
 */
function stage(label, run) {
  try {
    return run();
  } catch (error) {
    console.error(`[dsh-helper] 阶段「${label}」失败，已降级（GUI 与其余功能不受影响）：`, error);
    return undefined;
  }
}

export function apply(ctx) {
  // 呼吸灯：注入样式 + 注册 shell.overlay 观察组件（设置界面由插件页的那张卡片渲染）。
  stage("呼吸灯", () => installGlow(ctx));

  // 完成提示音：同样是纯客户端的一块，只多一个 shell.overlay 观察组件
  // （读的是同一份会话状态快照，见 sound-core.js）。
  stage("完成提示音", () => installSound(ctx));

  // ---- 定时任务：样式 → remote → 侧栏入口 → 主区域面板 ----
  // ⚠️ apply **保持同步**：挂载 remote 是异步的（`$mount` 返回 Promise），但槽位注册不能
  // 排在它后面 —— 调用方（宿主与冒烟）都不保证 await apply，异步注册会表现为"入口时有时无"。
  // 所以顺序是：同步注册样式与槽位 → remote 就绪后广播一次，让已挂载的面板重画即可。
  stage("定时任务样式", () => installScheduleStyles(ctx));

  // 界面外观：只注入一份样式 + 给 <html> 打一个开关属性（macOS 桌面端用来盖住原生毛玻璃）。
  // 位置有意排在上面三份样式之后：client-smoke 按下标断言 style 标签（0 呼吸灯 / 1 定时任务），
  // 插到中间会让那些断言张冠李戴，而不是报错。
  stage("界面外观", () => installAppearance(ctx));

  // 活跃指示（会话标题栏那枚心电图）：注入样式 + 注册 header 槽，2026-09-28 从 T专家 迁来。
  // 样式仍排在最后（下标 3），理由同上。
  stage("活跃指示", () => installAttention(ctx));

  // 读一次总开关初值，决定侧栏入口挂不挂。**不 await**：apply 必须保持同步（见上），
  // 所以入口先按默认（显示）挂上，读到「关」时 sync 会自动把它摘掉。
  if (typeof fetch === "function") {
    fetch(CONFIG_PATH, { headers: { accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((value) => scheduleSwitch.set(value?.scheduleEnabled !== false))
      .catch((error) => {
        // 读不到就按「显示」处理：宁可多一个入口，也不要让用户找不到它。
        console.warn("[dsh-helper] 定时任务总开关读取失败，侧栏入口按显示处理：", error?.message ?? error);
      });
  }

  /** remote 的就绪状态 + 广播：面板挂载时取 current，就绪后收到通知重画。 */
  const remoteReady = { current: undefined, listeners: new Set() };
  stage("定时任务 remote 挂载", () => {
    const remoteMount = ctx?.remote?.$mount;
    if (typeof remoteMount !== "function") {
      console.warn("[dsh-helper] ctx.remote 不可用，定时任务面板拿不到数据（其余功能不受影响）。");
      return;
    }
    Promise.resolve(remoteMount.call(ctx.remote, TYPERT_REMOTE)).then((disposeRemote) => {
      ctx.effect(() => disposeRemote, "dsh-helper: schedule remote");
      remoteReady.current = ctx.get?.("remote.helperPatch");
      for (const listener of [...remoteReady.listeners]) listener();
    }).catch((error) => {
      console.error("[dsh-helper] 定时任务 remote 挂载失败，定时任务不可用：", error);
    });
  });

  /** 面板宿主：remote 是异步就绪的，这里每次渲染现取，并订阅一次"就绪"广播。 */
  function SchedulePanelHost(props) {
    const [, bump] = React.useReducer((count) => count + 1, 0);
    React.useEffect(() => {
      remoteReady.listeners.add(bump);
      return () => { remoteReady.listeners.delete(bump); };
    }, []);
    return React.createElement(SchedulePanel, {
      ...props,
      remote: remoteReady.current,
      ctx: props?.ctx ?? ctx,
    });
  }

  // 侧栏入口：「新会话」按钮正下方那一组（宿主画行、我们只交图标），id 必须等于下面 main 面板的 key。
  //
  // 总开关关掉时**整条注销**这一行 —— 它是宿主渲染的（宿主拿 options 画行、只把图标交给我们），
  // 所以组件里 `return null` 摘不掉它，必须动注册本身。T专家 原实现就是这么做的，迁过来时丢了。
  stage("侧栏定时任务入口", () => ctx.slots.inject("sidebar.panellist", () => {
    let disposeEntry;
    const sync = () => {
      const want = scheduleSwitch.value;
      // 幂等：状态没变就别重复 register（重复注册同 id 会被宿主的去重检查拒绝）。
      if (want === (disposeEntry !== undefined)) return;
      if (!want) {
        disposeEntry?.();
        disposeEntry = undefined;
        return;
      }
      try {
        disposeEntry = ctx.slots.register({
          name: "sidebar.panellist",
          id: SCHEDULE_PANEL_KEY,
          // order 取最小：侧栏那一组里排在最前，紧贴「新会话」。
          order: 1,
          label: () => scheduleText("sched.nav"),
        }, (props) => React.createElement(ScheduleGlyph, { size: props?.size ?? 16 }));
      } catch (error) {
        // 注册失败不静默：这一项本来就要么在、要么不在，半死不活的入口最难查。
        console.warn("[dsh-helper] 侧栏定时任务入口注册失败：", error);
        disposeEntry = undefined;
      }
    };
    const unsubscribe = scheduleSwitch.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
      disposeEntry?.();
      disposeEntry = undefined;
    };
  }));

  // 主区域面板：点侧栏那一行时宿主 selectPanel(key)，右侧换成这块页面；点会话则回到会话视图。
  stage("定时任务主面板", () => ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: SCHEDULE_PANEL_KEY,
  }, SchedulePanelHost)));

  // 设置卡片挂在官方「插件信息」页，而不是自建 settings.section 分区：
  // key 必须是本 bundle 的包名——宿主正是拿这个槽位的 key 集合判断
  // 某个 bundle 有没有配置可展示（详情页的 configured）。
  stage("插件设置卡片", () => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
    name: "plugins.bundle.config",
    key: PLUGIN_ID,
  }, (props) => React.createElement(PluginConfigCard, props))));

  // 重启按钮仍留在设置页头部：它是宿主级动作，不属于本插件的设置。
  stage("设置页重启按钮", () => ctx.slots.inject("settings.action", () => ctx.slots.register({
    name: "settings.action",
    id: "restart-host",
    order: 10,
    label: () => "重启 DeepSeek Harness",
  }, RestartAction)));
}
