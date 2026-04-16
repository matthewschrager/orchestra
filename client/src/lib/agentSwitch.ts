import type { Message } from "shared";

export function isAgentSwitchMessage(message: Pick<Message, "role" | "metadata">): boolean {
  return message.role === "system" && message.metadata?.kind === "agent_switch";
}

export function getLatestAgentSwitchSeq(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isAgentSwitchMessage(messages[i])) return messages[i].seq;
  }
  return -1;
}
