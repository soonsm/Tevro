// 실패 횟수 제한. 키(접속 주소, 접속 주소 + 아이디)마다 정해진 시간 창 안의 실패를 센다.
// 메모리에만 두므로 서버를 다시 켜면 처음부터 센다. 계정 자체를 잠그지 않아, 남이 일부러 틀려도 주인은 다른 곳에서 들어올 수 있다.

export interface Limiter {
  /** 막혀 있으면 풀릴 때까지 남은 밀리초, 아니면 null */
  blocked(key: string): number | null;
  fail(key: string): void;
  reset(key: string): void;
}

export function createLimiter(options: { max: number; windowMs: number; now?: () => number; maxKeys?: number }): Limiter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 50_000;
  const entries = new Map<string, { count: number; resetAt: number }>();

  function current(key: string) {
    const entry = entries.get(key);
    if (entry && entry.resetAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  function prune() {
    const at = now();
    for (const [key, entry] of entries) if (entry.resetAt <= at) entries.delete(key);
    // 그래도 많으면 오래된 것부터 버린다(Map은 넣은 순서를 지킨다). 메모리를 무한히 쓰지 않게 하는 안전장치다.
    for (const key of entries.keys()) {
      if (entries.size <= maxKeys) break;
      entries.delete(key);
    }
  }

  return {
    blocked(key) {
      const entry = current(key);
      return entry && entry.count >= options.max ? entry.resetAt - now() : null;
    },
    fail(key) {
      const entry = current(key);
      if (entry) entry.count += 1;
      else {
        if (entries.size >= maxKeys) prune();
        entries.set(key, { count: 1, resetAt: now() + options.windowMs });
      }
    },
    reset(key) {
      entries.delete(key);
    },
  };
}
