/**
 * 定时任务面板的文案（中文）。
 *
 * 辅助补丁没有 i18n 框架，这里沿用它的风格：一张键值表 + 支持 {name} 占位符的 t()，
 * 组件里保持 t("sched.xxx") 的调用写法。要出英文时把 TABLE 换成"按 locale 选表"即可。
 *
 * 注意：部分键是**间接引用**的（例如星期几走 SCHEDULE_WEEKDAY_LABELS 常量表、
 * 模板名走 SCHEDULE_PRESET_LABELS），删键前别只 grep 字面量 `t("…")`。
 */
const TABLE = {
  "sched.nav": "定时任务",
  "sched.title": "定时任务",
  "sched.tip": "提示词会交给 agent 自动执行，请只写你信任的内容。",
  "sched.back": "返回会话",
  "sched.refresh": "刷新",
  "sched.loading": "正在加载定时任务…",
  "sched.error": "定时任务服务暂时不可用。",
  "sched.empty": "还没有定时任务。",
  "sched.retry": "重试",
  "sched.new": "新建定时任务",
  "sched.filterAll": "全部",
  "sched.filterEnabled": "已启用",
  "sched.filterDisabled": "已停用",
  "sched.searchPlaceholder": "搜索定时任务",
  "sched.searchClear": "清空搜索",
  "sched.noMatches": "没有匹配的定时任务。",
  "sched.edit": "编辑定时任务",
  "sched.save": "保存",
  "sched.saving": "保存中…",
  "sched.cancel": "取消",
  "sched.delete": "删除",
  "sched.deleteConfirm": "确定删除这个定时任务？",
  "sched.runNow": "立即执行",
  "sched.running": "执行中…",
  "sched.disable": "停用",
  "sched.enable": "启用",
  "sched.runHistory": "执行记录（{count}）",
  "sched.runRetention": "只保留最近 {count} 次执行记录",
  "sched.openSession": "关联会话",
  "sched.sessionArchived": "原会话已归档",
  "sched.sessionUnavailable": "会话已不可用",
  "sched.restoreAndOpen": "恢复并打开",
  "sched.restoring": "恢复中…",
  "sched.restoreFailed": "恢复失败，请稍后再试",
  "sched.promptMore": "展开",
  "sched.promptLess": "收起",
  "sched.runOk": "成功",
  "sched.runFail": "失败",
  "sched.lastRun": "上次执行",
  "sched.neverRun": "从未执行",
  "sched.failed": "失败",
  "sched.disabledTag": "已停用",
  "sched.workspace": "工作区",
  "sched.workspaceNone": "不绑定工作区",
  "sched.workspaceDefaultPending": "定时任务（执行时创建）",
  "sched.workspaceHint": "执行时在该工作区下新建会话。",
  "sched.workspacePath": "目录：{path}",
  "sched.workspaceCustom": "＋ 自定义目录…",
  "sched.workspaceCustomPlaceholder": "绝对路径或 ~/xxx，例如 ~/tasks",
  "sched.workspaceCustomHint": "目录不存在会自动创建；支持 ~ 表示家目录。",
  "sched.workspaceCustomEmpty": "请先填写自定义目录（绝对路径或 ~/xxx）。",
  "sched.workspaceAutoRecoverHint": "工作区不见了，{path} 下次执行时会自动建回来。",
  "sched.workspaceMissingHintNoPath": "工作区不见了，且任务里没记目录——下次执行自动恢复不了，请去左侧工作区列表新建一个同名/同路径的工作区。",
  "sched.cronLabel": "运行时间",
  "sched.cronHint": "分 时 日 月 周；首位可加秒（秒 ≠ 0 时写成六段），如 0 9 * * *。",
  "sched.cronRepeat": "重复",
  "sched.cronTime": "时间",
  "sched.cronWeekday": "星期",
  "sched.cronInterval": "间隔",
  "sched.cronExpression": "表达式",
  "sched.cronWorkday": "周一至周五",
  "sched.cronEveryHour": "每 N 小时",
  "sched.cronEveryMinute": "每 N 分钟",
  "sched.cronEverySecond": "每 N 秒",
  "sched.cronDaily": "每天",
  "sched.cronWeekly": "每周",
  "sched.cronCustom": "自定义",
  "sched.cronEvery": "每隔",
  "sched.cronMinutesUnit": "分钟",
  "sched.hourField": "小时",
  "sched.minuteField": "分钟",
  "sched.secondField": "秒",
  "sched.presetHourly": "每小时整点",
  "sched.presetMin30": "每 30 分钟",
  "sched.presetDaily9": "每天 9:00",
  "sched.presetWeekday830": "工作日 8:30",
  "sched.presetMon10": "每周一 10:00",
  "sched.wd1": "一",
  "sched.wd2": "二",
  "sched.wd3": "三",
  "sched.wd4": "四",
  "sched.wd5": "五",
  "sched.wd6": "六",
  "sched.wd0": "日",
  "sched.listSep": "、",
  "sched.sumMin": "每 {n} 分钟执行一次",
  "sched.sumEverySecond": "每 {n} 秒执行一次",
  "sched.sumEveryHour": "每 {n} 小时的第 {t} 执行",
  "sched.sumHour": "每小时第 {m} 分执行",
  "sched.sumHourAt": "每小时的第 {t} 执行",
  "sched.sumDaily": "每天 {t} 执行",
  "sched.sumWeekly": "每周{w} {t} 执行",
  "sched.sumWeeklyWorkday": "工作日 {t} 执行",
  "sched.sumCustom": "自定义表达式：{raw}",
  "sched.sumEmpty": "选择或填写执行时间",
  "sched.nextRuns": "最近 {n} 次执行",
  "sched.titleLabel": "标题",
  "sched.titlePlaceholder": "如：晨会纪要",
  "sched.promptLabel": "提示词",
  "sched.promptPlaceholder": "到点让 agent 做什么？",
  "sched.enabledLabel": "启用",
  "sched.enabledHint": "停用后保留数据，不再触发。",
  "sched.maxRunsLabel": "最多执行次数",
  "sched.maxRunsPlaceholder": "留空 = 不限次数",
  "sched.maxRunsHint": "填 1 就是一次性任务：跑完这一次会自动停用。想在「某年某月某日」只跑一次时用它——cron 语法没有年份位，那天只能写成「每年这天」，靠这个上限把它变成只跑一次。只有**成功**的运行才消耗次数：失败不计数（否则一次性任务失败一次就永久停用了，连重试机会都没有）；改为连续失败到上限时自动停用，避免坏任务无限重试。",
  "sched.limitTag": "限次",
  "sched.failStreakTag": "已连续失败 {n} 次",
  "sched.invalidForm": "标题、提示词和 cron 定时器都是必填项。",
  "sched.noAgents": "宿主没有可用的 agents 服务，创建会话会失败：请检查宿主装配。",
  "sched.armedOff": "定时任务已整体停用：到点不会自动执行，手动「立即执行」也会被拒绝。到「插件列表 → 辅助补丁」的设置卡片里重新打开。",
  // 迁移搁浅：旧数据文件（T专家 时代的 ~/.t-team/schedule.json）里还有任务、且目标文件已有内容
  // （= 没法安全覆盖），所以它们没被自动迁过来、也不会被执行。宿主日志里也写了一条，
  // 但桌面/Web 的日志用户根本看不见 —— 不说在这里，用户只会以为任务还在跑。
  "sched.stranded": "旧位置还有 {count} 条定时任务没有迁移过来，它们不会被执行（旧文件：{legacy}）。"
    + "目标文件里已有任务，迁移不会覆盖你的现有数据，所以这两条要由你手动合并。"
    + "恢复办法：在面板里照旧文件重建；或关掉定时任务总开关、把 {target} 移走后重启宿主，让它自动合并。",
  // 迁移合并：本插件先于迁移闸门启动过一次（留下空目标文件），这次重启检测到旧文件有任务且目标为空，
  // 已自动把旧文件内容合并到目标。让用户知道"原来那条不跑了"实际是被自动接管的，不是被吃掉了。
  "sched.merged": "已自动从旧文件合并 {count} 条定时任务过来（旧文件：{legacy} → {target}），"
    + "现在按正常的调度时间触发；旧文件保留作备份，想清掉可以手动删。",
};

/** 查文案并替换 `{name}` 占位符；查不到就原样返回键名（便于发现漏配）。 */
export function t(key, params) {
  const template = TABLE[key] ?? key;
  if (params === undefined || params === null) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name) => (params[name] === undefined ? match : String(params[name])));
}

export default t;
