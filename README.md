## 辅助补丁（dsh-helper）

[![npm](https://img.shields.io/npm/v/dsh-helper.svg)](https://www.npmjs.com/package/dsh-helper)
[![license](https://img.shields.io/npm/l/dsh-helper.svg)](./LICENSE)

给 DeepSeek Harness 补几件日常小事：**把文件发到微信**、**定时任务**、活动呼吸灯、活跃指示、完成提示音、一键重启。

### 安装

先装一个 IM 插件（二选一），并在它自己的设置里接好微信 —— 微信投递复用它的通道与账号，没有它投递用不了（其余能力不受影响）：

```bash
# 1. 装一个 IM 插件（二选一），并在它自己的设置里接好微信
dsh plugin --profile web add @michengai/dsh-im-connect   # 或 @xmanrui/dsh-im

# 2. 装本插件
dsh plugin --profile web add dsh-helper
```

**DSH Desktop**：在**插件市场**里依次搜上面两个包安装。

装完重启 DSH 生效。

### 把文件发到微信

在**任意会话**里说一句「把这个文件发我微信」，模型会调 `send_file_to_im`：

- 图片 / 视频 / 其他文件按类型自动选微信消息形式，不用你操心格式；
- 提不到上下文时会给出可操作的提示（按提示在微信给机器人发一条消息再试）。

### 定时任务

侧栏「定时任务」里是按 cron 跑的独立任务：**到点新开一个会话**执行提示词，不依赖发起它的那个对话 —— 关掉对话照跑。

- 面板里新建，或直接用自然语言描述（「每周一早上 9 点……」）；
- 支持一次性任务（指定日期，跑完自动停用）；
- 每次执行都留下记录与关联会话。

### 界面上的小东西

| 功能 | 做什么 |
| --- | --- |
| 活动呼吸灯 | 工作区有活动时图标发光，折叠时标记未读 |
| 活跃指示 | 会话标题栏一枚心电图，点开列出需要注意的会话 |
| 完成提示音 | 会话跑完响一声（可只在切走时响） |
| 界面外观 | 关掉 macOS 桌面端左侧栏的系统毛玻璃 |
| 一键重启 | 标题栏按钮，重启 DeepSeek Harness |

### 设置与卸载

所有开关都在**插件列表 → 辅助补丁**的信息页里。运行数据在 `~/.dsh/integrations/dsh-helper/`，卸载**不会**删它。

### 许可与反馈

MIT（见 `LICENSE`）。源码与问题反馈：<https://github.com/jiuaiwo/dsh-helper>
