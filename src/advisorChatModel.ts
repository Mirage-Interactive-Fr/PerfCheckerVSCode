import {parseInvestigation} from './investigationModel';

export interface ChatMessage {role: 'user' | 'assistant'; content: string}
const length = (text: string) => [...text].length;

/** Keep complete recent exchanges; do not silently cut a question or a reply. */
export function prepareChatMessages(history: readonly ChatMessage[], question: unknown): {messages: ChatMessage[]; omitted: number} {
  if (typeof question !== 'string' || !question.trim() || length(question) > 16000) {
    throw new Error('Enter a question of at most 16,000 characters.');
  }
  if (history.length % 2 || history.some((message, index) =>
    message.role !== (index % 2 ? 'assistant' : 'user') || typeof message.content !== 'string' ||
    !message.content.trim() || length(message.content) > 16000)) throw new Error('Invalid conversation history.');
  const messages: ChatMessage[] = [...history, {role: 'user', content: question.trim()}];
  let omitted = 0;
  let size = messages.reduce((sum, message) => sum + length(message.content), 0);
  while (messages.length > 21 || size > 32000) {
    size -= length(messages[0].content) + length(messages[1].content);
    messages.splice(0, 2); omitted += 2;
  }
  return {messages, omitted};
}

export function chatReply(input: unknown, timeoutSeconds?: number): string {
  const report = parseInvestigation(input);
  const data = input as Record<string, unknown>;
  if (report.schema_version !== 'perfchecker-narrative/1') throw new Error('Unsupported chat response. Update the PerfChecker controller.');
  if (report.status === 'timeout') {
    const duration = Number.isFinite(timeoutSeconds) && timeoutSeconds! > 0 ? ` after ${timeoutSeconds} seconds` : '';
    const diagnostic = String(data.message || data.error || 'Advisor worker timed out.');
    throw new Error(`Global request timed out${duration} (including worker startup). PerfChecker did not apply changes to your project. Details: ${diagnostic}`);
  }
  if (report.status !== 'complete') throw new Error(String(data.message || data.error || `Advisor request ${report.status ?? 'failed'}. Check the connection and controller version.`));
  if (data.authority !== 'unverified_narrative' || data.reference_status !== 'unstructured_not_verified' ||
      typeof report.external_review !== 'string' || !report.external_review.trim()) throw new Error('Invalid MCP chat response.');
  return report.external_review;
}

/** Bound the stored transcript as well as the next request, retaining whole exchanges. */
export function completeChatMessages(messages: readonly ChatMessage[], reply: string): {messages: ChatMessage[]; omitted: number} {
  if (!messages.length || messages.length % 2 !== 1 || !reply.trim() || length(reply) > 16000) throw new Error('Invalid conversation reply.');
  const completed: ChatMessage[] = [...messages, {role: 'assistant', content: reply}];
  let size = completed.reduce((sum, message) => sum + length(message.content), 0), omitted = 0;
  while (completed.length > 20 || size > 32000) {
    size -= length(completed[0].content) + length(completed[1].content);
    completed.splice(0, 2); omitted += 2;
  }
  return {messages: completed, omitted};
}
