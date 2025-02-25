import pg from "pg";
import axios from "axios";
import { sleep } from "./sleep.ts";
import assert from "node:assert";
import { parse_event_type } from "schemata/generated/event_type";

type pool = pg.Pool;

async function fetch_event_t(): Promise<number> {
  while (true) {
    try {
      const res = await axios.get("http://event-db:3000/event-apis/event-t");
      if (typeof res.data === "number") {
        return res.data;
      }
      throw new Error(`result is not a number`);
    } catch (error: any) {
      console.error(error);
      await sleep(1000);
    }
  }
}

async function fetch_events(event_t: number): Promise<any[]> {
  while (true) {
    try {
      const res = await axios.get(
        `http://event-db:3000/event-apis/get-events?event_t=${event_t}`
      );
      if (Array.isArray(res.data)) {
        return res.data;
      } else {
        throw new Error("events is not an array");
      }
    } catch (error: any) {
      console.error(error);
      await sleep(1000);
    }
  }
}

async function get_self_event_t(pool: pool): Promise<number> {
  while (true) {
    try {
      const res = await pool.query(
        "select coalesce(max(event_t), 0) as t from event"
      );
      return parseInt(res.rows[0].t);
    } catch (error) {
      console.error(error);
      await sleep(100);
    }
  }
}

async function process_events(event_t: number, events: any[]) {
  const parsed_events = events.map(parse_event_type);
  console.log({ parsed_events });
  throw new Error("not yet");
}

export async function start_processing(pool: pool, when_done: () => void) {
  let event_t = await get_self_event_t(pool);
  const initial_event_t = await fetch_event_t();
  assert(event_t <= initial_event_t);
  while (event_t < initial_event_t) {
    const events = await fetch_events(event_t + 1);
    await process_events(event_t + 1, events);
    event_t += 1;
  }
  when_done();
  while (true) {
    const events = await fetch_events(event_t + 1);
    await process_events(event_t + 1, events);
    event_t += 1;
  }
}
