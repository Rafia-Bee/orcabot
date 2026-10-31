function createLimiter(getGapMs) {
  let queue = Promise.resolve();
  let nextRequestAt = 0;
  let pausedUntil = 0;

  return {
    isPaused: () => Date.now() < pausedUntil,
    pause(ms) {
      pausedUntil = Math.max(pausedUntil, Date.now() + ms);
    },
    reset() {
      nextRequestAt = 0;
      pausedUntil = 0;
    },
    run(fn) {
      const run = queue.then(async () => {
        const wait = nextRequestAt - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        try {
          return await fn();
        } finally {
          nextRequestAt = Date.now() + getGapMs();
        }
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}

module.exports = { createLimiter };
