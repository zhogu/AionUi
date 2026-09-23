import { ipcBridge } from '@/common';
import {
  deriveSelectOption,
  hasObservedValue,
  revalidateAcpConfigOptions,
  type AcpConfigOptionsPort,
} from '@/renderer/hooks/agent/useAcpConfigOptions';
import { ensureConversationRuntime } from './ensureConversationRuntime';

/** Dispatch explicit configuration commands before the backend adds first-message instructions. */
export async function executeAcpConfigCommand(
  conversationId: string,
  input: string,
  hasAttachments: boolean,
  port?: AcpConfigOptionsPort
): Promise<string | null> {
  const match = /^\/(allow-all|autopilot|model)(?:[ \t]+([^\r\n]*))?$/.exec(input.trim());
  if (!match) return null;
  const [, command, argument = ''] = match;
  const options = port
    ? await port.load(conversationId)
    : (await ensureConversationRuntime(conversationId)).config_options;
  const id = command === 'allow-all' ? 'allow_all' : command === 'autopilot' ? 'mode' : 'model';
  const option = deriveSelectOption(options, id === 'allow_all' ? 'permission' : id, [id]);
  if (!option || option.id !== id) return null;
  if (hasAttachments) throw new Error(`/${command}: configuration commands cannot include files or session references`);
  const arg = argument.trim();
  if (
    (command === 'allow-all' && !['', 'on', 'off'].includes(arg)) ||
    (command === 'autopilot' && !['on', 'off'].includes(arg))
  ) {
    throw new Error(`/${command}: specify on or off`);
  }
  const values =
    command === 'allow-all'
      ? [arg || 'on', String(arg !== 'off')]
      : command === 'autopilot'
        ? [arg === 'on' ? 'autopilot' : 'interactive']
        : [arg];
  // Native ACP uses on/off; the SDK adapter uses true/false. Only send advertised values.
  const choice = values.map((value) => option.options.find((entry) => entry.value === value)).find(Boolean);
  if (!choice)
    throw new Error(`/${command}: unsupported value; choose ${option.options.map((o) => o.value).join(', ')}`);
  const value = choice.value;
  if (port?.isConfigOptionBlocked?.(conversationId, id, option.category)) {
    throw new Error('config_update_in_progress');
  }
  const result = port?.setConfigOption
    ? await port.setConfigOption(conversationId, id, value)
    : await ipcBridge.acpConversation.setConfigOption.invoke({
        conversation_id: conversationId,
        option_id: id,
        value,
      });
  if (!hasObservedValue(result, id, value)) throw new Error('config_not_observed');
  await revalidateAcpConfigOptions(conversationId);
  return `${options?.find((entry) => entry.id === id)?.name || id}: ${choice.label}`;
}
