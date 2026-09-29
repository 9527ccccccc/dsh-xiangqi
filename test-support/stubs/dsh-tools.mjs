// host 半边替身：`@deepseek-ai/dsh-tools`。
//
// 只在解析不到真包时启用（见 ../dsh-resolve-hooks.mjs），让 `node --test` 在没有 DSH 安装的
// 环境（CI、刚 clone 下来的机器）里也能跑插件自己的用例，而不是把 host 那一半整个跳过去。
//
// 替身只补两件**行为上看得出来**的事：
//   1. execute 是 async 的——真实 defineTool 会把它包成 async，于是一个同步抛错会变成
//      rejected promise。少了这层包装，assert.rejects 就抓不到同步抛错。
//   2. 挂上 STUBBED 标记——host.test.js 据此跳过「断言宿主 schema 编译器」的那两条用例。
//      那两条测的是 DSH 自己的行为，不是本插件的逻辑；用一个自己写的假编译器去糊弄它们，
//      只会得到一个看起来绿、其实没测到东西的结果。宁可跳，并写明为什么跳。
//
// 它**不做**参数校验、不编译 schema。所以「非法参数会在进 execute 之前被拦下」这条，
// 在没有真实 DSH 的环境里是没有被验证的。

export const defineTool = (definition) => ({
  ...definition,
  execute: async (...args) => definition.execute(...args),
});

// 挂在函数上而不是单独导出：用它的 host.test.js 只能 import 真包也有的名字，
// 真包没有这个属性，于是「是不是替身」一眼可判。
defineTool.STUBBED = true;
