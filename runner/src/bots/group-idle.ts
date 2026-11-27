// Idle relay detection copied from DS-Bot groups.js at d104d9ca18d69a35460f14e15dff4d553181433a.
// Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0.
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Short ack/thanks/closing phrases with no new content, used by the 0-tool idle loop guard.
const IDLE_ACK_WORDS = "收到|好的|好|明白|明白了|了解|了解了|没问题|谢谢|多谢|感谢|辛苦了|辛苦|不客气|不用谢|完毕|完成|好嘞|行|ok|okay|got\\s+it|understood|noted|thanks|thank\\s+you|you\\s+are\\s+welcome|you're\\s+welcome|welcome|np|no\\s+problem|roger|ack|done|all\\s+good|sounds\\s+good"
// A status post: a member saying it has nothing to do right now. It carries no new
// content and calls nobody, and a group that keeps answering itself with these spins
// until the user writes (#853). The words are the ones members actually post.
// A noun needs its "nothing there" prefix: "任务", "变化" or "安排" alone is ordinary
// talk about work, and matching it would stop a group that is working.
const IDLE_STATUS_WORDS = [
  '(?:收口)?(?:当前|目前|今日|今天)*(?:暂无|没有|无)+(?:待办|任务|新进展|新内容|进展|动作|变化|安排)',
  '待命', '保持待命', '继续待命', '原地待命', '静候', '静候下一步', '静候指令', '等候指令',
  '等待指令', '等待指示', '等待下一步', '等待安排', '等待新任务', '无事可做', '空转',
  'standby', 'standing\\s+by', 'idle', 'nothing\\s+(?:pending|to\\s+do|new)',
  'no\\s+pending\\s+(?:tasks?|work)', 'no\\s+new\\s+(?:work|tasks?|progress|updates?)',
  'no\\s+changes?', 'no\\s+updates?', 'waiting\\s+for\\s+(?:instructions?|the\\s+next\\s+steps?)',
].join('|')
// A line may mix them: "收到，待命" is a status post too.
const IDLE_BODY = new RegExp(`^(?:(?:${IDLE_ACK_WORDS}|${IDLE_STATUS_WORDS})(?:[\\s，,、。.!！~～：:；;]+|$))+$`, 'i')
const IDLE_TEXT_MAX = 45
export const normalizeRelayBody = (text: string, everyone: readonly { name: string }[]) => {
  let out = String(text ?? '')
  for (const bot of everyone) {
    out = out.replace(new RegExp(`@${escapeRegExp(bot.name)}\\b`, 'gi'), '')
    out = out.replaceAll(`@${bot.name}`, '')
  }
  return out.replace(/@(?:all|everyone|所有人|全体)/gi, '').replace(/[\s，,、。.!！?？;；:：'"“”‘’()（）[\]【】~～-]+/g, ' ').trim().toLowerCase()
}
export const isIdleRelayText = (text: string, everyone: readonly { name: string }[], priorBodies: readonly string[]) => {
  const norm = normalizeRelayBody(text, everyone)
  if (norm === '' || (norm.length <= IDLE_TEXT_MAX && IDLE_BODY.test(norm))) return true
  return priorBodies.some(prev => prev !== '' && (prev === norm || (prev.length >= 8 && norm.length >= 8 && (prev.includes(norm) || norm.includes(prev)))))
}
