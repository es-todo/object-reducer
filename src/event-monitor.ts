import assert from "node:assert";
import pg from "pg";

type pool = pg.Pool;

export class EventMonitor {
  private t: number | undefined = undefined;
  private waiters: Set<(t: number) => void> = new Set();
  private pollers: Map<number, Set<() => void>> = new Map();
  private pool: pool;

  constructor(pool: pool) {
    this.pool = pool;
    this.init();
  }

  public get_t(): Promise<number> {
    if (this.t === undefined) {
      return new Promise((resolve) => this.waiters.add(resolve));
    } else {
      return Promise.resolve(this.t);
    }
  }

  public wait_events(t: number): Promise<void> {
    console.log({ t, mine: this.t });
    if (this.t === undefined || t > this.t) {
      return new Promise((resolve) => {
        const s =
          this.pollers.get(t) ??
          ((s: Set<() => void>) => {
            this.pollers.set(t, s);
            return s;
          })(new Set());
        s.add(resolve);
      });
    } else {
      return Promise.resolve();
    }
  }

  private async dequeue_all(s: Set<() => void>) {
    s.forEach((f) => f());
  }

  private note_t(t: number) {
    console.log({ noting: t });
    if (this.t === undefined) {
      this.t = t;
      this.waiters.forEach((f) => f(t));
      this.waiters.clear();
      for (const k of this.pollers.keys()) {
        if (k <= t) {
          const s = this.pollers.get(k);
          assert(s);
          this.pollers.delete(k);
          this.dequeue_all(s);
        }
      }
    }
    while (this.t < t) {
      this.t += 1;
      const s = this.pollers.get(this.t);
      if (s) {
        this.pollers.delete(this.t);
        this.dequeue_all(s);
      }
    }
  }

  private async init() {
    while (true) {
      try {
        const conn = await this.pool.connect();
        const p = new Promise(async (_resolve, reject) => {
          conn.on("error", (error) => reject(error));
          conn.on("end", () => reject(new Error("connection ended")));
          conn.on("notification", (message) => {
            assert(message.payload !== undefined);
            this.note_t(parseInt(message.payload));
          });
          try {
            await conn.query("listen event_stream");
            const data = await conn.query(
              "select coalesce(max(event_t), 0) as t from clock"
            );
            this.note_t(parseInt(data.rows[0].t));
          } catch (error: any) {
            conn.removeAllListeners();
            conn.release(error);
            reject(error);
          }
        });
        await p;
      } catch (error) {
        console.error(error);
      }
    }
  }
}
