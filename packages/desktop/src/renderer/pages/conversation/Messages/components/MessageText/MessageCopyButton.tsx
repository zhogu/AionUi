/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { iconColors } from '@/renderer/styles/colors';
import { copyText } from '@/renderer/utils/ui/clipboard';
import { Button, Message, Tooltip } from '@arco-design/web-react';
import { Copy } from '@icon-park/react';
import classNames from 'classnames';
import React from 'react';
import { useTranslation } from 'react-i18next';

const MessageCopyButton: React.FC<{ text: string; label?: string }> = ({ text, label }) => {
  const { t } = useTranslation();
  const isMobile = useLayoutContext()?.isMobile ?? false;
  const copyLabel = label ?? t('common.copy');
  const handleCopy = async () => {
    try {
      await copyText(text);
      Message.success(t('messages.copySuccess'));
    } catch {
      Message.error(t('common.copyFailed'));
    }
  };

  return (
    <Tooltip content={copyLabel}>
      <Button
        type='text'
        size='small'
        aria-label={copyLabel}
        className={classNames('!text-t-secondary transition-opacity', {
          'opacity-0 group-hover:opacity-100 focus:opacity-100': !isMobile,
          '!min-h-36px !min-w-36px': isMobile,
        })}
        icon={<Copy theme='outline' size='16' fill={iconColors.secondary} />}
        onClick={() => void handleCopy()}
      >
        {label}
      </Button>
    </Tooltip>
  );
};

export default MessageCopyButton;
