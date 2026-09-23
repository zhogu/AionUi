import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpConfigOptionDto, SetConfigOptionResponse } from '@/common/types/platform/acpTypes';
import { executeAcpConfigCommand } from '@/renderer/pages/conversation/utils/executeAcpConfigCommand';

const { ensure, set, mutate } = vi.hoisted(() => ({
  ensure: vi.fn(),
  set: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: { acpConversation: { setConfigOption: { invoke: set } } },
}));
vi.mock('@/renderer/pages/conversation/utils/ensureConversationRuntime', () => ({
  ensureConversationRuntime: ensure,
}));
vi.mock('swr', () => ({ default: vi.fn(), mutate }));

const options: AcpConfigOptionDto[] = [
  {
    id: 'allow_all',
    name: 'Allow all permissions',
    type: 'select',
    category: 'permission',
    current_value: 'false',
    options: [
      { value: 'false', name: 'Ask for permission' },
      { value: 'true', name: 'Allow all' },
    ],
  },
  {
    id: 'mode',
    name: 'Mode',
    type: 'select',
    category: 'mode',
    current_value: 'interactive',
    options: ['interactive', 'autopilot'].map((value) => ({ value, name: value })),
  },
  {
    id: 'model',
    name: 'Model',
    type: 'select',
    category: 'model',
    current_value: 'auto',
    options: ['auto', 'tiered'].map((value) => ({ value, name: value })),
  },
];

const nativeOptions: AcpConfigOptionDto[] = [
  {
    ...options[0],
    category: 'permissions',
    current_value: 'off',
    options: [
      { value: 'on', name: 'On' },
      { value: 'off', name: 'Off' },
    ],
  },
  ...options.slice(1),
];

describe('executeAcpConfigCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    ensure.mockResolvedValue({ config_options: options });
    set.mockImplementation(
      async ({ option_id, value }): Promise<SetConfigOptionResponse> => ({
        confirmation: 'observed',
        config_options: options.map((option) =>
          option.id === option_id ? { ...option, current_value: value } : option
        ),
      })
    );
  });

  it.each([
    ['/allow-all', 'allow_all', 'true'],
    ['/allow-all  ', 'allow_all', 'true'],
    ['/allow-all on', 'allow_all', 'true'],
    ['/allow-all off', 'allow_all', 'false'],
    ['/autopilot on', 'mode', 'autopilot'],
    ['/autopilot off', 'mode', 'interactive'],
    ['/model tiered', 'model', 'tiered'],
  ])('routes %s through the live backend config RPC', async (input, option_id, value) => {
    expect(await executeAcpConfigCommand('conversation', input, false)).not.toBeNull();
    expect(ensure).toHaveBeenCalledWith('conversation');
    expect(set).toHaveBeenCalledExactlyOnceWith({ conversation_id: 'conversation', option_id, value });
    expect(mutate).toHaveBeenCalledWith(['acp-config-options', 'conversation']);
  });

  it.each([
    ['/allow-all', 'on'],
    ['/allow-all  ', 'on'],
    ['/allow-all on', 'on'],
    ['/allow-all off', 'off'],
  ])('uses native Copilot advertised values for %s', async (input, value) => {
    ensure.mockResolvedValue({ config_options: nativeOptions });
    set.mockResolvedValue({
      confirmation: 'observed',
      config_options: [{ ...nativeOptions[0], current_value: value }],
    });
    expect(await executeAcpConfigCommand('native', input, false)).toBe(
      `Allow all permissions: ${value === 'on' ? 'On' : 'Off'}`
    );
    expect(set).toHaveBeenCalledExactlyOnceWith({ conversation_id: 'native', option_id: 'allow_all', value });
    expect(mutate).toHaveBeenCalledWith(['acp-config-options', 'native']);
  });

  it.each(['command_ack', 'pending_next_turn', 'observed'])(
    'does not accept an unchanged native value with %s confirmation',
    async (confirmation) => {
      ensure.mockResolvedValue({ config_options: nativeOptions });
      set.mockResolvedValue({ confirmation, config_options: nativeOptions });
      await expect(executeAcpConfigCommand('native', '/allow-all on', false)).rejects.toThrow('config_not_observed');
      expect(mutate).not.toHaveBeenCalled();
    }
  );

  it('does not guess permission values from display labels', async () => {
    ensure.mockResolvedValue({
      config_options: [{ ...nativeOptions[0], options: [{ value: 'unknown', name: 'On' }] }],
    });
    await expect(executeAcpConfigCommand('native', '/allow-all on', false)).rejects.toThrow('unsupported value');
    expect(set).not.toHaveBeenCalled();
  });

  it.each(['Explain /allow-all', '```\n/allow-all\n```', '/allow-all\nDo something', '/compact'])(
    'leaves ordinary text and other commands untouched: %s',
    async (input) => {
      expect(await executeAcpConfigCommand('conversation', input, false)).toBeNull();
      expect(ensure).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    }
  );

  it('does not hijack commands from agents without the corresponding config option', async () => {
    ensure.mockResolvedValue({ config_options: [] });
    expect(await executeAcpConfigCommand('conversation', '/allow-all', false)).toBeNull();
    expect(set).not.toHaveBeenCalled();
  });

  it.each(['/allow-all maybe', '/autopilot', '/model bogus'])('rejects invalid values: %s', async (input) => {
    await expect(executeAcpConfigCommand('conversation', input, false)).rejects.toThrow();
    expect(set).not.toHaveBeenCalled();
  });

  it('rejects files and session references instead of dropping them', async () => {
    await expect(executeAcpConfigCommand('conversation', '/allow-all', true)).rejects.toThrow('files or session');
    expect(set).not.toHaveBeenCalled();
  });

  it.each(['command_ack', 'pending_next_turn', 'observed'])(
    'requires observed matching state, not %s alone',
    async (confirmation) => {
      set.mockResolvedValue({ confirmation, config_options: options });
      await expect(executeAcpConfigCommand('conversation', '/allow-all', false)).rejects.toThrow('config_not_observed');
      expect(mutate).not.toHaveBeenCalled();
    }
  );

  it('propagates backend errors without a model fallback', async () => {
    set.mockRejectedValue(new Error('session is busy'));
    await expect(executeAcpConfigCommand('conversation', '/allow-all', false)).rejects.toThrow('session is busy');
  });

  it.each([
    { advertised: options, value: 'true' },
    { advertised: nativeOptions, value: 'on' },
  ])(
    'uses the team configuration port with $value rather than bypassing its permission checks',
    async ({ advertised, value }) => {
      const load = vi.fn().mockResolvedValue(advertised);
      const setter = vi.fn().mockResolvedValue({
        confirmation: 'observed',
        config_options: [{ ...advertised[0], current_value: value }],
      });
      const blocked = vi.fn().mockReturnValue(true);
      const port = { load, setConfigOption: setter, isConfigOptionBlocked: blocked };
      await expect(executeAcpConfigCommand('team-member', '/allow-all', false, port)).rejects.toThrow(
        'config_update_in_progress'
      );
      expect(setter).not.toHaveBeenCalled();
      blocked.mockReturnValue(false);
      await executeAcpConfigCommand('team-member', '/allow-all', false, port);
      expect(setter).toHaveBeenCalledWith('team-member', 'allow_all', value);
      expect(ensure).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    }
  );
});
