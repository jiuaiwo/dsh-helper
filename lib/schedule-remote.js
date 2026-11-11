// @ts-check
/**
 * 辅助补丁的定时任务 remote 服务：把 host 侧的调度引擎通过 Typert Gateway 暴露给客户端面板。
 *
 * 服务名（wire namespace）= "helperPatch"，与其它插件的 wire namespace 不冲突；
 * 客户端用 ctx.remote.$mount(描述符) + ctx.get("remote.helperPatch") 取得代理。
 */
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { z } from "zod";
import { SCHEDULE_SERVICE } from "./schedule.js";

/**
 * 领域码形态：`<domain>/<reason>`（如 `helperPatch/schedule-invalid`）。
 *
 * 只有通过它校验的 `error.code` 才允许当 wire code 透传 —— 系统 errno（`EACCES`…）不是领域码，
 * 透传出去会让客户端按 code 分支时把「文件权限」误认成业务失败类型（D-17）。口径与宿主网关一致
 * （`<domain>/<reason>`，见 docs/cookbook/adding-a-remote-api.md）。
 */
const DOMAIN_CODE_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*\/[a-z0-9-]+$/u;
// A-2/A-3：线格式 schema 的**单一源**在 ./remote-schemas.js（客户端也从这里取），
// 不再在本文件重复定义一份。host 仍是权威（本文件是生产方与校验方）。
import {
  scheduleInputSchema,
  schedulePatchSchema,
  schedulePreviewSchema,
  scheduleWorkspaceSchema,
  scheduleSnapshotSchema,
} from "./schedule-schemas.js";


/** 一个 direct 调用描述符。 */
function descriptor(method, parameters, typeSymbol, schema) {
  return {
    id: `dsh-helper#helperPatch/${method}`,
    service: "helperPatch",
    namespace: "helperPatch",
    method,
    invocation: { kind: "direct" },
    parameters,
    result: { mode: "strict", typeSymbol, schema, create: () => schema },
  };
}

const DESCRIPTORS = [
  // 定时事项：全部写操作都回传刷新后的整份快照，面板拿到就能直接重绘（与名册同一口径）。
  descriptor("getSchedule", [], "HelperPatchSchedule", scheduleSnapshotSchema),
  descriptor("createScheduleItem", [
    {
      name: "input",
      wire: "input",
      source: "json",
      codec: { mode: "strict", typeSymbol: "HelperPatchScheduleInput", schema: scheduleInputSchema, create: () => scheduleInputSchema },
    },
  ], "HelperPatchSchedule", scheduleSnapshotSchema),
  descriptor("updateScheduleItem", [
    {
      name: "id",
      wire: "id",
      source: "json",
      codec: { mode: "strict", typeSymbol: "string", schema: z.string().min(1).max(128), create: () => z.string().min(1).max(128) },
    },
    {
      name: "patch",
      wire: "patch",
      source: "json",
      codec: { mode: "strict", typeSymbol: "HelperPatchSchedulePatch", schema: schedulePatchSchema, create: () => schedulePatchSchema },
    },
  ], "HelperPatchSchedule", scheduleSnapshotSchema),
  descriptor("deleteScheduleItem", [
    {
      name: "id",
      wire: "id",
      source: "json",
      codec: { mode: "strict", typeSymbol: "string", schema: z.string().min(1).max(128), create: () => z.string().min(1).max(128) },
    },
  ], "HelperPatchSchedule", scheduleSnapshotSchema),
  descriptor("runScheduleItem", [
    {
      name: "id",
      wire: "id",
      source: "json",
      codec: { mode: "strict", typeSymbol: "string", schema: z.string().min(1).max(128), create: () => z.string().min(1).max(128) },
    },
  ], "HelperPatchSchedule", scheduleSnapshotSchema),
  descriptor("previewSchedule", [
    {
      name: "cron",
      wire: "cron",
      source: "json",
      codec: { mode: "strict", typeSymbol: "string", schema: z.string().min(1).max(120), create: () => z.string().min(1).max(120) },
    },
  ], "HelperPatchSchedulePreview", schedulePreviewSchema),
  descriptor("ensureScheduleWorkspace", [
    {
      name: "path",
      wire: "path",
      source: "json",
      codec: { mode: "strict", typeSymbol: "string", schema: z.string().max(1024), create: () => z.string().max(1024) },
    },
  ], "HelperPatchScheduleWorkspace", scheduleWorkspaceSchema),
  // 只读：解析"将来会绑哪个工作区"，不建目录也不建条目。
  // 面板「新建任务」表单取默认值走它 —— 打开表单/填完又取消都不该留下工作区。
  // 返回的 workspace.id 可能是**空串**，表示"这个工作区还不存在，任务第一次执行时才建"
  // （线格式 schema 里 id 是必填 string，所以缺省用空串表达，而不是新开一种 schema）。
  descriptor("resolveScheduleWorkspace", [
    {
      name: "path",
      wire: "path",
      source: "json",
      codec: { mode: "strict", typeSymbol: "string", schema: z.string().max(1024), create: () => z.string().max(1024) },
    },
  ], "HelperPatchScheduleWorkspacePeek", scheduleWorkspaceSchema),

];

const TYPERT = {
  package: "dsh-helper",
  face: "host",
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: DESCRIPTORS,
};

/**
 * 手写 JS 里没有标准装饰器语法，这里用官方 `Remote(exportName)` 装饰器函数
 * 手工打标记：伪造一个符合 TC39 decorator context 的对象，并让 addInitializer
 * 以「原型指向宿主类原型」的假实例立即执行，从而把标记写到真正的 prototype 上。
 */
function exposeRemoteMethods(Class, methods) {
  for (const method of methods) {
    const context = {
      kind: "method",
      name: method,
      static: false,
      private: false,
      access: { has: (object) => method in object, get: (object) => object[method] },
      addInitializer: (initializer) => initializer.call(Object.create(Class.prototype)),
    };
// @ts-expect-error 上游类型缺口：ClassMethodDecoratorContext 的形状比这里手工构造的上下文更严。
// 运行时有效（dsh-typert-protocol 的 addMarkerInitializer 只读 kind/name/static/private），见 verify 的 remote 小节。
    Remote(method)(Class.prototype[method], context);
  }
}

class HelperPatchScheduleRemote extends TypertRemoteService {
  // 只声明真正用到的服务。原先这里还挂着一个 "settings"，但类里从头到尾没读过它 ——
  // 死依赖不是无害的：cordis 要等 inject 里**每一个**服务都就绪才实例化这个类，
  // 于是宿主的 settings 一旦晚到或出问题，定时任务面板就会跟着报「服务暂时不可用」，
  // 而排查的人会去查 typert 与调度引擎，怎么都想不到是一个没人用的声明。
  // （官方那几个 remote 类也是这个写法：只列自己用的，例如 ["fileReferences","typert"]。）
  static inject = ["typert"];

  constructor(ctx) {
    super(ctx, "helperPatch");
    // 启动日志：面板报「服务暂时不可用」时，先在宿主日志里看这一行在不在 ——
    // 它在，说明 remote 挂上了（问题在客户端取服务）；它不在，说明类根本没被实例化
    // （服务端主插件没加载，或者 inject 的 typert 一直没就绪）。
    //
    // 走宿主 logger 而不是 console.log：桌面端的 console 未必进日志文件，而这一行的
    // 全部价值就在于"事后能被翻到"。拿不到 logger 时才兜底 console（宁可重复也不静默）。
    const bootLine = '[dsh-helper] 定时任务 remote 服务已实例化（wire 名 helperPatch，7 个方法）。';
    if (typeof ctx?.logger?.info === 'function') ctx.logger.info(bootLine);
    else console.log(bootLine);
// @ts-expect-error 上游类型缺口：TypertRegistry.register(contribution) 未写进 TypertRegistryContract。
// 运行时有效：DSH 实际提供的 TypertRegistry 类实现了它（dsh-typert-registry/lib/index.js:398）。
    this.ctx.typert.register(TYPERT);
  }

  /**
   * 业务错误统一转 RemoteError（裸 Error 过线会退化成 gateway/internal 并丢掉 code）。
   *
   * `error.code` 只有**形如 `<domain>/<reason>`**（顶部 DOMAIN_CODE_PATTERN）才能当 wire code 用：
   * 系统 errno（`EACCES`/`ENOENT`/`EPERM`…）过线后被客户端按 code 分支时会误当领域码（D-17），
   * 所以形态不符一律回落 `fallbackCode`。
   *
   * 来历：2026-09-25 从 T专家 迁入时把 7 个访问器里的调用一起搬了过来，却漏搬了这个方法体
   * 本身——结果是每条业务错误（cron 非法、任务不存在、超限……）都退化成
   * `TypeError: this.businessError is not a function`，用户看到的是这句 JS 报错而不是
   * 「cron 表达式无法解析：xxx」。正常路径不受影响，所以只有专门打错误路径的冒烟能抓到。
   *
   * @param {unknown} error - 被捕获的原错误。
   * @param {string} fallbackCode - 该访问器的领域码。
   *
   * ⚠️ 这两个类型标注不是装饰：`fallbackCode` 缺标注时它是 `any`，于是下面那个三元表达式
   * 整体退化成 `any`，`@ts-expect-error` 就成了"unused"（TS2578）—— 也就是说那道
   * 「上游类型缺口」的抑制指令**从来没真正生效过**，而在 typecheck 上线前没人看得见这件事。
   * 补上 `string` 之后 `new RemoteError(...)` 才会如实报错，抑制指令也才名副其实。
   */
  businessError(error, fallbackCode) {
    if (error instanceof RemoteError) return error;
    const message = error instanceof Error ? error.message : String(error);
    // `unknown` 经 `typeof === "object"` 收窄后在 TS 眼里仍是 `object`（上面没有 code），
    // 所以显式当成「可能带 code 的未知对象」来读 —— 这是处理 catch 值的标准写法，
    // 比把参数标成 any 好：any 会顺着三元表达式传染下去，让下面那道抑制指令失效。
    const maybeCode = /** @type {{ code?: unknown }} */ (
      typeof error === "object" && error !== null ? error : {}
    ).code;
    const candidate = typeof maybeCode === "string" ? maybeCode : undefined;
// @ts-expect-error 上游类型缺口：RemoteErrorDetailsMap 是**闭合**的 gateway 错误码集合，helperPatch/* 业务码不在其中。
    return new RemoteError(DOMAIN_CODE_PATTERN.test(candidate ?? "") ? candidate : fallbackCode, message, {});
  }
  /**
   * 定时任务服务（辅助补丁自己的调度引擎，与其它插件完全独立）。
   *
   * 缺服务时给的是**功能语境的**错误码（`helperPatch/schedule-unavailable`
   * 读起来就是「定时事项用不了」），而不是笼统的 host-unavailable。
   */
  schedule() {
    const service = this.ctx.get(SCHEDULE_SERVICE);
    if (service === undefined) {
// @ts-expect-error 上游类型缺口：同上，helperPatch/* 业务码不在闭合的 RemoteErrorDetailsMap 里。
      throw new RemoteError("helperPatch/schedule-unavailable", "定时任务服务不可用（host 插件未加载或已卸载）", { service: SCHEDULE_SERVICE });
    }
    return service;
  }

  /** 定时事项快照：事项列表 + 开关状态 + 工作区选项 + 宿主能力探测。 */
  async getSchedule() {
    try {
      return this.schedule().snapshot();
    } catch (error) {
      throw this.businessError(error, "helperPatch/schedule-unreadable");
    }
  }

  /** 新建一条定时事项。 */
  async createScheduleItem(input) {
    try {
      const service = this.schedule();
      await service.create(input);
      return service.snapshot();
    } catch (error) {
      throw this.businessError(error, "helperPatch/schedule-invalid");
    }
  }

  /** 改一条定时事项（局部更新）。 */
  async updateScheduleItem(id, patch) {
    try {
      const service = this.schedule();
      await service.update(id, patch);
      return service.snapshot();
    } catch (error) {
      throw this.businessError(error, "helperPatch/schedule-invalid");
    }
  }

  /** 删一条定时事项。 */
  async deleteScheduleItem(id) {
    try {
      const service = this.schedule();
      await service.remove(id);
      return service.snapshot();
    } catch (error) {
      throw this.businessError(error, "helperPatch/schedule-invalid");
    }
  }

  /** 立即执行一条定时事项（等价于等它到点）。 */
  async runScheduleItem(id) {
    try {
      const service = this.schedule();
      await service.runNow(id);
      return service.snapshot();
    } catch (error) {
      throw this.businessError(error, "helperPatch/schedule-run-failed");
    }
  }

  /**
   * 确保定时任务要绑定的工作区存在：空 path = 默认的「定时任务」工作区
   * （目录 = 用户目录下的「定时任务」，见 host 侧 scheduleDefaultDir）；
   * 给了 path = 面板里填的自定义目录（不存在会建出来）。宿主的工作区 create 对同路径是幂等复用。
   */
  async ensureScheduleWorkspace(path) {
    try {
      return { workspace: await this.schedule().ensureWorkspace(String(path ?? ""), undefined) };
    } catch (error) {
      throw this.businessError(error, "helperPatch/schedule-workspace-failed");
    }
  }

  /**
   * 只读解析目标工作区（不建）：面板「新建任务」表单取默认值用。
   * `workspace.id` 为空串时表示"这个工作区还不存在，任务第一次执行时才建"。
   */
  async resolveScheduleWorkspace(path) {
    try {
      const resolved = this.schedule().resolveWorkspace(String(path ?? ""));
      return {
        workspace: {
          id: typeof resolved?.workspaceId === "string" ? resolved.workspaceId : "",
          title: "",
          path: typeof resolved?.workspacePath === "string" ? resolved.workspacePath : "",
        },
      };
    } catch (error) {
      throw this.businessError(error, "helperPatch/schedule-workspace-failed");
    }
  }

  /** 预览某个 cron 表达式接下来的 5 次触发时间（宿主用 croner 算，客户端不打包 cron 解析器）。 */
  async previewSchedule(cron) {
    try {
      return this.schedule().preview(cron);
    } catch (error) {
      throw this.businessError(error, "helperPatch/schedule-invalid");
    }
  }

}

exposeRemoteMethods(HelperPatchScheduleRemote, [
  "getSchedule", "createScheduleItem", "updateScheduleItem", "deleteScheduleItem",
  "runScheduleItem", "previewSchedule", "ensureScheduleWorkspace", "resolveScheduleWorkspace",
]);

export { DESCRIPTORS, TYPERT, SCHEDULE_SERVICE };
export default HelperPatchScheduleRemote;