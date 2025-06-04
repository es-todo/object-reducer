import pg from "pg";
import axios from "axios";
import { sleep } from "./sleep.ts";
import assert from "node:assert";
import { parse_event_type } from "schemata/generated/event_type";
import { Transaction } from "./transaction.ts";
import { process_event } from "./event-rules.ts";

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

async function process_events(event_t: number, events: any[], pool: pool) {
  console.log({ events });
  const parsed_events = events.map(parse_event_type);
  console.log({ parsed_events });
  const client = await pool.connect();
  await client.query("begin transaction isolation level serializable");
  const trx = new Transaction(client);
  await trx.set_clock(event_t);
  for (const { event_i, type, data } of parsed_events.map((x, event_i) => ({
    ...x,
    event_i,
  }))) {
    await trx.set_event(event_i, type, data);
    await process_event(event_t, event_i, { type, data }, trx);
  }
  await client.query("select pg_notify($1,$2)", ["event_stream", event_t]);
  await client.query("commit");
  client.release(true);
}

export async function start_processing(pool: pool, when_done: () => void) {
  console.log("starting ...");
  let event_t = await get_self_event_t(pool);
  const initial_event_t = await fetch_event_t();
  console.log({ event_t, initial_event_t });
  assert(event_t <= initial_event_t);
  while (event_t < initial_event_t) {
    event_t += 1;
    console.log({ waiting_for_event: event_t });
    const events = await fetch_events(event_t);
    console.log(JSON.stringify({ event_t, events }, undefined, 2));
    await process_events(event_t, events, pool);
  }
  when_done();
  while (true) {
    event_t += 1;
    console.log({ waiting_for_event: event_t });
    const events = await fetch_events(event_t);
    console.log(JSON.stringify({ event_t, events }, undefined, 2));
    await process_events(event_t, events, pool);
  }
}
