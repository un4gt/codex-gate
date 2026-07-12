import { useSyncExternalStore, useTransition } from 'react';
import { dict as en } from '@/i18n/en';
import { dict as zh } from '@/i18n/zh';

export type Locale = 'zh' | 'en';

type Dictionary = Record<string, string>;
type TranslationParams = Record<string, string | number>;

const LOCALE_KEY = 'little_gate_locale';
const DEFAULT_LOCALE: Locale = 'zh';

const DICTIONARIES: Record<Locale, Dictionary> = { zh, en };
const INTL_LOCALES: Record<Locale, string> = {
  zh: 'zh-CN',
  en: 'en-US',
};

let currentLocale: Locale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

function normalizeLocale(value?: string | null): Locale {
  const normalized = value?.trim().toLowerCase();
  if (normalized?.startsWith('en')) return 'en';
  return 'zh';
}

function readStoredLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  return normalizeLocale(window.localStorage.getItem(LOCALE_KEY) ?? window.navigator.language);
}

function persistLocale(value: Locale) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LOCALE_KEY, value);
}

function syncDocumentLocale(value: Locale) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = INTL_LOCALES[value];
}

function resolveTemplate(template: string, params?: TranslationParams) {
  if (!params) return template;
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

function emitLocaleChange() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initializeI18n() {
  currentLocale = readStoredLocale();
  syncDocumentLocale(currentLocale);
}

export function getLocale() {
  return currentLocale;
}

export function getIntlLocale() {
  return INTL_LOCALES[currentLocale];
}

export function setLocale(next: Locale) {
  if (next === currentLocale) return;
  persistLocale(next);
  currentLocale = next;
  syncDocumentLocale(next);
  emitLocaleChange();
}

export function t(key: string, params?: TranslationParams) {
  const template = DICTIONARIES[currentLocale][key] ?? key;
  return resolveTemplate(template, params);
}

export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  const [isSwitching, beginTransition] = useTransition();

  return {
    locale,
    t,
    isSwitching,
    setLocale(next: Locale) {
      beginTransition(() => setLocale(next));
    },
  };
}
