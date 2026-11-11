/**
 * 浏览器侧偏好的极简外部 store（localStorage 存储 + 订阅）。
 *
 * 原本长在 sidebar-glow.jsx 里，是呼吸灯私有的。做「完成提示音」时提示音也要
 * 同一套东西（开关 / 音色 / 音量 / 切换时机都要读写 localStorage 并与设置面板共享
 * 状态），而复制一份实现迟早会漂移 —— 所以提到这里，两边共用。
 *
 * 为什么不用 host 侧配置：这些都是**纯浏览器侧**行为（要不要出声、出什么声），
 * 和宿主的进程状态无关。为它们开一条 HTTP 路由，既多一层往返，又会让"设置卡片
 * 读不到配置时这一组就哑掉"。放进 localStorage 后，host 侧读失败也不影响它。
 *
 * 读不到 localStorage 的场景（隐私模式、Node 里的渲染冒烟）不报错，退回默认值。
 */
import { useSyncExternalStore } from "react";

/**
 * 一颗存 localStorage 的偏好。
 *
 * @param key - localStorage 键。
 * @param normalize - 把读到的字符串收敛成合法值。
 * @param fallback - 没有存过时的默认值。
 */
export function createPreference(key, normalize, fallback) {
  let cached;
  const subscribers = new Set();
  const read = () => {
    if (cached !== undefined) return cached;
    let raw = null;
    try {
      // window 本身可能不存在（Node 里跑渲染冒烟时），所以整句都包在 try 里。
      raw = window.localStorage.getItem(key);
    } catch {
      /* 隐私模式等场景读不到，用默认值 */
    }
    cached = raw === null ? fallback : normalize(raw);
    return cached;
  };
  /**
   * 广播给所有订阅者，每个监听器单独兜错。
   *
   * 订阅者是各界面的 React 回调，其中一个抛错（组件已卸载、宿主某版本给的 props 形状变了）
   * 不该让**其余**订阅者收不到通知 —— 那会表现成"改了一个设置，只有部分界面跟着变"，
   * 而且界面上没有任何线索。吞掉的错要出声，否则就是静默失效换了个地方发生。
   *
   * 遍历副本：订阅者可能在回调里 unsubscribe，直接遍历正在被修改的 Set 会漏掉后面的项。
   */
  const notify = () => {
    for (const listener of [...subscribers]) {
      try {
        listener();
      } catch (error) {
        console.warn(`[dsh-helper] 偏好 ${key} 的一个订阅者抛错（其余订阅者照常通知）：`, error);
      }
    }
  };
  const write = (value) => {
    cached = normalize(String(value));
    try {
      window.localStorage.setItem(key, String(cached));
    } catch {
      /* 写不进去也不影响本次会话内的表现 */
    }
    notify();
  };
  /** 另一个标签页改了值：丢弃缓存并广播。 */
  const invalidate = () => {
    cached = undefined;
    notify();
  };
  const subscribe = (listener) => {
    subscribers.add(listener);
    return () => { subscribers.delete(listener); };
  };
  const use = () => useSyncExternalStore(subscribe, read, read);
  return { key, read, write, invalidate, subscribe, use };
}
