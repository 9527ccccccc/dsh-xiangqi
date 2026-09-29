// `node --import ./test-support/dsh-stub.mjs --test` 的入口：注册下面那个解析钩子。
// 见 dsh-resolve-hooks.mjs 里对「为什么需要替身」的说明。

import { register } from 'node:module';

register('./dsh-resolve-hooks.mjs', import.meta.url);
