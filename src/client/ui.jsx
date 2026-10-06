/**
 * 「辅助补丁」插件设置卡片共用的小组件。
 *
 * 2026-09-28 重排（用户报「功能选项有点乱，想照着 可组合记忆 (dsh-mnemon) 那种风格分一下」）：
 *
 *   1. 分组从一个灰标题 + 一条细分割线，改成**一叠卡片** —— 每个用途一张（见 index.jsx 的
 *      SettingsPanel 与四个 SettingsXxx 组件）。截图里那两处错位也随之修掉：「启用定时任务」
 *      原本被塞在「文件投递」标题下面、「显示活跃指示」整行没有标题、悬在两组之间。
 *   2. 开关换成 DSH 官方 primitives 的 `Switch`，按钮换成官方 `Button` —— 与 mnemon 等官方插件
 *      同一套观感。此前那个绿色开关是本插件自绘的，与同页官方控件的圆角/色值都不一致。
 *   3. 互斥选项**没有**直接用官方 `SegmentedControl`：它是 `inline-grid` + `white-space: nowrap`
 *      且每段 `padding: 0 16px`，8 个音色横向必然溢出卡片、也不会换行。这里照它的观感自绘一组
 *      **可换行**的 chips：底槽 + 选中项白底浮起，颜色/圆角/高度全部取官方 token，观感一致，
 *      窄窗口下自动折行。
 *
 * 依赖 `@deepseek-ai/dsh-client-ui-primitives`（见 package.json 的 `dsh.client.inject` 与
 * tools/build-client.mjs 的 external）。**缺组件时逐个退回自绘实现**：客户端 entry 一旦抛错，
 * 宿主的启动审计会让整个 Web GUI 停在 "Failed to load plugins" 页，一张设置卡片不值得有这种后果。
 *
 * 字号一律显式 px：卡片落在插件详情页里，那里的正文是 13.5px，靠继承会拿到根字号的 16px，
 * 明显比同页其它文字大一圈（client-smoke 会逐条断言）。
 */
import React from "react";
import * as primitives from "@deepseek-ai/dsh-client-ui-primitives";

/* ------------------------------------------------------------ 样式 */

export const S = {
  // 宽度**交给宿主**：官方插件详情页给每个直接子元素的是 `.page>*{width:100%;max-width:960px}`
  // （见 dsh-client-ui-plugin-manager 的 PluginManagerPage 样式），卡片跟着它就与同页其它内容等宽。
  // 曾经在这里写死 maxWidth:620px，比官方容器窄 340px，整张设置卡片显得被勒在中间（2026-09-26 去掉）。
  wrap: { display: "flex", flexDirection: "column", gap: "12px", padding: "4px 0" },
  /** 一张卡片：一个用途一块，标题在卡内 —— 分组靠容器边界表达，不再靠一条几乎看不见的细线。 */
  // 边框取 1px 而不是 0.5px：浅色主题下 --dsw-alias-border-l3 是 #0000001f（12% 黑），
  // 0.5px 在白色页面上几乎看不出边界，而卡片分组全靠这条线（实测宿主的 bg-layer-* 在浅色下
  // 全是 #fff，底色指望不上）。（2026-09-28 用宿主真实 token 渲染预览后改的。）
  card: {
    display: "flex", flexDirection: "column", gap: "10px",
    padding: "12px 14px",
    border: "1px solid var(--dsw-alias-border-l3, #d8dadc)",
    borderRadius: "var(--dsw-radius-md, 12px)",
    background: "var(--dsw-alias-bg-layer-2, transparent)",
  },
  cardTitle: { fontSize: "13.5px", lineHeight: "20px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
  cardHint: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-caption)" },
  /** 同一张卡片内两个条目之间的细分隔。 */
  divider: { height: "0.5px", background: "var(--dsw-alias-border-l3, #d8dadc)", opacity: 0.6 },
  row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" },
  rowText: { minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" },
  label: { fontSize: "13.5px", lineHeight: "20px", fontWeight: 500, color: "var(--dsw-alias-label-primary)" },
  hint: { opacity: 0.72, fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
  error: { color: "var(--dsw-alias-state-error-primary, #d64545)", fontSize: "12px", lineHeight: "18px" },
  /** 一个文本输入条目：标题+说明在上、输入框占满整行（Row 是「左文字右开关」，输入框要宽度所以换行摆）。 */
  field: { display: "flex", flexDirection: "column", gap: "6px" },
  /** 输入框与它旁边那颗按钮（保存 / 清除）横排。 */
  fieldRow: { display: "flex", alignItems: "center", gap: "8px" },
  /** 多行输入时按钮排在下面（textarea 要占满宽度，横排会把它挤窄）。 */
  fieldColumn: { display: "flex", flexDirection: "column", alignItems: "stretch", gap: "8px" },
  /** 原生 textarea 对齐官方 input 的那一档观感（字号、圆角、边框 token 都取宿主的）。 */
  textarea: {
    fontFamily: "inherit", fontSize: "13px", lineHeight: "19px",
    padding: "6px 10px", resize: "vertical",
    color: "var(--dsw-alias-label-primary)",
    background: "var(--dsw-alias-bg-layer-1, transparent)",
    border: "1px solid var(--dsw-alias-border-l3, #d8dadc)",
    borderRadius: "var(--dsw-radius-sm, 8px)",
  },
  /** 一组互斥选项的底槽（观感对齐官方 SegmentedControl：底槽 + 选中项浮起）。 */
  track: {
    display: "flex", flexWrap: "wrap", gap: "2px", padding: "4px",
    borderRadius: "var(--dsw-radius-md, 8px)",
    background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.10))",
    alignSelf: "flex-start", maxWidth: "100%",
  },
  chip: {
    boxSizing: "border-box", height: "28px", padding: "0 12px", border: 0,
    borderRadius: "var(--dsw-radius-sm, 6px)", background: "transparent",
    color: "var(--dsw-alias-label-secondary)", fontFamily: "inherit",
    fontSize: "13px", lineHeight: "20px", fontWeight: 500, whiteSpace: "nowrap", cursor: "pointer",
  },
  chipOn: {
    background: "var(--dsw-alias-bg-layer-1, #fff)",
    color: "var(--dsw-alias-label-primary)",
    boxShadow: "var(--dsw-elevation-soft, 0 1px 2px rgba(0,0,0,0.10))",
  },
  /** 自绘开关的兜底样式（宿主没给出官方 Switch 时才用）。 */
  trackSwitch: {
    position: "relative", flex: "0 0 auto", width: "36px", height: "20px",
    borderRadius: "999px", border: "none", padding: "2px", cursor: "pointer",
  },
  knob: {
    position: "absolute", top: "2px", width: "16px", height: "16px",
    borderRadius: "50%", background: "#fff", transition: "left 0.15s ease",
  },
  /** 自绘按钮的兜底样式：圆角取 --dsw-radius-sm（primitives 的 Button.module.css 里 `.sm` 就是这一档）。 */
  button: {
    boxSizing: "border-box", display: "inline-flex", alignItems: "center", justifyContent: "center",
    gap: "4px", height: "28px", padding: "0 10px",
    borderRadius: "var(--dsw-radius-sm, 8px)",
    border: "0.5px solid var(--dsw-alias-border-l3, #d8dadc)",
    background: "transparent", color: "var(--dsw-alias-label-primary)",
    fontFamily: "inherit", fontSize: "12px", lineHeight: "18px", cursor: "pointer",
  },
};


/* ------------------------------------------------------------ 控件（官方优先，缺了退回自绘） */

/** 自绘开关：只在宿主没给出官方 Switch 时兜底。 */
function FallbackSwitch({ checked, disabled, label, title, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        ...S.trackSwitch,
        background: checked ? "#22a06b" : "var(--dsw-alias-border-l3, #9aa0a6)",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span style={{ ...S.knob, left: checked ? "16px" : "2px" }} />
    </button>
  );
}

/** 自绘按钮：只在宿主没给出官方 Button 时兜底。 */
function FallbackButton({ children, onClick, disabled, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{ ...S.button, opacity: disabled ? 0.4 : 1 }}
    >
      {children}
    </button>
  );
}

const Switch = typeof primitives.Switch === "function" ? primitives.Switch : FallbackSwitch;
const Button = typeof primitives.Button === "function" ? primitives.Button : FallbackButton;
const Input = typeof primitives.Input === "function" ? primitives.Input : null;

/* ------------------------------------------------------------ 组件 */

/**
 * 一张卡片：标题 + 可选说明 + 内容。
 *
 * 分组从「一条细线 + 灰标题」改成卡片，是因为那张长卡片上找不到边界
 * （用户 2026-09-28 报「有点乱」）：0.5px 的分隔线在浅色主题下几乎看不见。
 */
export function Card({ title, hint, children }) {
  return (
    <section style={S.card} aria-label={title}>
      <div style={S.rowText}>
        <div style={S.cardTitle}>{title}</div>
        {hint === undefined ? null : <div style={S.cardHint}>{hint}</div>}
      </div>
      {children}
    </section>
  );
}

/** 一行：左侧标题 + 说明，右侧开关（官方 Switch）。 */
export function Row({ title, hint, checked, disabled, onToggle }) {
  return (
    <div style={S.row}>
      <div style={S.rowText}>
        <div style={S.label}>{title}</div>
        {hint === undefined ? null : <div style={S.hint}>{hint}</div>}
      </div>
      <Switch
        checked={checked === true}
        disabled={disabled}
        label={title}
        title={title}
        onChange={(next) => onToggle(next)}
      />
    </div>
  );
}

/** 官方风格的次要按钮（试听、选择音频文件…）。 */
export function ActionButton({ children, onClick, disabled, title }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={disabled} title={title}>
      {children}
    </Button>
  );
}

/** 卡片内的细分隔线。 */
export function Divider() {
  return <div style={S.divider} aria-hidden="true" />;
}

/**
 * 一个文本输入条目：标题 + 说明在上，输入框占满整行，右侧可跟按钮（`children`）。
 *
 * 官方 primitives 有 `Input`（T专家 那份设置页也在用），取不到时退回原生 `<input>` ——
 * 与 Switch / Button 同一套兜底策略：客户端 entry 一抛错会让整个 GUI 停在
 * "Failed to load plugins"，一个输入框不值得赌上整张设置页。
 *
 * 0.9.2 曾把一个零引用的 `TextInput` 当死代码清掉；这个是**为投递加固新加的**，
 * 有真实调用点（设置页的口令与目录白名单），不是把那个复活。
 */
export function TextField({
  title, hint, value, placeholder, type, disabled, onChange, children, multiline, rows,
}) {
  const shared = {
    value: value === undefined || value === null ? "" : value,
    placeholder,
    disabled,
    "aria-label": title,
    title,
    onChange: (event) => onChange(event?.target?.value ?? ""),
  };
  // 多行走原生 <textarea>：官方 primitives 里没有多行输入件，而原生的键盘、
  // 换行与无障碍行为是白送的（与 T专家 那边保留原生 <select> 同一个理由）。
  const control = multiline === true
    ? <textarea {...shared} rows={rows === undefined ? 3 : rows} style={{ ...S.textarea, flex: "1 1 auto", minWidth: 0 }} />
    : (Input !== null
      ? <Input {...shared} type={type === undefined ? "text" : type} style={{ flex: "1 1 auto", minWidth: 0 }} />
      : <input {...shared} type={type === undefined ? "text" : type} style={{ flex: "1 1 auto", minWidth: 0 }} />);
  return (
    <div style={S.field}>
      <div style={S.rowText}>
        <div style={S.label}>{title}</div>
        {hint === undefined ? null : <div style={S.hint}>{hint}</div>}
      </div>
      <div style={multiline === true ? S.fieldColumn : S.fieldRow}>
        {control}
        {children}
      </div>
    </div>
  );
}

/**
 * 一组互斥选项（可换行）。
 *
 * 为什么不用官方 `SegmentedControl`：见文件头 —— 它不换行、每段内边距固定，8 个音色会溢出。
 * 这里保留同样的观感（底槽 + 选中项浮起），并允许折行。
 */
export function ChoiceGroup({ label, hint, options, value, onSelect, disabled }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div style={S.label}>{label}</div>
      <div style={S.track} role="radiogroup" aria-label={label}>
        {options.map((item) => {
          const on = item.id === value;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled === true || item.disabled === true}
              title={item.hint}
              onClick={() => { if (!on) onSelect(item.id); }}
              style={{ ...S.chip, ...(on ? S.chipOn : null) }}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {hint === undefined ? null : <div style={S.hint}>{hint}</div>}
    </div>
  );
}
