import React from 'react';
import { render } from '@testing-library/react-native';
import { MessageBubble } from '../../src/components/chat/MessageBubble';
import { processMessages } from '../../src/hooks/useProcessedMessages';
import { composeMessage, getTaskCompleteMarkdown, type TMessage } from '../../src/utils/messageAdapter';

jest.mock('../../src/components/chat/MarkdownContent', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { MarkdownContent: ({ content }: { content: string }) => <Text testID='markdown'>{content}</Text> };
});
jest.mock('../../src/components/chat/ConfirmationCard', () => ({ ConfirmationCard: () => null }));
jest.mock('../../src/hooks/useThemeColor', () => ({ useThemeColor: () => '#000' }));

const tool = (id: string, update: Record<string, unknown>): TMessage => ({
  id,
  conversation_id: 'conv-1',
  type: 'acp_tool_call',
  position: 'left',
  content: { update: { tool_call_id: id, ...update } },
});
const completed = (update: Record<string, unknown> = {}) =>
  tool('complete', {
    title: 'task_complete',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: '**Done**\n\n- Result' } }],
    ...update,
  });

describe('mobile task_complete rendering', () => {
  it('renders the final result through the same markdown component as an assistant answer', () => {
    const [message] = processMessages([completed()]);
    if (message.type === 'tool_summary') throw new Error('Final answer must not be a collapsed tool summary');
    const { getByTestId, queryByText } = render(<MessageBubble message={message} />);
    expect(getByTestId('markdown').props.children).toBe('**Done**\n\n- Result');
    expect(queryByText('task_complete')).toBeNull();
  });

  it('separates the answer from surrounding collapsed tool steps without mutating stored history', () => {
    const answer = completed();
    const result = processMessages([
      tool('before', { title: 'bash', status: 'completed' }),
      answer,
      tool('after', { title: 'view', status: 'completed' }),
    ]);
    expect(result.map((item) => item.type)).toEqual(['tool_summary', 'text', 'tool_summary']);
    expect(result[1].id).toBe(answer.id);
    expect(answer.type).toBe('acp_tool_call');
  });

  it.each(['pending', 'in_progress', 'failed'])('keeps %s calls in their tool summary', (status) => {
    expect(processMessages([completed({ status })])[0].type).toBe('tool_summary');
  });

  it.each(['rawOutput', 'raw_output'])('renders historical %s content', (key) => {
    expect(getTaskCompleteMarkdown(completed({ content: [], [key]: { content: '# Final answer' } }))).toBe(
      '# Final answer'
    );
  });

  it('ignores empty or non-text blocks and prefers native text content to raw output', () => {
    expect(
      getTaskCompleteMarkdown(
        completed({
          title: ' task_complete ',
          content: [
            { type: 'content', content: { type: 'image', data: 'image' } },
            { type: 'content', content: { type: 'text', text: ' ' } },
            { type: 'content', content: { type: 'text', text: '# First' } },
            { type: 'content', content: { type: 'text', text: 'Second' } },
          ],
          rawOutput: { content: 'Fallback' },
        })
      )
    ).toBe('# First\nSecond');
  });

  it.each([null, {}, { update: null }, { update: { title: 42, status: 'completed' } }])(
    'keeps malformed payloads visible as tool steps: %j',
    (content) => {
      const message = { ...completed(), content };
      expect(getTaskCompleteMarkdown(message)).toBeUndefined();
      expect(processMessages([message])[0].type).toBe('tool_summary');
    }
  );

  it('does not promote other tools or a completion with no output into answers', () => {
    expect(processMessages([completed({ title: 'bash' }), completed({ content: [] })])[0].type).toBe('tool_summary');
  });

  it('merges a partial completion update without losing the title or combining different snake_case tool IDs', () => {
    const before = tool('bash', { title: 'bash', status: 'completed' });
    const pending = tool('complete', { title: 'task_complete', status: 'in_progress' });
    const update = tool('complete', {
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '**Finished**' } }],
    });
    const merged = composeMessage(update, [before, pending]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(before);
    expect(getTaskCompleteMarkdown(merged[1])).toBe('**Finished**');
  });

  it('does not merge unidentified tool calls just because both IDs are absent', () => {
    const first = { ...completed(), content: { update: { title: 'bash' } } };
    const second = { ...completed(), id: 'other', content: { update: { title: 'task_complete' } } };
    expect(composeMessage(second, [first])).toHaveLength(2);
  });
});
