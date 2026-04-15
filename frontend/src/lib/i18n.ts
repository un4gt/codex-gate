import { createEffect, createSignal, useTransition, type JSX } from 'solid-js';
import { resolveTemplate, translator } from '@solid-primitives/i18n';
import { dict as en } from '@/i18n/en';
import { dict as zh } from '@/i18n/zh';

export type Locale = 'zh' | 'en';

type Dictionary = Record<string, string>;
type TranslationParams = Record<string, string | number>;

const LOCALE_KEY = 'codex_gate_locale';
const DEFAULT_LOCALE: Locale = 'zh';

const DICTIONARIES: Record<Locale, Dictionary> = { zh, en };
const INTL_LOCALES: Record<Locale, string> = {
  zh: 'zh-CN',
  en: 'en-US',
};

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

const [locale, setLocaleSignal] = createSignal<Locale>(readStoredLocale());
const translate = translator(() => DICTIONARIES[locale()], resolveTemplate);

export function initializeI18n() {
  const current = readStoredLocale();
  setLocaleSignal(current);
  syncDocumentLocale(current);
}

export function installLocaleEffect() {
  createEffect(() => {
    syncDocumentLocale(locale());
  });
}

export function getLocale() {
  return locale();
}

export function getIntlLocale() {
  return INTL_LOCALES[locale()];
}

export function setLocale(next: Locale) {
  if (next === locale()) return;
  persistLocale(next);
  setLocaleSignal(next);
}

export function t(key: string, params?: TranslationParams) {
  return translate(key, params) ?? key;
}

export function translateJsx(node: JSX.Element): JSX.Element {
  if (typeof node === 'string') return t(node);
  if (Array.isArray(node)) {
    return node.map((item) => translateJsx(item as JSX.Element)) as unknown as JSX.Element;
  }
  return node;
}

export function useI18n() {
  const [isSwitching, startTransition] = useTransition();

  return {
    locale,
    t,
    isSwitching,
    setLocale(next: Locale) {
      startTransition(() => setLocale(next));
    },
  };
}
