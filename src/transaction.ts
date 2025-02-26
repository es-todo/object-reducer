import assert from "node:assert";
import pg from "pg";
import { parse_object_type } from "schemata/generated/object_type";

export class Transaction {
  client: pg.PoolClient;
  cache: Map<
    string,
    Map<string, { event_t: number; event_i: number; value: any }>
  > = new Map();
  event_t: number | undefined;
  event_i: number | undefined;

  constructor(client: pg.PoolClient) {
    this.client = client;
  }

  public async set_clock(event_t: number) {
    assert(this.event_t === undefined);
    await this.client.query("insert into clock (event_t) values ($1)", [
      event_t,
    ]);
    this.event_t = event_t;
  }

  public async set_event(event_i: number, event_type: string, event_data: any) {
    assert(this.event_t !== undefined);
    assert(
      this.event_i === undefined ? event_i === 0 : event_i === this.event_i + 1
    );
    await this.client.query(
      `insert into event (event_t, event_i, event_type, event_data)
        values ($1, $2, $3, $4)`,
      [this.event_t, event_i, event_type, event_data]
    );
    this.event_i = event_i;
  }

  public async fetch(type: string, id: string) {
    const cached = this.cache.get(type)?.get(id);
    if (cached !== undefined) return cached;
    const res = await this.client.query(
      `select event_t, event_i, object_data as data from object_rev
         where object_type = $1 and object_id = $2
         order by event_t desc, event_i desc limit 1`,
      [type, id]
    );
    const row: { event_t: string; event_i: string; data: any } =
      res.rows.length === 0
        ? { event_t: 0, event_i: 0, data: null }
        : res.rows[0];
    const c0 =
      this.cache.get(type) ??
      ((m) => {
        this.cache.set(type, m);
        return m;
      })(new Map<string, { event_t: number; event_i: number; value: any }>());
    c0.set(id, {
      event_t: parseInt(row.event_t),
      event_i: parseInt(row.event_i),
      value: row.data,
    });
    return row.data;
  }

  public async change(x: {
    object_type: string;
    object_id: string;
    object_data: any;
  }) {
    const id = x.object_id;
    const { type, data } = parse_object_type({
      type: x.object_type,
      data: x.object_data,
    });
    const cached = this.cache.get(type)?.get(id);
    const event_t = this.event_t;
    const event_i = this.event_i;
    assert(event_t !== undefined);
    assert(event_i !== undefined);
    if (cached && cached.event_t === event_t && cached.event_i === event_i) {
      throw new Error("second change");
    } else {
      await this.client.query(
        `insert into object_rev
            (event_t, event_i, object_type, object_id, object_data)
            values ($1, $2, $3, $4, $5)`,
        [event_t, event_i, type, id, data]
      );
    }
    const c0 =
      this.cache.get(type) ??
      ((m) => {
        this.cache.set(type, m);
        return m;
      })(new Map<string, { event_t: number; event_i: number; value: any }>());
    c0.set(id, { event_t, event_i, value: data });
  }
}
