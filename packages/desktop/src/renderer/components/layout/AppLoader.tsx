import { Button, Spin } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const AppLoader: React.FC<{ failed?: boolean }> = ({ failed = false }) => {
  const { t } = useTranslation(undefined, { useSuspense: false });
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 15000);
    return () => window.clearTimeout(timer);
  }, []);

  const showRecovery = failed || slow;
  return (
    <div className='flex flex-col items-center justify-center min-h-screen p-24px box-border text-t-primary bg-bg-1'>
      {!failed && <Spin dot />}
      <p role={failed ? 'alert' : 'status'} className='max-w-640px text-center'>
        {showRecovery ? t('common.pageLoadFailed') : t('common.loading')}
      </p>
      {showRecovery && <Button onClick={() => window.location.reload()}>{t('common.reload')}</Button>}
    </div>
  );
};

export class AppLoadBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('Application rendering failed:', error, info.componentStack);
  }

  render(): React.ReactNode {
    return this.state.failed ? <AppLoader failed /> : this.props.children;
  }
}

export default AppLoader;
