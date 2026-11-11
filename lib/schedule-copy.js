// @ts-check
/**
 * 定时任务的宿主侧文案。
 *
 * 辅助补丁其余界面文案也是直接写中文，这里就不引入 i18n 框架：一张键值表 + 支持
 * `{name}` 占位符的 t()，调用处保持 `t("schedule.xxx")` 的写法不变。
 * 以后要出英文，把 TABLE 换成"按 locale 选表"即可，调用点一行都不用动。
 */
const TABLE = {
  "schedule.cronEmpty": "cron 定时器不能为空",
  "schedule.invalidCron": "cron 表达式无法解析：{detail}",
  "schedule.inputInvalid": "定时任务的入参必须是一个对象",
  "schedule.titleEmpty": "定时任务的标题不能为空",
  "schedule.titleTooLong": "标题超过 {limit} 个字符",
  "schedule.promptEmpty": "定时任务的提示词不能为空",
  "schedule.promptTooLong": "提示词超过 {limit} 个字符",
  "schedule.maxRunsInvalid": "执行次数上限必须是不小于 1 的整数（留空表示不限次数）",
  "schedule.itemMissing": "找不到定时任务「{id}」（它可能已被删除）",
  "schedule.tooManyItems": "定时任务最多 {limit} 条：请先删掉一些再新建",
  "schedule.agentsMissing": "宿主没有可用的 agents 服务，无法为定时任务新建会话",
  "schedule.workspaceMissing": "定时任务绑定的工作区「{id}」不存在（可能已被删除）",
  "schedule.disabled": "定时任务功能当前已关闭：请在 设置 → 辅助补丁 里重新打开「定时任务」",
  "schedule.workspaceMissingWithPath": "定时任务绑定的工作区「{id}」不存在（记录的目录是 {path}）",
};

/** 查文案并替换 `{name}` 占位符；查不到就原样返回键名（便于发现漏配）。 */
export function t(key, params) {
  const template = TABLE[key] ?? key;
  if (params === undefined || params === null) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name) => (params[name] === undefined ? match : String(params[name])));
}

export default t;
