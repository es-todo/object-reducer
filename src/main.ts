import express from "express";
import body_parser from "body-parser";
import pg from "pg";
import { start_processing } from "./event-processor.ts";
import { EventMonitor } from "./event-monitor.ts";

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

const event_monitor = new EventMonitor(pool);

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
  console.log({ someonewaiting: t });
  await event_monitor.wait_events(t);
  console.log({ waiter_released: t });
  res.status(200).send("ok");
  return;
});

app.get("/object-apis/get-t", async (req, res) => {
  const t = await event_monitor.get_t();
  res.status(200).json(t);
  return;
});

app.get("/object-apis/poll-change-set", async (req, res) => {
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
  await event_monitor.wait_events(t);
  const out = await pool.query(
    `
    select event_i as i, object_type as type, object_id as id, object_data as data
    from object_rev where event_t = $1
    order by event_i
    `,
    [t]
  );
  res.status(200).json(out.rows);
  return;
});

app.get("/object-apis/get-object", async (req, res) => {
  const { type, id } = req.query;
  if (typeof type !== "string" || typeof id !== "string") {
    res.status(401).send("invalid request");
    return;
  }
  const out = await pool.query(
    `select event_t as t, event_i as i, object_data as data from object_rev
       where object_type = $1 and object_id = $2
       order by event_t desc, event_i desc
       limit 1`,
    [type, id]
  );
  if (out.rows.length === 0 || out.rows[0].data === null) {
    res.status(200).json({ found: false });
  } else {
    const row = out.rows[0];
    res
      .status(200)
      .json({ found: true, t: parseInt(row.t), i: row.i, data: row.data });
  }
});

start_processing(pool, () =>
  app.listen(port, () => {
    console.log(`events server listening on port ${port}`);
  })
);
