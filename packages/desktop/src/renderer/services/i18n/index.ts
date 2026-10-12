import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { configService } from '@/common/config/configService';
import { ipcBridge } from '@/common';
import i18nConfig from '@/common/config/i18n-config.json';
import {
  DEFAULT_LANGUAGE,
  normalizeLanguageCode,
  mergeWithFallback,
  ensureAndSwitch,
  type LocaleData,
  type SupportedLanguage,
} from '@/common/config/i18n';
import { applyDocumentDirection } from './direction';

// Keep only the fallback language in the initial bundle. Every other locale is
// a content-hashed lazy chunk, so first paint does not download all translations.
import enUS from './locales/en-US/index';
export type { I18nKey, I18nModule } from './i18n-keys';

// Re-exports
export { normalizeLanguageCode } from '@/common/config/i18n';
export type { SupportedLanguage } from '@/common/config/i18n';

export const supportedLanguages = i18nConfig.supportedLanguages;

const fallbackLocale = enUS as Record<string, unknown>;
type LazyLanguage = Exclude<SupportedLanguage, 'en-US'>;
const localeLoaders: Record<LazyLanguage, () => Promise<LocaleData[string]>> = {
  'zh-CN': () => import('./locales/zh-CN/index').then((module) => module.default),
  'ja-JP': () => import('./locales/ja-JP/index').then((module) => module.default),
  'zh-TW': () => import('./locales/zh-TW/index').then((module) => module.default),
  'ko-KR': () => import('./locales/ko-KR/index').then((module) => module.default),
  'tr-TR': () => import('./locales/tr-TR/index').then((module) => module.default),
  'ru-RU': () => import('./locales/ru-RU/index').then((module) => module.default),
  'uk-UA': () => import('./locales/uk-UA/index').then((module) => module.default),
  'pt-BR': () => import('./locales/pt-BR/index').then((module) => module.default),
  'de-DE': () => import('./locales/de-DE/index').then((module) => module.default),
  'es-ES': () => import('./locales/es-ES/index').then((module) => module.default),
  'fr-FR': () => import('./locales/fr-FR/index').then((module) => module.default),
  'fa-IR': () => import('./locales/fa-IR/index').then((module) => module.default),
};

// Cache for loaded translations
const loadedTranslations = new Map<string, Record<string, unknown>>();

// Pre-populate cache with the synchronously loaded fallback locale
loadedTranslations.set(DEFAULT_LANGUAGE, fallbackLocale as Record<string, unknown>);

function getLocalStorageLanguageHint(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem('i18nextLng');
}

function getInjectedLanguageHint(): string | null {
  if (typeof window === 'undefined') return null;
  const language = window.__initialLanguage;
  return typeof language === 'string' && language.trim() !== '' ? language : null;
}

function getElectronSystemLanguageHint(): string | null {
  if (typeof window === 'undefined' || !window.electronAPI) return null;
  return navigator.language || null;
}

function getInitialLanguage(): SupportedLanguage {
  const backendStartupFailed =
    typeof window !== 'undefined' && (window as Window & { __backendStartupFailed?: boolean }).__backendStartupFailed;
  const localStorageLanguage = getLocalStorageLanguageHint();
  const injectedLanguage = getInjectedLanguageHint();
  const systemLanguage = backendStartupFailed ? getElectronSystemLanguageHint() : null;
  const hint = backendStartupFailed
    ? injectedLanguage || localStorageLanguage || systemLanguage
    : localStorageLanguage || injectedLanguage;
  return normalizeLanguageCode(hint || DEFAULT_LANGUAGE);
}

async function loadLocaleModules(locale: string): Promise<Record<string, unknown>> {
  const normalized = normalizeLanguageCode(locale);
  const cached = loadedTranslations.get(normalized);
  if (cached) return cached;

  const loader = localeLoaders[normalized as LazyLanguage];
  const modules = loader ? mergeWithFallback(fallbackLocale, await loader()) : fallbackLocale;
  loadedTranslations.set(normalized, modules);
  return modules;
}

const initialLanguage = getInitialLanguage();
const initialResources: Record<string, { translation: Record<string, unknown> }> = {
  [DEFAULT_LANGUAGE]: {
    translation: fallbackLocale,
  },
};

// Initialize i18n with the fallback synchronously. The application shell waits
// for i18nReady before rendering, so a lazy configured locale does not flash.
// NOTE: We intentionally do NOT use i18next-browser-languagedetector here.
// In WebUI mode the browser's localStorage is on a different origin than the
// Electron renderer, so the detector would read the wrong (or missing) value
// and fall back to navigator.language, causing a language mismatch (Issue #1176).
// Instead, we use localStorage and Electron's injected local config language
// only as hints for the initial render, then let configService be the source of truth.
const initializeI18n = i18n
  .use(initReactI18next)
  .init({
    resources: initialResources,
    lng: DEFAULT_LANGUAGE,
    fallbackLng: DEFAULT_LANGUAGE,
    debug: false,
    interpolation: { escapeValue: false },
  })
  .then((): void => {});

// Load initial language from configService (single source of truth).
// Wait until configService.whenReady() so we observe the authoritative value
// fetched from the backend rather than the empty cache that exists during
// module load.
async function initLanguage(): Promise<void> {
  try {
    await configService.whenReady();
    const savedLanguage = configService.get('language');
    const language = savedLanguage || normalizeLanguageCode(navigator.language || DEFAULT_LANGUAGE);
    await ensureAndSwitch(i18n, language, loadLocaleModules);
    // Sync to localStorage so next page load can use it as a fast hint
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('i18nextLng', normalizeLanguageCode(language));
    }
  } catch (error) {
    console.error('Failed to initialize language:', error);
  }
}

// Listen for language changes and lazy load translations
i18n.on('languageChanged', async (lang: string) => {
  const normalizedLang = normalizeLanguageCode(lang);
  if (i18n.hasResourceBundle(normalizedLang, 'translation')) return;

  try {
    const translation = await loadLocaleModules(normalizedLang);
    i18n.addResourceBundle(normalizedLang, 'translation', translation, true, true);
  } catch (error) {
    console.error(`Failed to load language ${normalizedLang}:`, error);
  }
});

// Keep <html dir>/<html lang> in step with the app language (fa-IR is RTL).
// Separate listener: the one above early-returns once the bundle is loaded.
i18n.on('languageChanged', (lang: string) => {
  applyDocumentDirection(lang);
});
applyDocumentDirection(initialLanguage);

// The application shell waits for this promise, keeping the dependency-free
// loader visible until the configured locale chunk is complete.
export const i18nReady = initializeI18n.then(initLanguage).catch((error: Error) => {
  console.error('Failed to initialize i18n:', error);
});

// Listen for language changes broadcast by the main process (from other renderers).
// This enables real-time sync between desktop and WebUI — when one changes language,
// the other updates immediately without requiring a restart.
ipcBridge.systemSettings.languageChanged.on(async ({ language }) => {
  const normalized = normalizeLanguageCode(language);
  // Skip if already on this language (we're the one who triggered the change)
  if (i18n.language === normalized) return;
  await ensureAndSwitch(i18n, normalized, loadLocaleModules);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('i18nextLng', normalized);
  }
});

/**
 * Change language with lazy loading.
 */
export async function changeLanguage(lang: string): Promise<void> {
  await ensureAndSwitch(i18n, lang, loadLocaleModules);
  const normalized = normalizeLanguageCode(lang);
  await configService.set('language', normalized);
  // Keep localStorage in sync so WebUI can use it as a fast hint on next load
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('i18nextLng', normalized);
  }
  // Notify main process to sync i18n (for tray menu, etc.)
  ipcBridge.systemSettings.changeLanguage.invoke({ language: normalized }).catch(() => {});
}

// Clear translation cache (useful for development/testing)
export function clearTranslationCache(): void {
  loadedTranslations.clear();
  loadedTranslations.set(DEFAULT_LANGUAGE, fallbackLocale);
}

// Get loaded languages
export function getLoadedLanguages(): string[] {
  return Array.from(loadedTranslations.keys());
}

export default i18n;
