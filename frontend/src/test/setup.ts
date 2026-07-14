export {};

class ResizeObserverMock implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}

  disconnect() {}

  observe(_target: Element, _options?: ResizeObserverOptions) {}

  unobserve(_target: Element) {}
}

globalThis.ResizeObserver ??= ResizeObserverMock;
globalThis.AbortController = window.AbortController;
globalThis.AbortSignal = window.AbortSignal;

const nativeAddEventListener = window.EventTarget.prototype.addEventListener;
const nativeRemoveEventListener = window.EventTarget.prototype.removeEventListener;

function addEventListenerWithCrossRealmSignal(
  this: EventTarget,
  type: string,
  callback: EventListenerOrEventListenerObject | null,
  options?: boolean | AddEventListenerOptions,
): void {
  if (!callback) return;
  if (options && typeof options === 'object' && options.signal) {
    const { signal, ...eventOptions } = options;
    nativeAddEventListener.call(this, type, callback, eventOptions);
    signal.addEventListener('abort', () => {
      nativeRemoveEventListener.call(this, type, callback, eventOptions);
    }, { once: true });
    return;
  }
  nativeAddEventListener.call(this, type, callback, options);
}

window.EventTarget.prototype.addEventListener = addEventListenerWithCrossRealmSignal as typeof window.EventTarget.prototype.addEventListener;
