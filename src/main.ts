import express from "express";
import body_parser from "body-parser";
import {
  type object_type,
  parse_object_type,
} from "schemata/generated/object_type";
import pg from "pg";
import { start_processing } from "./event-processor.ts";

const port = 3000;
const db_user = "admin";
const db_pass = "letmein";
const db_name = "objectdb";

const pool = new pg.Pool({
  user: db_user,
  password: db_pass,
  database: db_name,
});

const app = express();
app.use(body_parser.json());

app.get("/", async (_req, res) => {
  try {
    const pgres = await pool.query("SELECT NOW() as t");
    res.send(`Hello World! Time is ${pgres.rows[0].t}`);
  } catch (err) {
    res.json(err);
  }
});

const t_waiters: Map<number, Set<() => void>> = new Map();
let event_t: number | undefined = undefined;
const event_t_waiters: Array<(t: number) => void> = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function init_event_t() {
  const t = await (async () => {
    try {
      const outcome = await pool.query(
        "select coalesce(max(event_t), 0) as t from clock"
      );
      return parseInt(outcome.rows[0].t);
    } catch (error: any) {
      console.error("failed to init event_t");
      console.error(error);
    }
  })();
  if (t === undefined) {
    if (event_t === undefined) {
      await sleep(1000);
      return init_event_t();
    }
  } else {
    if (event_t === undefined) {
      event_t = t;
      event_t_waiters.forEach((f) => f(t));
      event_t_waiters.splice(0, event_t_waiters.length);
      for (const t of t_waiters.keys()) {
        if (t <= event_t) {
          const s = t_waiters.get(t);
          t_waiters.delete(t);
          if (s) {
            for (const f of s) {
              f();
            }
          }
        }
      }
    }
  }
}

init_event_t();

function wait_t(t: number): Promise<void> {
  return new Promise((resolve) => {
    if (event_t === undefined) {
      event_t_waiters.push((current_t) => {
        if (t <= current_t) {
          resolve();
        } else {
          const s =
            t_waiters.get(t) ??
            (() => {
              const s = new Set<() => void>();
              t_waiters.set(t, s);
              return s;
            })();
          s.add(resolve);
        }
      });
    } else if (t <= event_t) {
      resolve();
    } else {
      const s =
        t_waiters.get(t) ??
        (() => {
          const s = new Set<() => void>();
          t_waiters.set(t, s);
          return s;
        })();
      s.add(resolve);
    }
  });
}

app.get("/object-apis/wait-t", async (req, res) => {
  const t_str = ((t) => (typeof t === "string" ? t : ""))(req.query.t);
  if (!t_str.match(/^\d+$/)) {
    res.status(401).send("invalid t");
    return;
  }
  const t = parseInt(t_str);
  if (Number.isNaN(t) || t > Number.MAX_SAFE_INTEGER) {
    res.status(401).send("invalid t");
    return;
  }
  await wait_t(t);
  res.status(200).send("ok");
  return;
});

app.get("/object-apis/get-object", async (req, res) => {
  const { type, id } = req.query;
  if (typeof type !== "string" || typeof id !== "string") {
    res.status(401).send("invalid request");
    return;
  }
  const out = await pool.query(
    `select object_data as data from object_rev
       where object_type = $1 and object_id = $2
       order by event_t desc, event_i desc
       limit 1`,
    [type, id]
  );
  if (out.rows.length === 0 || out.rows[0].data === null) {
    res.status(200).json({ found: false });
  } else {
    res.status(200).json({ found: true, data: out.rows[0].data });
  }
});

start_processing(pool, () =>
  app.listen(port, () => {
    console.log(`events server listening on port ${port}`);
  })
);
