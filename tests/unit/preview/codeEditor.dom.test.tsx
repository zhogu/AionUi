import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

// jsdom has no text-range layout; CodeMirror measures after revealing a line.
Object.defineProperties(Range.prototype, {
  getClientRects: { configurable: true, value: () => [] },
  getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
});

vi.mock('@/renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'light' }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import CodeEditor from '@/renderer/pages/conversation/Preview/components/editors/CodeEditor';

afterEach(() => vi.clearAllMocks());

describe('CodeEditor', () => {
  it('reveals the requested source line when the editor is first created and when the target changes', async () => {
    const value = Array.from({ length: 450 }, (_, i) => `source line ${i + 1}`).join('\n');
    const { container, rerender } = render(
      <CodeEditor value={value} onChange={() => {}} fileName='research.py' targetLine={419} targetColumn={7} />
    );
    const editor = container.querySelector<HTMLElement>('.cm-editor');
    expect(editor).not.toBeNull();
    const view = EditorView.findFromDOM(editor!);
    await waitFor(() => expect(view?.state.selection.main.head).toBe(view!.state.doc.line(419).from + 6));
    rerender(<CodeEditor value={value} onChange={() => {}} fileName='research.py' targetLine={42} />);
    await waitFor(() => expect(view?.state.selection.main.head).toBe(view!.state.doc.line(42).from));
  });

  it('renders a CodeMirror editor with the given value', () => {
    const { container } = render(<CodeEditor value={'const a = 1;'} onChange={() => {}} language='javascript' />);
    expect(container.querySelector('.cm-editor')).not.toBeNull();
    expect(container.textContent).toContain('const a = 1;');
  });

  it('renders read-only editor without crashing', () => {
    const { container } = render(<CodeEditor value={'x'} onChange={() => {}} readOnly />);
    expect(container.querySelector('.cm-editor')).not.toBeNull();
  });

  it('shows the AI-writing badge when content grows externally', () => {
    const { container, rerender } = render(<CodeEditor value={'a'} onChange={() => {}} />);
    rerender(<CodeEditor value={'a much longer streamed body of content'} onChange={() => {}} />);
    expect(container.textContent).toContain('preview.aiWriting');
  });
});
