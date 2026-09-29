// 模块解析钩子：`@deepseek-ai/dsh-*` 解析不到时退回 test-support/stubs/ 里的替身。
//
// 为什么要这个：host 半边 import 的是宿主随包发布的模块，一个刚 clone 下来的仓库没有它们，
// 于是 host.test.js（最大的一份用例）会直接 import 失败。这里让「装没装 DSH」不再决定
// 测试能不能跑。
//
// 优先级是**先试真的**：本机装了 DSH 就用真包测，替身只在真包缺失时兜底。
// 这样 CI 与开发机各测各的，都不会因为对方的缺失而误报。

const STUBS = new Map([
  ['@deepseek-ai/dsh-tools', './stubs/dsh-tools.mjs'],
  ['@deepseek-ai/dsh-llm', './stubs/dsh-llm.mjs'],
]);

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS.get(specifier);
  if (!stub) return nextResolve(specifier, context);

  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
      return { url: new URL(stub, import.meta.url).href, shortCircuit: true };
    }
    throw error;
  }
}
