// host 半边替身：`@deepseek-ai/dsh-llm`。
//
// 本插件只用到 createUserMessage 一个用途——把 {content, source} 包成一条能 inject /
// followup 的消息。替身补上 role: 'user'（函数名就是这个意思），其余原样透传。

export const createUserMessage = (message) => ({ role: 'user', ...message });
