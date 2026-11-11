// @ts-check
/**
 * 配置文件（config.json）的原子写。
 *
 * 先写同目录的临时文件、**fsync 落盘**、再 rename（同目录 rename 是原子的）。
 *
 * fsync 不是多余的一步：没有它，rename 可能先于文件内容到达磁盘，机器断电（注意是断电，
 * 不是进程崩溃 —— 进程崩溃时内核缓存仍然会写完）就会留下一个"名字对了、内容是空"的
 * config.json，与「解析失败回默认值」叠加起来等于用户的设置无声丢失。
 *
 * 原先这个函数内联在 lib/schedule.js 里（与定时任务数据共用一套写盘）。定时任务功能
 * 移除后它只剩配置文件一个使用者，就搬到宿主侧工具目录，免得为一次写盘留一整份调度引擎。
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * @param {string} path - 目标文件（父目录不存在会自动建）。
 * @param {string} text - 完整文件内容。
 */
export async function writeFileAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  // 临时文件名必须**唯一到每一次调用**：只用 `pid-时间戳(毫秒)` 时，同一毫秒内的两次写入
  // 会拿到同一个名字 —— 两个 open(temp,'w') 互相覆盖（写出交错的坏 JSON），先完成的那次
  // rename 成功后，另一次 rename 直接 ENOENT（2026-11-11 并发 10 次写配置实测复现）。
  // 随机后缀把这个窗口关掉；串行化由调用方（saveConfig 的写队列）再加一道。
  const temp = `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } catch (error) {
    // 写失败（磁盘满、配额）：把半截临时文件清掉再抛，别在数据目录里留垃圾。
    await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
  // 落盘前收紧权限：配置文件里有可选的投递口令（sendToken）与机器人账号信息，
  // 默认 umask 会写成 0644 —— 同机其他用户就能读到口令，那道闸门等于白设。
  // chmod 失败不致命（某些文件系统不支持）：宁可权限没收紧，也不要让保存整个失败。
  await chmod(temp, 0o600).catch(() => {});
  try {
    await rename(temp, path);
  } catch (error) {
    // rename 失败（目标被占成目录、跨设备）：同样不留临时文件。
    await unlink(temp).catch(() => {});
    throw error;
  }
}
