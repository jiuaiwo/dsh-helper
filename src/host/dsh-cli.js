/**
 * 复刻自 dshmarket/src/dsh-cli.ts:50 (nodeExecutable) 与 :367 (dshArgv)，
 * ts → js 翻译，无行为差异。Android 上 argv0 是真 node 二进制，execPath 是
 * linker64，spawn execPath 会把 --expose-internals 当程序路径，所以优先 argv0。
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * 真正可执行的 Node 路径。Android 走动态链接器，process.execPath 是 linker64，
 * spawn 它会把 --expose-internals 当作程序路径而失败（"expected absolute path"）。
 * process.argv0 是真正的 node，优先用；当 argv0 是存在的绝对路径时才用它，
 * 其它情况回退到 execPath。
 *
 * @param {string | undefined} argv0 - process.argv0，可注入便于测试
 * @param {string} execPath - process.execPath，可注入便于测试
 * @returns {string}
 */
export function nodeExecutable(argv0 = process.argv0, execPath = process.execPath) {
  if (argv0 !== undefined && argv0 !== '' && isAbsolute(argv0) && existsSync(argv0)) {
    return argv0;
  }
  return execPath;
}

/**
 * 重启时用来拉起 DSH 的 argv。
 *
 * 复刻自 dshmarket/src/dsh-cli.ts:367：
 *   - 若 process.argv[1] 命中 /[\\/](?:bin\.(?:js|ts)|dsh)$/（即 dsh 入口），
 *     用 node + process.execArgv + 绝对化的入口，cwd 取入口所在目录；
 *   - 否则回退到 PATH 里的 `dsh`（Windows 是 .cmd shim，必须经 shell）。
 *
 * 为什么要绝对路径：pnpm dsh 这种源码启动传入的是相对入口，子进程按自己的
 * cwd 解析会 MODULE_NOT_FOUND（#13）。cwd 在入口附近保证 execArgv 里的
 * tsx/esm 仍能解析。
 *
 * @returns {{ file: string; args: string[]; cwd: string | undefined; viaShell: boolean }}
 */
export function dshArgv() {
  const entry = process.argv[1];
  const winCmdShim = process.platform === 'win32';
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    const abs = resolve(entry);
    return {
      file: nodeExecutable(),
      args: [...process.execArgv, abs],
      cwd: dirname(abs),
      viaShell: false,
    };
  }
  return { file: 'dsh', args: [], cwd: undefined, viaShell: winCmdShim };
}