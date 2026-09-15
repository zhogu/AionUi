import type { AcpConfigOptionDto, SetConfigOptionResponse } from '@/common/types/platform/acpTypes';
import { BackendHttpError } from '@/common/adapter/httpBridge';
import {
  classifyConfigSetError,
  deriveContextWindowOption,
  deriveSelectOption,
  hasObservedValue,
} from '@/renderer/hooks/agent/useAcpConfigOptions';
import { describe, expect, it } from 'vitest';

const options: AcpConfigOptionDto[] = [
  {
    id: 'model',
    category: 'model',
    option_type: 'select',
    current_value: 'gpt-5.5',
    options: [
      { value: 'gpt-5.5', name: 'GPT-5.5' },
      { value: 'gpt-5.4', name: 'GPT-5.4' },
    ],
  },
  {
    id: 'reasoning_effort',
    category: 'thought_level',
    option_type: 'select',
    current_value: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
    ],
  },
];

describe('ACP config option derivation', () => {
  it('keeps model and thought_level independent', () => {
    const model = deriveSelectOption(options, 'model', ['model']);
    const thought = deriveSelectOption(options, 'thought_level', ['reasoning_effort']);

    expect(model?.currentValue).toBe('gpt-5.5');
    expect(model?.options.map((item) => item.value)).toEqual(['gpt-5.5', 'gpt-5.4']);
    expect(thought?.currentValue).toBe('high');
    expect(thought?.options.map((item) => item.value)).toEqual(['low', 'high']);
  });

  it('derives select options from backend DTOs using type', () => {
    const backendOptions = [
      {
        id: 'reasoning_effort',
        category: 'thought_level',
        type: 'select',
        current_value: 'high',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      },
    ] as unknown as AcpConfigOptionDto[];

    const thought = deriveSelectOption(backendOptions, 'thought_level', ['reasoning_effort']);

    expect(thought?.currentValue).toBe('high');
    expect(thought?.options.map((item) => item.value)).toEqual(['low', 'high']);
  });

  it('accepts only observed set responses with matching current_value', () => {
    const response: SetConfigOptionResponse = {
      confirmation: 'observed',
      config_options: options,
    };

    expect(hasObservedValue(response, 'model', 'gpt-5.5')).toBe(true);
    expect(hasObservedValue(response, 'model', 'gpt-5.4')).toBe(false);
  });

  it('rejects command_ack responses without mutating confirmed state', () => {
    const response: SetConfigOptionResponse = {
      confirmation: 'command_ack',
      config_options: null,
    };

    expect(hasObservedValue(response, 'model', 'gpt-5.5')).toBe(false);
  });

  it('classifies a team runtime Starting conflict as a busy config update', () => {
    const error = new BackendHttpError({
      method: 'PUT',
      path: '/api/teams/team-1/conversations/conv-1/config-options/model',
      status: 409,
      body: {
        success: false,
        error: 'Team member runtime is starting',
        code: 'TEAM_MEMBER_RUNTIME_STARTING',
      },
    });

    expect(classifyConfigSetError(error)).toBe('config_update_in_progress');
  });

  it('derives context choices from runtime metadata without inventing model capacities', () => {
    const context = deriveContextWindowOption([
      ...options,
      {
        id: 'context-capacity',
        category: 'context_window',
        type: 'select',
        current_value: 'standard',
        options: [
          { value: 'standard', name: '256k', description: 'Standard context' },
          { value: 'extended', name: '1M', description: 'Extended context' },
        ],
      },
    ]);

    expect(context?.id).toBe('context-capacity');
    expect(context?.currentValue).toBe('standard');
    expect(context?.options).toEqual([
      { value: 'standard', label: '256k', description: 'Standard context' },
      { value: 'extended', label: '1M', description: 'Extended context' },
    ]);
  });

  it.each([null, undefined, [], options].map((runtimeOptions) => ({ runtimeOptions })))(
    'does not offer context selection when absent',
    ({ runtimeOptions }) => {
      expect(deriveContextWindowOption(runtimeOptions)).toBeNull();
    }
  );

  it.each([[], ['default'], ['default', 'default']].map((values) => ({ values })))(
    'hides a context option without distinct choices: $values',
    ({ values }) => {
      expect(
        deriveContextWindowOption([
          {
            id: 'context_window',
            type: 'select',
            current_value: 'default',
            options: values.map((value) => ({ value })),
          },
        ])
      ).toBeNull();
    }
  );

  it('does not treat a read-only context size as a selectable window', () => {
    expect(
      deriveContextWindowOption([{ id: 'context_window', type: 'string', current_value: '256000', options: [] }])
    ).toBeNull();
  });
});
