/**
 * Hand-rolled concurrency limiter (semaphore).
 *
 * Returns a `limit` function that gates concurrent execution to at most
 * `n` in-flight promises at any time. No external dependency needed.
 */
export function makeLimit(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];

  return <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(
          (val) => {
            active--;
            if (queue.length > 0) queue.shift()!();
            resolve(val);
          },
          (err) => {
            active--;
            if (queue.length > 0) queue.shift()!();
            reject(err);
          },
        );
      };

      if (active < n) {
        run();
      } else {
        queue.push(run);
      }
    });
  };
}
