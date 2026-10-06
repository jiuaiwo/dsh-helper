/**
 * `@deepseek-ai/dsh-client-ui-primitives` 在**渲染冒烟**里的替身。
 *
 * 为什么不在测试里装真包：它带着自己的 CSS Modules 与 react 依赖，还要求宿主的客户端模块表
 * 才拿得到单例（产物里它是 `require(...)`，由宿主提供）。render-smoke 只想知道"这些组件
 * 能不能被真 React 渲染出来"，用一份最小的同签名替身就够，也免得把上游包的版本耦合进测试。
 *
 * ⚠️ 只覆盖本插件用到的那几个组件。新增用法（例如 SegmentedControl）时这里要同步补，
 * 否则 render-smoke 会因为 `undefined is not a component` 报错——那正是它该报的。
 *
 * 另一个替身在 tools/client-smoke.mjs 里（那边跑的是**假 React**，两份不能合并）。
 */
import React from "react";

/**
 * 官方 Switch 的替身：签名照官方（checked / onChange / label / disabled / title），
 * 尺寸与配色也照官方 Switch.module.css 画（36×20 胶囊、16px 圆点、开启态用 --dsw-alias-brand-primary），
 * 这样渲染冒烟之外，tools 里的静态预览（人眼看版面）也接近真机。
 */
export function Switch({ checked, onChange, label, disabled, title }) {
  return React.createElement("button", {
    type: "button",
    role: "switch",
    "aria-checked": checked,
    "aria-label": label,
    title,
    disabled,
    onClick: () => onChange(!checked),
    style: {
      boxSizing: "border-box", position: "relative", flex: "0 0 auto",
      width: 36, height: 20, padding: 2, border: 0, borderRadius: 999,
      background: checked ? "var(--dsw-alias-brand-primary, #0f1115)" : "var(--dsw-alias-border-l3, #d8dadc)",
      cursor: disabled === true ? "default" : "pointer",
      opacity: disabled === true ? 0.5 : 1,
    },
  }, React.createElement("span", {
    style: {
      display: "block", width: 16, height: 16, borderRadius: "50%",
      background: "var(--dsw-alias-label-primary-foreground, #fff)",
      transform: checked ? "translateX(16px)" : "none",
      transition: "transform 120ms ease",
    },
  }));
}

/**
 * 官方 Button 的子集：variant / size / icon 之外的属性原样透传。
 * 视觉照官方 Button.module.css 的 `outline` + `sm`（28px 高、8px 圆角、0.5px 描边、透明底）。
 */
export function Button({ children, onClick, disabled, title, variant, size, ...rest }) {
  return React.createElement("button", {
    type: "button",
    onClick,
    disabled,
    title,
    "data-variant": variant,
    "data-size": size,
    ...rest,
    style: {
      boxSizing: "border-box", display: "inline-flex", alignItems: "center", justifyContent: "center",
      gap: 4, height: 28, padding: "0 10px", borderRadius: "var(--dsw-radius-sm, 8px)",
      border: "0.5px solid var(--dsw-alias-border-l3, #d8dadc)", background: "transparent",
      color: "var(--dsw-alias-label-primary, #0f1115)", fontFamily: "inherit",
      fontSize: 12, lineHeight: "18px", cursor: disabled === true ? "not-allowed" : "pointer",
      opacity: disabled === true ? 0.4 : 1,
    },
  }, children);
}
