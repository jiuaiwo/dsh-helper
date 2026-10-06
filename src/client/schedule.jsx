/**
 * 定时任务面板与 cron 选择器
 *
 * 本文件由原单文件 `src/client.jsx`（5278 行）按职责拆分而来，**内容逐行保持不变**：
 * 拼接顺序仍是原文件的行序，跨文件引用由 esbuild 打包回同一个
 * `window.__ModuleLoader__.load({id, factory})` 产物（lib/client.js），
 * 因此对产物的断言与行为一律不变。新增代码请放进对应职责的文件。
 */
import React from "react";
import { CRON_PRESETS, INTERVAL_STEPS, WEEKDAY_KEYS, WORKDAYS, buildCron, parseCron } from "./schedule-cron.js";
import { openHostSession, restoreHostSession, sessionLinkState } from "./session-nav.js";
import { unwrap } from "./schedule-remote.js";
import { t } from "./schedule-copy.js";
/** 工作区下拉里自定义目录的哨兵值（不会与真实工作区 id 冲突：id 是 uuid）。 */
export const CUSTOM_WORKSPACE = "__custom__";
/**
 * 「默认『定时任务』工作区」的哨兵值 —— 用在它**还没被创建**的时候。
 *
 * 2026-09-28 用户口径：任务还没执行就不该先把工作区建出来（点开新建表单、填完又取消，
 * 都不该在磁盘上留个空目录、侧栏里多一个工作区）。所以默认工作区还不存在时，表单选这个
 * 哨兵而不是去 `ensureScheduleWorkspace("")` 建一个；保存时提交它解析出来的 **path**
 * 而不提交 workspaceId，任务第一次执行时由引擎按 path 建（tryAutoRecoverWorkspace）。
 * 默认工作区**已经存在**时不用它 —— 那时直接绑定真实 id，与以前完全一样。
 */
export const DEFAULT_WORKSPACE = "__default__";

/** main 槽里定时任务页的 key（侧栏按钮与 layout.selectPanel 都用它）。 */
export const SCHEDULE_PANEL_KEY = "helper-patch-schedule";

/**
 * cron 选择器的文案键表。
 *
 * 为什么写成**静态字面量映射**而不是 `t("sched.wd" + day)` 这类拼接：字典自检会逐个检查
 * 「每个词条在代码里有没有被引用」，拼接出来的键它看不见，于是要么漏检、要么反过来把
 * 真在用的词条判成"无人引用"。字面量列出来，两边就都对得上。
 */
export const SCHEDULE_PRESET_LABELS = {
  hourly: "sched.presetHourly",
  min30: "sched.presetMin30",
  daily9: "sched.presetDaily9",
  weekday830: "sched.presetWeekday830",
  mon10: "sched.presetMon10",
};
/** 周几 → 文案键（cron 口径：周一=1 … 周六=6，周日=0）。 */
export const SCHEDULE_WEEKDAY_LABELS = {
  1: "sched.wd1",
  2: "sched.wd2",
  3: "sched.wd3",
  4: "sched.wd4",
  5: "sched.wd5",
  6: "sched.wd6",
  0: "sched.wd0",
};

/** 面板里统一的错误取词。 */
export function errorText(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 运行时间卡片里的「取值面」：官方 ruleValue / ruleValueFace / pickerTrigger 的形态 ——
 * 一行右侧是「当前值 + 一个指示图标」的可点面，点开一个小面板列出全部选项，点一项即选。
 *
 * 为什么不用原生 `<select>`：原生下拉的弹层与箭头由浏览器画，深浅主题下都没法与官方一致；
 * 官方那页用的是 Button + MenuSurface。这里做一个同形态的轻量版。
 */
function RulePicker({ value, options, onPick, label, disabled = false }) {
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef(null);
  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => { if (wrapRef.current !== null && !wrapRef.current.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((option) => option.value === value);
  return (
    <div className="dsh-helper-sched-picker" ref={wrapRef}>
      <button
        type="button"
        className="dsh-helper-sched-ruleValue"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span className="dsh-helper-sched-ruleValueFace">
          {current === undefined ? "" : current.label}
          <ChevronGlyph />
        </span>
      </button>
      {open && (
        <ul className="dsh-helper-sched-pickerPanel dsh-helper-sched-pickerList" role="listbox" aria-label={label}>
          {options.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                data-on={option.value === value}
                onClick={() => { onPick(option.value); setOpen(false); }}
              >{option.label}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 「时间」行的时分秒选择：官方 ClockPicker 的形态 —— 行内是「HH:MM:SS + 时钟图标」的可点面，
 * 点开**三列滚动列表**（时 / 分 / 秒），点一项即选中并关面板。
 *
 * 秒是真参与调度的：秒 ≠ 0 时表达式写成六段（`秒 分 时 日 月 周`，croner 口径），
 * 秒 = 0 时仍是五段（老数据与一键模板的写法，见 src/schedule-cron.js）。
 */
function ClockPickerLite({ hour, minute, second, onPick, label, disabled = false }) {
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef(null);
  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => { if (wrapRef.current !== null && !wrapRef.current.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  // 打开时把三列的当前值滚到中间（官方 ClockPicker 也这么做）：否则 60 个选项每次都从 00 开始看。
  React.useEffect(() => {
    if (!open) return;
    for (const node of wrapRef.current?.querySelectorAll('[data-on="true"]') ?? []) {
      node.scrollIntoView({ block: "center" });
    }
  }, [open]);

  const pad = (n) => String(n).padStart(2, "0");
  const column = (count, current, pick) => (
    <ul className="dsh-helper-sched-pickerCol">
      {Array.from({ length: count }, (_, n) => n).map((n) => (
        <li key={n}>
          <button
            type="button"
            role="option"
            aria-selected={n === current}
            data-on={n === current}
            onClick={() => pick(n)}
          >{pad(n)}</button>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="dsh-helper-sched-picker" ref={wrapRef}>
      <button
        type="button"
        className="dsh-helper-sched-ruleValue"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span className="dsh-helper-sched-ruleValueFace">
          {`${pad(hour)}:${pad(minute)}:${pad(second)}`}
          <span className="dsh-helper-sched-pickerIcon"><ClockGlyph /></span>
        </span>
      </button>
      {open && (
        <div className="dsh-helper-sched-pickerPanel" role="listbox" aria-label={label}>
          {column(24, hour, (n) => onPick({ hour: n, minute, second }))}
          {column(60, minute, (n) => onPick({ hour, minute: n, second }))}
          {column(60, second, (n) => onPick({ hour, minute, second: n }))}
        </div>
      )}
    </div>
  );
}

/**
 * 执行记录里那一段提示词：两行截断（官方 savedPrompt 的样式），
 * **只有真被截断**时才给「展开 / 收起」—— 一条单行的提示词下面挂个点了没反应的按钮，
 * 反而让人以为界面坏了。判定方式：未展开时量一次 scrollHeight 与 clientHeight。
 */
function RunPrompt({ text, expanded, onToggle, more, less }) {
  const ref = React.useRef(null);
  const [clamped, setClamped] = React.useState(false);
  React.useEffect(() => {
    // 展开状态下不量（那时本来就没有截断），否则按钮会在展开后自己消失、没法收起。
    if (expanded) return;
    const node = ref.current;
    if (node === null) return;
    setClamped(node.scrollHeight > node.clientHeight + 1);
  }, [text, expanded]);
  return (
    <>
      <p className="dsh-helper-sched-deliveryPrompt" data-expanded={expanded} ref={ref}>{text}</p>
      {(expanded || clamped) && (
        <button
          type="button"
          className="dsh-helper-sched-promptToggle"
          aria-expanded={expanded}
          onClick={onToggle}
        >{expanded ? less : more}</button>
      )}
    </>
  );
}

/**
 * 定时任务的 cron 结构化选择器（受控：`value`/`onChange` 都是 cron 字符串）。
 *
 * 提供：一键模板、频率分段（每小时/每天/每周/自定义）、各模式的专用字段、
 * 可读的摘要，以及**最近 5 次触发时间**的实时预览。预览由宿主用 croner 计算
 * （客户端不打包 cron 解析器），所以表达式真不合法时这里也会如实报出来。
 */
export function CronPicker({ remote, value, onChange, disabled }) {
  const [model, setModel] = React.useState(() => parseCron(value));
  const [fires, setFires] = React.useState([]);
  const [hint, setHint] = React.useState("");
  React.useEffect(() => {
    const next = parseCron(value);
    // 审计修复（#13）：custom 模式下 parseCron 会 trim 掉首尾空格，受控 input 每敲一个
    // 空格就被回写回无空格版（"0 " → "0"，最终产出 "09***" 这种非法表达式）。custom 模式
    // 保留原 value 原文（含用户正在敲的空格），提交时由 buildCron/save 统一 trim。
    if (next.mode === "custom" && typeof value === "string") {
      setModel({ mode: "custom", raw: value });
      return;
    }
    setModel(next);
  }, [value]);

  // 预览最近几次触发：防抖 250ms，避免在自定义输入框里每敲一个字符就发一次请求。
  React.useEffect(() => {
    const cron = String(value ?? "").trim();
    if (cron === "") { setFires([]); setHint(""); return undefined; }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const payload = unwrap(await remote.previewSchedule(cron), "previewSchedule");
          if (cancelled) return;
          setFires(Array.isArray(payload?.fires) ? payload.fires : []);
          setHint("");
        } catch (cause) {
          if (cancelled) return;
          setFires([]);
          setHint(errorText(cause));
        }
      })();
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [value, remote]);

  // 新建表单挂载时 cron 是空的：先填一个合理默认值，表单立刻合法、选择器也不会空着。
  React.useEffect(() => {
    if (!value || String(value).trim() === "") onChange(buildCron(parseCron("")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = (next) => {
    setModel(next);
    const cron = buildCron(next);
    if (cron !== "") onChange(cron);
  };
  /**
   * 「重复」的当前取值 —— 与官方那一页同名的档位：
   * 每周 / 周一至周五 / 每天 / 每 N 小时 / 每 N 分钟 / 每 N 秒 / 自定义。
   * 「周一至周五」就是 weekly + 那五天，这一档只是为了少点两下，模型上不新增模式。
   */
  const isWorkday = (model.mode === "weekly"
    && (model.days ?? []).length === WORKDAYS.length
    && WORKDAYS.every((day) => (model.days ?? []).includes(day)));
  const repeat = model.mode === "custom" ? "custom"
    : model.mode === "daily" ? "daily"
      : model.mode === "weekly" ? (isWorkday ? "workday" : "weekly")
        : `every:${model.unit}`;
  /**
   * 切换「重复」档位。切到某个"间隔"档时保留已有的分/秒（用户多半刚设过），
   * 切到"时刻"档时保留已有的时/分/秒 —— 来回比较不会把填好的值弄丢。
   *
   * 「每周」的默认天数要小心：不能沿用 `model.days ?? WORKDAYS` —— 从「周一至周五」切到
   * 「每周」时那五天会让档位又算回 workday，看起来像"点了没反应"。规则：
   * 当前是工作日集合（或根本没有 days）就收窄成周一；已经是别的组合（如周一 + 周三）则原样保留。
   */
  const setRepeat = (next) => {
    if (next === repeat) return;
    const hour = model.hour ?? 9;
    const minute = model.minute ?? 0;
    const sec = model.second ?? 0;
    const keepDays = model.days && model.days.length > 0 && !isWorkday ? model.days : [1];
    if (next === "daily") emit({ mode: "daily", hour, minute, second: sec });
    else if (next === "weekly") emit({ mode: "weekly", hour, minute, second: sec, days: keepDays });
    else if (next === "workday") emit({ mode: "weekly", hour, minute, second: sec, days: [...WORKDAYS] });
    else if (next === "every:hour") emit({ mode: "every", unit: "hour", n: 1, minute, second: sec });
    else if (next === "every:minute") emit({ mode: "every", unit: "minute", n: 1 });
    else if (next === "every:second") emit({ mode: "every", unit: "second", n: 1 });
    else { const raw = buildCron(model) || "0 9 * * *"; setModel({ mode: "custom", raw }); onChange(raw); }
  };
  const toggleDay = (day) => {
    const current = model.days || [];
    const next = current.includes(day)
      ? current.filter((item) => item !== day)
      : WEEKDAY_KEYS.filter((item) => current.includes(item) || item === day);
    if (next.length === 0) return; // 至少留一天
    emit({ ...model, days: next });
  };

  const pad2 = (n) => String(n).padStart(2, "0");
  const minutes = Array.from({ length: 60 }, (_, i) => i);
  const seconds = Array.from({ length: 60 }, (_, i) => i);
  const second = model.second ?? 0;
  const clock = `${pad2(model.hour ?? 9)}:${pad2(model.minute ?? 0)}`;
  // 秒为 0 时不写出来（「每天 09:00 执行」比「09:00:00」更像人话；六段表达式也只在秒非 0 时生成）。
  const time = second === 0 ? clock : `${clock}:${pad2(second)}`;
  let summary;
  if (model.mode === "every") {
    const n = model.n ?? 1;
    if (model.unit === "second") summary = t("sched.sumEverySecond", { n });
    else if (model.unit === "minute") summary = t("sched.sumMin", { n });
    else {
      // 小时档：n=1 就是"每小时"，n>1 是"每 N 小时"，两者都要说清落在哪一分（可能还带秒）。
      const at = second === 0 ? pad2(model.minute ?? 0) : `${pad2(model.minute ?? 0)}:${pad2(second)}`;
      summary = n === 1
        ? t(second === 0 ? "sched.sumHour" : "sched.sumHourAt", second === 0 ? { m: at } : { t: at })
        : t("sched.sumEveryHour", { n, t: at });
    }
  } else if (model.mode === "daily") {
    summary = t("sched.sumDaily", { t: time });
  } else if (model.mode === "weekly") {
    const days = model.days || [];
    const isWorkday = days.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day));
    const week = isWorkday ? "" : days.map((day) => t(SCHEDULE_WEEKDAY_LABELS[day])).join(t("sched.listSep"));
    summary = t(isWorkday ? "sched.sumWeeklyWorkday" : "sched.sumWeekly", { w: week, t: time });
  } else {
    summary = model.raw ? t("sched.sumCustom", { raw: model.raw }) : t("sched.sumEmpty");
  }

  return (
    <div className="dsh-helper-sched-cron">
      {/* 运行时间卡片：与官方详情页的「运行时间」同构（.t-XoWW_ruleRows —— .5px 描边 + 16px 圆角，
          每行 min-height 48px、行间一条 .5px 分隔线；左边标签、右边取值）。
          右侧的取值一律是官方那种「值 + 指示图标」的可点面（RulePicker / ClockPickerLite），
          **不用原生 select** —— 原生下拉的箭头与弹层由浏览器画，跟官方对不上。 */}
      <div className="dsh-helper-sched-ruleRows">
        <div className="dsh-helper-sched-ruleRow">
          <span className="dsh-helper-sched-ruleLabel">{t("sched.cronRepeat")}</span>
          {/* 档位与官方那一页同名同序：每周 / 周一至周五 / 每天 / 每 N 小时 / 每 N 分钟 / 每 N 秒 / 自定义。
             官方还有「仅一次」，cron 是周期语义、表达不了"跑一次就结束"，所以这里没有。 */}
          <RulePicker
            label={t("sched.cronRepeat")}
            value={repeat}
            disabled={disabled}
            options={[
              { value: "weekly", label: t("sched.cronWeekly") },
              { value: "workday", label: t("sched.cronWorkday") },
              { value: "daily", label: t("sched.cronDaily") },
              { value: "every:hour", label: t("sched.cronEveryHour") },
              { value: "every:minute", label: t("sched.cronEveryMinute") },
              { value: "every:second", label: t("sched.cronEverySecond") },
              { value: "custom", label: t("sched.cronCustom") },
            ]}
            onPick={setRepeat}
          />
        </div>

        {model.mode === "every" && (
          <div className="dsh-helper-sched-ruleRow">
            <span className="dsh-helper-sched-ruleLabel">{t("sched.cronInterval")}</span>
            <div className="dsh-helper-sched-ruleControl">
              <span className="dsh-helper-sched-ruleUnit">{t("sched.cronEvery")}</span>
              <RulePicker
                label={t("sched.cronInterval")}
                value={model.n ?? 1}
                disabled={disabled}
                options={INTERVAL_STEPS[model.unit].map((n) => ({
                  value: n,
                  label: `${n} ${t(model.unit === "second" ? "sched.secondField" : model.unit === "minute" ? "sched.cronMinutesUnit" : "sched.hourField")}`,
                }))}
                onPick={(n) => emit({ ...model, n })}
              />
            </div>
          </div>
        )}
        {/* 小时档才有时刻可言（"每 N 小时的第几分第几秒"）；秒/分钟档本身已经是间隔，没有刻度。 */}
        {model.mode === "every" && model.unit === "hour" && (
          <>
            <div className="dsh-helper-sched-ruleRow">
              <span className="dsh-helper-sched-ruleLabel">{t("sched.minuteField")}</span>
              <RulePicker
                label={t("sched.minuteField")}
                value={model.minute ?? 0}
                disabled={disabled}
                options={minutes.map((n) => ({ value: n, label: pad2(n) }))}
                onPick={(minute) => emit({ ...model, minute })}
              />
            </div>
            <div className="dsh-helper-sched-ruleRow">
              <span className="dsh-helper-sched-ruleLabel">{t("sched.secondField")}</span>
              <RulePicker
                label={t("sched.secondField")}
                value={second}
                disabled={disabled}
                options={seconds.map((n) => ({ value: n, label: pad2(n) }))}
                onPick={(next) => emit({ ...model, second: next })}
              />
            </div>
          </>
        )}

        {(model.mode === "daily" || model.mode === "weekly") && (
          <div className="dsh-helper-sched-ruleRow">
            <span className="dsh-helper-sched-ruleLabel">{t("sched.cronTime")}</span>
            <ClockPickerLite
              label={t("sched.cronTime")}
              hour={model.hour ?? 9}
              minute={model.minute ?? 0}
              second={second}
              disabled={disabled}
              onPick={({ hour, minute, second: next }) => emit({ ...model, hour, minute, second: next })}
            />
          </div>
        )}

        {model.mode === "weekly" && (
          <div className="dsh-helper-sched-ruleRow">
            <span className="dsh-helper-sched-ruleLabel">{t("sched.cronWeekday")}</span>
            <div className="dsh-helper-sched-days">
              {WEEKDAY_KEYS.map((day) => (
                <button
                  key={day}
                  type="button"
                  className="dsh-helper-sched-day"
                  data-on={(model.days || []).includes(day)}
                  aria-pressed={(model.days || []).includes(day)}
                  disabled={disabled}
                  onClick={() => toggleDay(day)}
                >{t(SCHEDULE_WEEKDAY_LABELS[day])}</button>
              ))}
            </div>
          </div>
        )}

        {model.mode === "custom" && (
          <div className="dsh-helper-sched-ruleRow">
            <span className="dsh-helper-sched-ruleLabel">{t("sched.cronExpression")}</span>
            <input
              className="dsh-helper-sched-ruleInput"
              aria-label={t("sched.cronExpression")}
              value={model.raw || ""}
              disabled={disabled}
              placeholder="0 9 * * *"
              spellCheck={false}
              onChange={(event) => { const raw = event.target.value; setModel({ mode: "custom", raw }); onChange(raw); }}
            />
          </div>
        )}
      </div>

      {/* 常用模板：官方那页没有这一排，但「每 30 分钟」「工作日 8:30」这类手选要绕好几步，
          所以留在卡片下方做成小胶囊（与列表页的过滤标签同款，注意类名是 preset —— chip 归提示词芯片）。 */}
      <div className="dsh-helper-sched-chips">
        {CRON_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="dsh-helper-sched-preset"
            disabled={disabled}
            onClick={() => onChange(preset.cron)}
          >{t(SCHEDULE_PRESET_LABELS[preset.id])}</button>
        ))}
      </div>

      <div className="dsh-helper-sched-sum">{hint === "" ? summary : hint}</div>
      {fires.length > 0 && (
        <div className="dsh-helper-sched-next">
          <span className="dsh-helper-sched-nextLabel">{t("sched.nextRuns", { n: fires.length })}</span>
          <ul className="dsh-helper-sched-nextList">
            {fires.map((iso, index) => (
              <li key={index}>{new Date(iso).toLocaleString(undefined, { weekday: "short", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** 空表单初值（新建）。 */
export function emptyScheduleForm() {
  // maxRuns 用字符串存：表单里空串 = 不限次数（对应宿主的 null），填 1 就是一次性任务。
  return { editingId: null, title: "", prompt: "", cron: "", enabled: true, maxRuns: "", workspaceId: "", customDir: "", workspacePath: "" };
}


/** 一条事项的「上次执行」摘要。 */
export function scheduleLastRun(t, item) {
  if (!item.lastRunAt) return t("sched.neverRun");
  const time = new Date(item.lastRunAt).toLocaleString();
  return item.lastRunError === undefined ? time : `${time}（${t("sched.failed")}: ${item.lastRunError}）`;
}

/**
 * 提示词输入框。
 *
 * 原先这里是一个带「@专家名 芯片高亮」的 contenteditable 富文本编辑器 —— 它要读 T专家
 * 的名册才能把 `@名字` 画成芯片，迁移过来时整块去掉了（辅助补丁不认识"专家"这个概念，
 * 这正是"零关联"的要求）。提示词仍然**原样提交**给定时任务开出的会话，手打 `@专家名`
 * 的效果与以前一模一样（召唤由那个会话的 system prompt 负责，与这里无关）。
 */
function PromptBox({ editorRef, value, disabled, placeholder, onChange }) {
  return (
    <textarea
      ref={editorRef}
      className="dsh-helper-sched-promptInput"
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}


export function SchedulePanel({ ctx: hostCtx, remote }) {
  const [snapshot, setSnapshot] = React.useState(null);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState(null);
  /**
   * 右栏当前是哪一页：`rule` = 新建/编辑表单，`runs` = 执行记录（官方那两个 tab：
   * 「规则」/「任务运行记录」，我们同理）。点列表行尾的「执行记录（N）」会直接切到 runs。
   */
  const [detailTab, setDetailTab] = React.useState("rule");
  /**
   * 执行记录里哪几条的提示词被展开了（key = 记录下标，从新到旧）。
   * 换任务时由 openEdit / openRuns 清空 —— 下标是"当前这条任务的第几条"，跨任务复用会串。
   */
  const [expandedRuns, setExpandedRuns] = React.useState({});
  /**
   * 「这个会话打不开」的提示：`{ index, state }`（state ∈ archived | unavailable | loading）。
   * 点「关联会话」时才发现会话被归档/删掉，就地把状态说清楚 —— 而不是让宿主把用户甩到新建会话页。
   */
  const [sessionNotice, setSessionNotice] = React.useState(null);
  /** 「恢复并打开」的 unarchive 请求在飞。 */
  const [restoring, setRestoring] = React.useState(false);
  const [confirmingId, setConfirmingId] = React.useState("");
  const [runningId, setRunningId] = React.useState(null);
  /** 提示词输入框的 ref（插入光标用）。 */
  const promptEditorRef = React.useRef(null);
  /**
   * 面板里确认过存在的工作区（默认「定时任务」工作区，以及填过路径的自定义目录）。
   * 宿主的快照要等下一次 getSchedule 才会带上它们，这里先本地记住，下拉就能立刻选中。
   */
  const [extraWorkspaces, setExtraWorkspaces] = React.useState([]);
  /**
   * 列表的过滤与搜索（纯前端，不碰数据）：官方「自动化任务」页的列表头就是「标签行 + 搜索框」。
   * 标签按启停分（全部 / 已启用 / 已停用），搜索只匹配标题、提示词与 cron —— 这三样是用户
   * 定位一条任务时想得起来的信息。
   */
  const [filter, setFilter] = React.useState("all");
  const [query, setQuery] = React.useState("");
  /** 右栏表单的滚动容器：切换编辑对象时把内容滚回顶部。 */
  const detailScrollRef = React.useRef(null);
  /**
   * 面板是否还挂着。
   *
   * 「立即执行」之后有一段最多 6 秒的轮询（等 host 把会话建出来，见 runItem）。用户在这
   * 6 秒里关掉面板是完全正常的操作，而没有这个标志的话轮询会照跑到底：每 600ms 一次
   * remote 往返、以及往一个已经卸载的组件里 setState。React 18 不再为此报警告，
   * 所以它是**静默**的 —— 只能靠这个 ref 主动停。
   *
   * effect 里显式置回 true：StrictMode 下会 mount → unmount → mount，
   * 只在 cleanup 里置 false 的话第二次挂载就永远停在 false。
   */
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const layout = () => hostCtx?.get?.("layout") ?? hostCtx?.layout;
  const backToConversation = () => layout()?.selectPanel?.(null);

  /**
   * 跳到某次执行开出来的会话（执行记录里会话 id 后面那个「关联会话」）。
   *
   * ⚠️ 顺序是先退面板再打开会话：我们这块是 main 槽的 keyed 面板，面板不退掉的话
   * `openSession` 把会话选中了、右边仍然显示着面板，看起来像"点了没反应"。
   * 会话怎么跳交给 session-nav.js 的 openHostSession（它按宿主版本依次试
   * uiWorkspace.openSession → sessions.open，逻辑只有一份）。
   *
   * ⚠️ 跳之前先判状态：**归档会话宿主是不让直接打开的**（`retain` 拿不到，最后落到新建会话页，
   * 用户实测报过）。所以归档/已删的会话不跳，而是就地给一行提示（归档那条还带「恢复并打开」），
   * 由用户决定要不要把归档恢复回活跃。
   */
  function openRunSession(run, index) {
    const state = sessionLinkState(hostCtx, run.sessionId);
    // 只有"确定打不开"的两种状态才拦下来：`loading`（会话目录还没就绪）照跳不误 ——
    // 拿它当"不可用"会平白挡用户一下，而且提示文案也会是错的。
    if (state === "archived" || state === "unavailable") {
      setSessionNotice({ index, state });
      return;
    }
    setSessionNotice(null);
    layout()?.selectPanel?.(null);
    openHostSession(hostCtx, run.sessionId);
  }

  /** 「恢复并打开」：把归档会话 unarchive 回活跃，再走正常的跳转。 */
  async function restoreRunSession(run) {
    if (restoring) return;
    setRestoring(true);
    try {
      const ok = await restoreHostSession(hostCtx, run.sessionId);
      if (!ok) {
        setError(t("sched.restoreFailed"));
        return;
      }
      setSessionNotice(null);
      layout()?.selectPanel?.(null);
      openHostSession(hostCtx, run.sessionId);
    } finally {
      setRestoring(false);
    }
  }

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      setSnapshot(unwrap(await remote.getSchedule(), "getSchedule"));
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [remote]);

  React.useEffect(() => { void load(); }, [load]);

  const applySnapshot = (next) => {
    setSnapshot(next);
    setError("");
    // 快照一刷新，执行记录的下标就可能整体位移（新记录插在最前）—— 那条"这个会话打不开"的
    // 提示是按下标挂的，不清掉就会飘到别的记录下面。用户再点一次「关联会话」就会重新出现。
    setSessionNotice(null);
  };

  /** 记住一个刚确认存在的工作区，返回它的 id（下拉立即能选中）。 */
  function rememberWorkspace(workspace) {
    if (workspace === undefined || workspace === null) return "";
    setExtraWorkspaces((current) => (current.some((item) => item.id === workspace.id) ? current : [...current, workspace]));
    return workspace.id;
  }

  /**
   * 新建：默认选「定时任务」工作区，但**只解析、不创建**。
   *
   * 已经存在就直接绑定它（与以前一样）；还不存在就选哨兵 DEFAULT_WORKSPACE ——
   * 保存时只提交将来的路径，工作区留到任务第一次执行时建。这样"点开新建表单看一眼"
   * 或"填完又取消"都不会在磁盘上留下空目录、也不会让侧栏多出一个工作区
   * （用户 2026-09-28 口径：任务还没执行就先建工作区是多余的）。
   * 工作区只是执行位置，取不到时照样允许建任务（仍可选自定义目录或留空）。
   */
  async function openNewForm() {
    setBusy(true);
    let workspaceId = "";
    // 默认工作区"还不存在"时也要把**将来会建在哪**显示出来（宿主解析出来的路径就是它）：
    // 不显示的话，用户只有在任务跑过一次、发现目录不对时才看得出问题
    // （2026-09-29 的「默认目录跑到 /usr/local/bin/tesk 去了」正是这么被埋了很久）。
    let workspacePath = "";
    try {
      const peeked = unwrap(await remote.resolveScheduleWorkspace(""), "resolveScheduleWorkspace")?.workspace;
      workspaceId = peeked?.id ? rememberWorkspace(peeked) : DEFAULT_WORKSPACE;
      workspacePath = typeof peeked?.path === "string" ? peeked.path : "";
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
    setForm({ ...emptyScheduleForm(), workspaceId, workspacePath });
    setDetailTab("rule");   // 新建永远落在「规则」页
  }

  /**
   * 打开右栏的编辑表单。行点击与行尾「编辑」按钮共用这一份数据搬运，
   * 免得两处各写一遍 setForm 的字段（漏一个字段就是"编辑时值莫名丢了"）。
   */
  function openEdit(item) {
    setForm({
      editingId: item.id,
      title: item.title,
      prompt: item.prompt,
      cron: item.cron,
      enabled: item.enabled === true,
      // 空 = 不限次数；有值就回填成字符串（表单里是文本框）。
      maxRuns: typeof item.maxRuns === "number" && item.maxRuns > 0 ? String(item.maxRuns) : "",
      workspaceId: item.workspaceId ?? "",
      customDir: "",
      // 编辑时把记录的目录带进来：跟 workspaceId 一对，没手动改过就不会丢。
      workspacePath: item.workspacePath ?? "",
    });
    setDetailTab("rule");
    // 换任务时把这几样跟"当前这条任务的第几条记录"绑定的状态清掉 —— 它们都是按下标存的，
    // 跨任务留着就会串到别的任务上（展开的提示词、以及"这个会话打不开"的提示）。
    setExpandedRuns({});
    setSessionNotice(null);
  }

  /**
   * 打开右栏的「执行记录」页（列表行尾那个按钮走这里）：复用 openEdit 把表单数据搬好
   * （tab 之间要能来回切），再切到记录页 —— **别再抄一遍字段搬运**，漏一个字段就是
   * "切到记录页再切回来，值莫名没了"。
   */
  function openRuns(item) {
    openEdit(item);
    setDetailTab("runs");
  }

  async function submitForm() {
    if (form === null || busy) return;
    setError("");
    if (form.title.trim() === "" || form.prompt.trim() === "" || form.cron.trim() === "") {
      // 审计修复（#15）：window.alert 在沙箱 iframe 里可能被拦，换成页面内错误提示。
      setError(t("sched.invalidForm"));
      return;
    }
    setBusy(true);
    try {
      // 工作区：**只解析、不创建**（用户口径：任务还没执行就不该先把工作区建出来）。
      // 三种情形——
      //   · 选了已有工作区 → 提交它的 id（workspacePath 从下拉数据取）；
      //   · 哨兵 DEFAULT_WORKSPACE → 默认工作区还不存在，只提交路径，执行时按它建；
      //   · 哨兵 CUSTOM_WORKSPACE → 自定义目录，同样只解析路径，不在这里 mkdir。
      // 解析返回的 id 若是非空，说明这期间它已经被建出来了（比如上一次执行建的），那就直接绑。
      let workspaceId = form.workspaceId;
      let workspacePath = selectedWorkspacePath;
      if (workspaceId === CUSTOM_WORKSPACE) {
        const dir = form.customDir.trim();
        if (dir === "") {
          setError(t("sched.workspaceCustomEmpty"));
          return;
        }
        const peeked = unwrap(await remote.resolveScheduleWorkspace(dir), "resolveScheduleWorkspace")?.workspace;
        workspaceId = peeked?.id ? rememberWorkspace(peeked) : "";
        workspacePath = peeked?.path ?? dir;
      } else if (workspaceId === DEFAULT_WORKSPACE) {
        const peeked = unwrap(await remote.resolveScheduleWorkspace(""), "resolveScheduleWorkspace")?.workspace;
        workspaceId = peeked?.id ? rememberWorkspace(peeked) : "";
        workspacePath = peeked?.path ?? "";
      }
      const payload = {
        title: form.title.trim(),
        prompt: form.prompt,
        cron: form.cron.trim(),
        enabled: form.enabled,
        // 次数上限：空串 = 不限次数（宿主把 0 / 空 / null 都当"不限"，并会把旧上限删掉）；
        // 填 1 就是一次性任务 —— 跑完一次自动停用，cron 那边即使写的是"每年这天"也只跑这一次。
        maxRuns: form.maxRuns === "" ? 0 : Math.max(0, Math.floor(Number(form.maxRuns) || 0)),
        // 空串 = 不绑定工作区（显式解绑也走这个值，宿主认得）。
        // ⚠️ "还没建出来的默认工作区"走的正是这条路：id 空 + path 有值 ——
        // 引擎据此在执行时按 path 建（schedule.js 的 wantsWorkspace 那段），语义不冲突。
        workspaceId: workspaceId === undefined || workspaceId === null ? "" : workspaceId,
        // 把当前绑定的目录也一起带上：将来工作区被删时，面板行内的「重建工作区」才能按这个路径
        // 把任务拉回来（老数据没有这个字段时由宿主用空串兜底）。
        workspacePath,
      };
      const next = form.editingId === null
        ? unwrap(await remote.createScheduleItem(payload), "createScheduleItem")
        : unwrap(await remote.updateScheduleItem(form.editingId, payload), "updateScheduleItem");
      applySnapshot(next);
      setForm(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(id) {
    // 审计修复（#15）：两步确认替代 window.confirm（沙箱 iframe 里可能被拦成静默无操作）。
    if (confirmingId !== id) { setConfirmingId(id); return; }
    setConfirmingId("");
    setBusy(true);
    try {
      applySnapshot(unwrap(await remote.deleteScheduleItem(id), "deleteScheduleItem"));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function runItem(id) {
    setRunningId(id);
    try {
      applySnapshot(unwrap(await remote.runScheduleItem(id), "runScheduleItem"));
      // runScheduleItem 返回的是"任务刚启动那一刻"的 snapshot（agent 会话异步建出来）。
      // 自动恢复 + agents.create 在 host 里还会再花几秒，期间面板可能看起来"卡住了"。
      // 这里主动再拉一次最新 snapshot 直到 host 报 running 为空，最多 6 秒：
      // 让用户点一次立即执行就能看到结果，不用手动刷新或再点。
      const startedAt = Date.now();
      while (Date.now() - startedAt < 6000) {
        await new Promise((r) => setTimeout(r, 600));
        // 面板已经被关掉了就立刻停：剩下的轮询只是在往一个卸载的组件里写状态。
        if (mountedRef.current !== true) return;
        try {
          const next = unwrap(await remote.getSchedule(), "getSchedule");
          if (next?.items?.find?.((it) => it.id === id) === undefined) break;
          applySnapshot(next);
          // running 为空 + 已有 lastRunAt 时，认为这一轮执行完了
          const live = next?.running ?? [];
          if (!live.includes(id)) break;
        } catch { /* 拉取失败不影响这一次的运行结果 */ }
      }
    } catch (cause) {
      if (mountedRef.current === true) setError(errorText(cause));
    } finally {
      // 卸载后一律不再写状态：React 18 不会警告，但那是"静默地做无用功"，不是"没问题"。
      if (mountedRef.current === true) setRunningId(null);
    }
  }

  /**
   * 单条停用/启用（行内按钮，删除前那颗）：宿主 update 是合并语义，patch 只带 enabled，
   * 定时器挂/摘由宿主 scheduleOne 顺手做——总开关关着时挂不上定时器，重新打开自动恢复，
   * 所以这里不需要任何 armed 判断。
   */
  async function toggleItem(item) {
    setBusy(true);
    try {
      applySnapshot(unwrap(await remote.updateScheduleItem(item.id, { enabled: item.enabled !== true }), "updateScheduleItem"));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const items = snapshot?.items ?? [];
  /**
   * 过滤 + 搜索后的列表（纯前端，不碰数据）：标签先按启停筛，搜索再按关键词筛。
   * 关键词只匹配标题 / 提示词 / cron —— 用户定位一条任务时想得起来的就是这三样。
   * 编辑/删除都按 item.id 走，所以列表被过滤掉几条不影响正在编辑的那一条。
   */
  const keyword = query.trim().toLowerCase();
  const visibleItems = items.filter((item) => {
    if (filter === "enabled" && item.enabled !== true) return false;
    if (filter === "disabled" && item.enabled === true) return false;
    if (keyword === "") return true;
    return `${item.title}\n${item.prompt ?? ""}\n${item.cron}`.toLowerCase().includes(keyword);
  });
  const workspaces = snapshot?.workspaces ?? [];
  /** 快照里的工作区 + 本次面板确认过的工作区（默认「定时任务」工作区/自定义目录），按 id 去重。 */
  const allWorkspaces = [...workspaces];
  for (const workspace of extraWorkspaces) {
    if (!allWorkspaces.some((item) => item.id === workspace.id)) allWorkspaces.push(workspace);
  }
  const workspaceTitle = (id) => allWorkspaces.find((workspace) => workspace.id === id)?.title ?? id;
  /**
   * 任务绑的工作区在当前 registry 里查不到：典型场景是工作区被误删 / 卸载 / 跨设备恢复后老 id
   * 失效。这是行内「重建工作区」按钮的判据 —— 没有这条提示，cron 一到就静默刷一行
   * `lastRunError`，用户得自己去 JSON 里翻才知道发生了什么。
   */
  const isWorkspaceMissing = (item) => {
    if (item.workspaceId === undefined || item.workspaceId === "") return false;
    return !allWorkspaces.some((workspace) => workspace.id === item.workspaceId);
  };
  const rowMeta = (item) => {
    const parts = [];
    if (item.workspaceId !== undefined) parts.push(`${t("sched.workspace")}: ${workspaceTitle(item.workspaceId)}`);
    if (item.enabled !== true) parts.push(t("sched.disabledTag"));
    // 连续失败次数：少了它，用户看到一个「已停用」却分不清是自己关的、还是失败止损关的
    // （引擎在连续失败到上限时会自动停用，见 lib/schedule.js 的 MAX_FAIL_STREAK）。
    if (item.failStreak > 0) parts.push(t("sched.failStreakTag", { n: item.failStreak }));
    // 限次任务（一次性就是 maxRuns=1）在列表里一眼能认出来，并显示已经跑了几次。
    // 计数口径：只有**成功**的运行消耗配额（失败不计数，见 withRun），所以这里显示的是成功次数。
    if (item.maxRuns > 0) parts.push(`${t("sched.limitTag")} ${item.runCount ?? 0}/${item.maxRuns}`);
    parts.push(`${t("sched.lastRun")}: ${scheduleLastRun(t, item)}`);
    return parts.join(" · ");
  };
  const disabled = busy || loading;
  /**
   * 提示词里点了名的专家（按出现顺序去重）。面板据此先说清「到点会召唤谁」——
   * 插进去的芯片必须在界面上能看到后果，否则用户不知道它会不会生效。
   */
  /**
   * 当前选中工作区的目录。默认「定时任务」工作区**还没建出来**时，目录取表单里存着的
   * `form.workspacePath`（由宿主的 resolveScheduleWorkspace 给）—— 于是「执行时创建」
   * 那一档也看得见落地位置，而不是留一片空白让用户猜。
   */
  const selectedWorkspacePath = form === null || form.workspaceId === ""
    ? ""
    : (allWorkspaces.find((workspace) => workspace.id === form.workspaceId)?.path ?? form.workspacePath ?? "");
  /**
   * 右栏「执行记录」页的数据 = 当前在编辑那条任务的记录，**新的在前**
   * （时间线从最新往下读；宿主存的是追加顺序，所以这里倒过来）。
   */
  const editingRuns = form === null || form.editingId === null
    ? []
    : [...(items.find((item) => item.id === form.editingId)?.runs ?? [])].reverse();

  /**
   * 右栏是详情/表单：换编辑对象（或从新建切到编辑）时把它的滚动位置收回顶部，
   * 否则会停在上一份内容的中间。依赖只用原始值，避免每次敲键盘都重滚一遍。
   */
  const formKey = form?.editingId ?? "new";
  React.useEffect(() => {
    if (form === null) return;
    detailScrollRef.current?.scrollTo?.({ top: 0 });
  }, [form === null, formKey]);

  return (
    <div className="dsh-helper-sched">
      {/* 左栏 = 列表（由全宽那一层滚动，滚动条因此贴窗口右边），右栏 = 新建/编辑详情。
          与官方「自动化任务」页同构：listPane + detail（detail 在窄屏下独占整页）。 */}
      <div className="dsh-helper-sched-listPane" data-detail={form !== null}>
      <div className="dsh-helper-sched-pageScroll">
      <div className="dsh-helper-sched-page">
        {/* 标题行：与官方「自动化任务」页同款 —— 标题在左，操作（刷新 / 返回会话 / ＋新建）在右。
            2026-09-25 起「新建」从列表下方搬到标题行右侧（官方就在那儿，也是这一页的主操作）；
            按钮文案没变（仍是「新建定时任务」），所以读屏与自检看到的名字还是原来那一个。 */}
        <header className="dsh-helper-sched-head">
          <h1 className="dsh-helper-sched-title">{t("sched.title")}</h1>
          <div className="dsh-helper-sched-headActions">
            <button type="button" className="dsh-helper-sched-btn" disabled={loading} onClick={() => void load()}>{t("sched.refresh")}</button>
            <button type="button" className="dsh-helper-sched-btn" onClick={backToConversation}>{t("sched.back")}</button>
            {form === null && (
              <button type="button" className="dsh-helper-sched-btn dsh-helper-sched-btn-primary" disabled={disabled} onClick={() => void openNewForm()}>
                <PlusGlyph />{t("sched.new")}
              </button>
            )}
          </div>
        </header>

        {snapshot !== null && snapshot.capabilities?.agents !== true && <p className="dsh-helper-sched-note">{t("sched.noAgents")}</p>}
        {/* 总开关（快照的 armed）：引擎停用时在页头说清楚，否则用户只会看到"立即执行"莫名失败。 */}
        {snapshot !== null && snapshot.armed === false && <p className="dsh-helper-sched-note">{t("sched.armedOff")}</p>}
        {/* 迁移诊断：旧文件里的任务如何处置要在这里说出来，宿主日志用户看不见。
            · stranded = 仍搁浅，需用户处理（沿用醒目样式 + 含恢复办法）；
            · merged = 已自动合并（用普通 note 即可，是好消息但用户应知情）。 */}
        {snapshot !== null && snapshot.migrationNotice !== undefined && (
          snapshot.migrationNotice.kind === "merged" ? (
            <p className="dsh-helper-sched-note" role="status">
              {t("sched.merged", snapshot.migrationNotice)}
            </p>
          ) : (
            <p className="dsh-helper-sched-note dsh-helper-sched-stranded" role="status">
              {t("sched.stranded", snapshot.migrationNotice)}
            </p>
          )
        )}
        {error !== "" && (
          <p className="dsh-helper-sched-error" role="alert">
            {t("sched.error")} {error}
            <button type="button" className="dsh-helper-sched-btn" onClick={() => void load()}>{t("sched.retry")}</button>
          </p>
        )}
        {loading && <p className="dsh-helper-sched-intro">{t("sched.loading")}</p>}

        <div className="dsh-helper-sched-body">
          {/* 过滤标签 + 搜索框：官方列表页最上面那两件（28px 胶囊标签 / 36px 圆角搜索框）。
              **空态也照摆**（2026-09-29 用户口径，附了官方空态页的截图）：此前是「有任务才出现」，
              理由是空页面上摆一排没法用的控件只是噪音 —— 但用户是拿这一页与官方「自动化任务」
              逐块比对的，官方无论有没有任务都摆着这两行。空态下筛选点了没有效果，仍然保留可点
              （不 disabled），与官方一致：一个灰掉的控件比一个点了没反应的更像坏了。
              三档：全部 / 已启用 / 已停用。⚠️ 2026-09-25 一度按"我们删除了就删除了、没有停用功能"
              的说法删掉过第三档，随后用户发现确实有停用功能（表单里的「启用」勾选、宿主会跳过
              停用的任务）要求恢复 —— 停用 ≠ 删除，这一档是有意义的筛选，别再删。 */}
          <div className="dsh-helper-sched-filters" role="tablist">
            {[["all", "sched.filterAll"], ["enabled", "sched.filterEnabled"], ["disabled", "sched.filterDisabled"]].map(([value, key]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={filter === value}
                data-on={filter === value}
                className="dsh-helper-sched-filterTab"
                onClick={() => setFilter(value)}
              >{t(key)}</button>
            ))}
          </div>
          <div className="dsh-helper-sched-search">
            <SearchGlyph />
            <input
              type="search"
              value={query}
              spellCheck={false}
              placeholder={t("sched.searchPlaceholder")}
              aria-label={t("sched.searchPlaceholder")}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query !== "" && (
              <button
                type="button"
                className="dsh-helper-sched-searchClear"
                aria-label={t("sched.searchClear")}
                title={t("sched.searchClear")}
                onClick={() => setQuery("")}
              >✕</button>
            )}
          </div>

          {!loading && items.length === 0 && error === "" && <p className="dsh-helper-sched-empty">{t("sched.empty")}</p>}
          {/* 「一条都没有」与「被过滤掉了」是两件事：后者要给一句说明，否则用户会以为任务丢了。 */}
          {!loading && items.length > 0 && visibleItems.length === 0 && <p className="dsh-helper-sched-empty">{t("sched.noMatches")}</p>}
          <ul className="dsh-helper-sched-list">
            {visibleItems.map((item) => (
              <li
                key={item.id}
                className="dsh-helper-sched-row"
                data-disabled={item.enabled !== true}
                // 整行可点 = 打开右栏编辑（官方那一页点整行开详情）。行尾按钮各自
                // stopPropagation，免得"点立即执行"顺带把编辑也打开。
                onClick={() => openEdit(item)}
              >
                <span className="dsh-helper-sched-rowGlyph" aria-hidden="true"><ClockGlyph /></span>
                <div className="dsh-helper-sched-rowMain">
                  <span className="dsh-helper-sched-rowTitle">
                    {/* 状态图标（时钟之后、标题之前）：启用 → 绿色播放，停用 → 淡红暂停。
                        一眼能看出这条会不会按计划触发，不用去读摘要。 */}
                    {item.enabled === true ? <PlayGlyph /> : <PauseGlyph />}
                    {item.title}
                  </span>
                  {/* 摘要压成一行：cron 表达式 + 工作区 / 停用标记 / 上次执行 —— 官方行也是
                      「一句摘要说清这条任务是什么」，两块信息合成一行比原来三行更紧凑。 */}
                  <span className="dsh-helper-sched-rowSummary">{item.cron} · {rowMeta(item)}</span>
                  {isWorkspaceMissing(item) && (
                    // 任务绑的工作区在 registry 查不到：执行路径会按 task.workspacePath 自动
                    // mkdir + create 兜底，面板这里只挂一行轻量提示——不要按钮、不要输入框，
                    // 不替用户做决定，恢复就是自动的。
                    <small className="dsh-helper-sched-rowNote">
                      {typeof item.workspacePath === "string" && item.workspacePath !== ""
                        ? t("sched.workspaceAutoRecoverHint", { path: item.workspacePath })
                        : t("sched.workspaceMissingHintNoPath")}
                    </small>
                  )}
                  {item.runs?.length > 0 && (
                    // 行内不再就地展开记录（那样挤在窄行里、还看不出时间线）：
                    // 点它打开右栏并切到「执行记录」那一页 —— 与官方「任务运行记录」同一处位置。
                    <button
                      type="button"
                      className="dsh-helper-sched-runsToggle"
                      onClick={(event) => { event.stopPropagation(); openRuns(item); }}
                    >{t("sched.runHistory", { count: item.runs?.length ?? 0 })}</button>
                  )}
                </div>
                {/* 行尾操作：整行点击已经能打开编辑，这里保留四个明确的按钮
                    （立即执行 / 编辑 / 停用·启用 / 两步确认删除），键鼠都能直达。
                    停用/启用放在删除前：轻操作在前、不可逆操作压轴。 */}
                <div className="dsh-helper-sched-rowActions">
                  <button
                    type="button"
                    className="dsh-helper-sched-btn"
                    disabled={disabled || runningId === item.id || (snapshot?.running ?? []).includes(item.id)}
                    onClick={(event) => { event.stopPropagation(); void runItem(item.id); }}
                  >{runningId === item.id || (snapshot?.running ?? []).includes(item.id) ? t("sched.running") : t("sched.runNow")}</button>
                  <button
                    type="button"
                    className="dsh-helper-sched-btn"
                    disabled={disabled}
                    onClick={(event) => { event.stopPropagation(); openEdit(item); }}
                  >{t("sched.edit")}</button>
                  <button
                    type="button"
                    className="dsh-helper-sched-btn"
                    disabled={disabled}
                    onClick={(event) => { event.stopPropagation(); void toggleItem(item); }}
                  >{item.enabled === true ? t("sched.disable") : t("sched.enable")}</button>
                  <button
                    type="button"
                    className="dsh-helper-sched-btn dsh-helper-sched-btn-danger"
                    disabled={disabled}
                    onClick={(event) => { event.stopPropagation(); void removeItem(item.id); }}
                  >{confirmingId === item.id ? t("sched.deleteConfirm") : t("sched.delete")}</button>
                </div>
              </li>
            ))}
          </ul>

        </div>
      </div>
      </div>
      </div>

      {/* 右栏详情：点「＋新建」或点列表里任意一行时出现（官方那一页就是左列表 + 右详情）。
          装的还是原来那份表单，只换了位置与版式：标题变成大号无框输入框、保存/取消固定在底部、
          右上角一个 ✕ 关闭。关掉它 = 回到纯列表页。 */}
      {form !== null && (
        <form
          className="dsh-helper-sched-detailForm"
          onSubmit={(event) => { event.preventDefault(); void submitForm(); }}
        >
          <div className="dsh-helper-sched-detailTabsBar">
            <div className="dsh-helper-sched-detailTabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === "rule"}
                data-on={detailTab === "rule"}
                className="dsh-helper-sched-detailTab"
                onClick={() => setDetailTab("rule")}
              >{form.editingId === null ? t("sched.new") : t("sched.edit")}</button>
              {/* 第二个 tab 只在**已有执行记录**时出现（官方也是「任务运行记录」按需出现）；
                  新建任务没有记录，就不摆一个永远空着的页。 */}
              {editingRuns.length > 0 && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailTab === "runs"}
                  data-on={detailTab === "runs"}
                  className="dsh-helper-sched-detailTab"
                  onClick={() => setDetailTab("runs")}
                >{t("sched.runHistory", { count: editingRuns.length })}</button>
              )}
            </div>
            <button
              type="button"
              className="dsh-helper-sched-detailClose"
              aria-label={t("sched.cancel")}
              title={t("sched.cancel")}
              onClick={() => setForm(null)}
            >✕</button>
          </div>

          {detailTab === "runs" ? (
            /* 执行记录页：官方「任务运行记录」那套时间线 —— 图标 + 时间（14/500）+ 结果，
               左侧一条 .5px 竖线把各条串起来（official .t-XoWW_delivery* 的度量照抄），
               末尾一行说明保留了几条。这一页没有表单，所以不挂底部的保存/取消。 */
            <div className="dsh-helper-sched-detailRecords">
              <div className="dsh-helper-sched-recordsScroll">
                {editingRuns.map((run, index) => (
                  <div key={index} className="dsh-helper-sched-delivery" data-fail={run.ok !== true}>
                    {/* 时间线左侧这枚是**中性**的（就是一个"这条记录"的锚点，官方那页同款）；
                        状态由时间后面那枚小图标表达 —— 两处都放状态图标就重复了。 */}
                    <span className="dsh-helper-sched-deliveryGlyph" aria-hidden="true"><ClockGlyph /></span>
                    <div className="dsh-helper-sched-deliveryBody">
                      <div className="dsh-helper-sched-deliveryHead">
                        <span className="dsh-helper-sched-deliveryTime">{new Date(run.at).toLocaleString()}</span>
                        {/* 状态跟在时间后面（2026-09-25 用户口径），带一枚对应的小图标：
                            成功 = 绿对勾、失败 = 红警告；失败原因另起一行，不把这一行撑长。 */}
                        <span className="dsh-helper-sched-deliveryStatus" data-fail={run.ok !== true}>
                          {run.ok === true ? <CheckGlyph /> : <WarnGlyph />}
                          {run.ok === true ? t("sched.runOk") : t("sched.runFail")}
                        </span>
                      </div>
                      {run.ok !== true && run.error !== undefined && run.error !== "" && (
                        <p className="dsh-helper-sched-deliveryError">{run.error}</p>
                      )}
                      {/* 那一次实际提交的提示词（官方那页也是「时间 + 提示词摘要」）：
                          两行截断、真被截断才给展开；老记录没有这个字段，就不渲染这一段。 */}
                      {typeof run.prompt === "string" && run.prompt !== "" && (
                        <RunPrompt
                          text={run.prompt}
                          expanded={expandedRuns[index] === true}
                          onToggle={() => setExpandedRuns((current) => ({ ...current, [index]: current[index] !== true }))}
                          more={t("sched.promptMore")}
                          less={t("sched.promptLess")}
                        />
                      )}
                      {run.sessionId !== undefined && (
                        <p className="dsh-helper-sched-deliverySession">
                          <span className="dsh-helper-sched-deliverySessionId">{run.sessionId}</span>
                          {/* 「关联会话 ›」：跳到那次执行开出来的会话（官方详情页右上角那一枚同款）。
                              归档/已删的会话宿主不让直接打开，这里会就地给提示而不是甩到新建页。 */}
                          <button
                            type="button"
                            className="dsh-helper-sched-linkSession"
                            onClick={() => openRunSession(run, index)}
                          >{t("sched.openSession")}<ChevronRightGlyph /></button>
                        </p>
                      )}
                      {sessionNotice !== null && sessionNotice.index === index && (
                        <p className="dsh-helper-sched-sessionNotice" data-state={sessionNotice.state}>
                          {sessionNotice.state === "archived" ? t("sched.sessionArchived") : t("sched.sessionUnavailable")}
                          {sessionNotice.state === "archived" && (
                            <button
                              type="button"
                              className="dsh-helper-sched-linkSession"
                              disabled={restoring}
                              onClick={() => void restoreRunSession(run)}
                            >{restoring ? t("sched.restoring") : t("sched.restoreAndOpen")}</button>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
                <p className="dsh-helper-sched-recordsEnd">{t("sched.runRetention", { count: 20 })}</p>
              </div>
            </div>
          ) : (
            <>
          <div className="dsh-helper-sched-detailScroll" ref={detailScrollRef}>
            <div className="dsh-helper-sched-detailBody">
              {/* 标题：官方详情页那个大号无框输入框（editName）。字段名不占版面，
                  走 aria-label —— 读屏照旧听得到「标题」。 */}
              <input
                className="dsh-helper-sched-editName"
                value={form.title}
                disabled={busy}
                aria-label={t("sched.titleLabel")}
                placeholder={t("sched.titlePlaceholder")}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
              />

              <div className="dsh-helper-sched-group">
                <h3 className="dsh-helper-sched-groupLabel">{t("sched.promptLabel")}</h3>
                {/* 提示词就是一个纯文本域：内容会原样提交给定时任务开出的会话。 */}
                <div className="dsh-helper-sched-promptbox">
                  <PromptBox
                    editorRef={promptEditorRef}
                    value={form.prompt}
                    disabled={busy}
                    placeholder={t("sched.promptPlaceholder")}
                    onChange={(prompt) => setForm((current) => (current === null ? current : { ...current, prompt }))}
                  />
                </div>
                {/* 安全提示：说的就是这段提示词会怎么被执行，跟着输入框走最容易看见。 */}
                <small className="dsh-helper-sched-hint">{t("sched.tip")}</small>
              </div>

              <div className="dsh-helper-sched-group">
                <h3 className="dsh-helper-sched-groupLabel">{t("sched.cronLabel")}</h3>
                <CronPicker remote={remote} value={form.cron} disabled={busy} onChange={(cron) => setForm((current) => (current === null ? current : { ...current, cron }))} />
                <small className="dsh-helper-sched-hint">{t("sched.cronHint")}</small>
              </div>

              <div className="dsh-helper-sched-group">
                <h3 className="dsh-helper-sched-groupLabel">{t("sched.workspace")}</h3>
                <select
                  value={form.workspaceId}
                  disabled={busy}
                  onChange={(event) => setForm({ ...form, workspaceId: event.target.value })}
                >
                  <option value="">{t("sched.workspaceNone")}</option>
                  {allWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.title}</option>)}
                  {/* 默认「定时任务」工作区还没被创建时才出现的这一行（见 DEFAULT_WORKSPACE）。 */}
                  {form.workspaceId === DEFAULT_WORKSPACE
                    && <option value={DEFAULT_WORKSPACE}>{t("sched.workspaceDefaultPending")}</option>}
                  {/* 老数据可能指向已被删掉的工作区：保留一行，别让下拉偷偷改成别的值。
                      两个哨兵值要排除掉，否则它们会被当成"未知工作区 id"再显示一行裸哨兵。 */}
                  {form.workspaceId !== "" && form.workspaceId !== CUSTOM_WORKSPACE
                    && form.workspaceId !== DEFAULT_WORKSPACE
                    && !allWorkspaces.some((workspace) => workspace.id === form.workspaceId)
                    && <option value={form.workspaceId}>{form.workspaceId}</option>}
                  <option value={CUSTOM_WORKSPACE}>{t("sched.workspaceCustom")}</option>
                </select>
                {form.workspaceId === CUSTOM_WORKSPACE ? (
                  <>
                    <input
                      value={form.customDir}
                      disabled={busy}
                      placeholder={t("sched.workspaceCustomPlaceholder")}
                      onChange={(event) => setForm({ ...form, customDir: event.target.value })}
                    />
                    <small className="dsh-helper-sched-hint">{t("sched.workspaceCustomHint")}</small>
                  </>
                ) : (
                  <>
                    <small className="dsh-helper-sched-hint">{t("sched.workspaceHint")}</small>
                    {selectedWorkspacePath !== "" && <small className="dsh-helper-sched-hint">{t("sched.workspacePath", { path: selectedWorkspacePath })}</small>}
                  </>
                )}
              </div>

              <div className="dsh-helper-sched-group">
                <h3 className="dsh-helper-sched-groupLabel">{t("sched.maxRunsLabel")}</h3>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={form.maxRuns}
                  disabled={busy}
                  placeholder={t("sched.maxRunsPlaceholder")}
                  onChange={(event) => setForm({ ...form, maxRuns: event.target.value })}
                />
                <small className="dsh-helper-sched-hint">{t("sched.maxRunsHint")}</small>
              </div>

              <label className="dsh-helper-sched-checkbox">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  disabled={busy}
                  onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
                />
                <span>{t("sched.enabledLabel")}</span>
                <small className="dsh-helper-sched-hint">{t("sched.enabledHint")}</small>
              </label>
            </div>
          </div>

          <div className="dsh-helper-sched-saveFooter">
            <button type="submit" className="dsh-helper-sched-btn dsh-helper-sched-btn-primary" disabled={busy}>{busy ? t("sched.saving") : t("sched.save")}</button>
            <button type="button" className="dsh-helper-sched-btn" disabled={busy} onClick={() => setForm(null)}>{t("sched.cancel")}</button>
          </div>
            </>
          )}
        </form>
      )}
    </div>
  );
}

/**
 * 侧栏「定时任务」入口的**图标**。
 *
 * 入口那一行（按钮、文字、点击、选中态）由宿主的 sidebar 自己渲染 —— `sidebar.panellist`
 * 是「全局面板图标」槽：宿主拿 options 里的 id/order/label 画行，点它 `selectPanel(id)`，
 * 而**组件只负责画图标**（渲染进那行的 glyph 里）。这样它天然就在「新会话」按钮下面、
 * 与侧栏其余入口同一套交互。那一行的外观**整段归宿主**：和官方「自动化任务」入口长得一样
 * （左对齐图文、悬停/当前项浅灰底、36px 最小高），插件不再给宿主那枚按钮写任何样式。
 *
 * 图标尺寸由宿主按展开/折叠给（16 / 18），这里跟随它，不写死。
 */
export function ScheduleGlyph({ size = 16 }) {
  return (
    <svg
      className="dsh-helper-schedule-glyph"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2.2" y="3.4" width="11.6" height="10.4" rx="2.4" />
      <path d="M2.2 6.6h11.6" />
      <path d="M5.6 2.2v2.4M10.4 2.2v2.4" />
      <path d="M6.1 9.7l1.3 1.3 2.5-2.7" />
    </svg>
  );
}

/**
 * 管理页列表行左侧的小时钟（纯装饰，语义由行文字与按钮承担，所以 aria-hidden）。
 *
 * 2026-09-25：这块页面按用户口径改成官方「自动化任务」页的观感，行图标也照抄那一行的时钟
 * （16×16、stroke 1、颜色由 .dsh-helper-sched-rowGlyph 的 tertiary 决定）。
 * 注意它跟侧栏入口的日历图标（ScheduleGlyph）**不是**同一枚：侧栏那枚是插件自己的标识。
 */
function ClockGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true" focusable="false">
      <path d="M8 14C11.3137 14 14 11.3137 14 8C14 4.68629 11.3137 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14Z" />
      <path d="M8 4.31V8.46L11 10.08" />
    </svg>
  );
}

/**
 * 行标题前的**状态图标**（2026-09-25 用户要求）：启用 → 播放，停用 → 暂停。
 *
 * 两枚都照抄宿主 primitives 的 IconPlayOutlineRegular / IconPauseOutlineRegular（圆环 + 图形），
 * 自己画一份免得为一个图标引新依赖；颜色由 CSS 按 data-state 给：暂停用**淡红**
 * （--dsw-alias-state-error-secondary，用户口径「淡红才明显」），启用用绿（state-success-primary）。
 *
 * 图标 aria-hidden —— 「停用」这件事的语义仍由行摘要里的「已停用」文字承担，读屏不因装饰图标丢状态。
 */
function PauseGlyph() {
  return (
    <svg
      className="dsh-helper-sched-state"
      data-state="off"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z" />
      <path d="M6.5 5V11" />
      <path d="M9.5 5V11" />
    </svg>
  );
}

/** 启用任务的播放图标（同一套画法，见上）。 */
function PlayGlyph() {
  return (
    <svg
      className="dsh-helper-sched-state"
      data-state="on"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z" />
      <path d="M10.3329 7.91346C10.3996 7.95195 10.3996 8.04818 10.3329 8.08667L6.78304 10.1362C6.71638 10.1747 6.63304 10.1266 6.63304 10.0496L6.63304 5.95055C6.63304 5.87357 6.71638 5.82546 6.78304 5.86395L10.3329 7.91346Z" />
    </svg>
  );
}

/** 「关联会话」按钮里的右箭头（照抄宿主 IconChevronRightOutlineRegular 的画法）。 */
function ChevronRightGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4" />
    </svg>
  );
}

/** 取值面右侧的折叠箭头（照抄宿主 IconChevronDownOutlineRegular 的画法）。 */
function ChevronGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6" />
    </svg>
  );
}

/** 搜索框里的放大镜（纯装饰）。 */
function SearchGlyph() {
  return (
    <svg className="dsh-helper-sched-searchGlyph" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="4.6" />
      <path d="M10.6 10.6 14 14" />
    </svg>
  );
}

/** 执行记录时间线里的「成功」图标（照抄宿主 IconCheckOutlineRegular 的画法）。 */
function CheckGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4" />
    </svg>
  );
}

/** 执行记录时间线里的「失败」图标（照抄宿主 IconWarningOutlineRegular 的画法：圆环 + 竖线 + 点）。 */
function WarnGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z" />
      <path d="M8 4.29199V9.79199" />
      <path d="M8 10.708V11.708" />
    </svg>
  );
}

/** 「＋ 新建」主按钮里的加号（纯装饰）。 */
function PlusGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </svg>
  );
}

