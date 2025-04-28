import {
  parse_event_type,
  type event_type,
} from "schemata/generated/event_type";
import { type object_type } from "schemata/generated/object_type";
import { parse_object_type } from "schemata/generated/object_type";
import { sleep } from "./sleep.ts";
import axios from "axios";
import { Transaction } from "./transaction.ts";

type fetch_func<k> = {
  type: k;
  id: string;
  sk: (v: object_val<k>) => action;
  fk: () => action;
};

type fetch_desc = fetch_func<object_type["type"]>;
type object_val<T> = (object_type & { type: T })["data"];

function fetch<T extends object_type["type"]>(
  type: T,
  id: string,
  sk: (val: object_val<T>) => action,
  fk?: () => action
): action {
  return {
    type: "fetch",
    desc: {
      type,
      id,
      sk: (v) => sk(v as any),
      fk: fk ?? (() => ({ type: "failed", reason: "not found" })),
    },
  };
}

type action =
  | { type: "fetch"; desc: fetch_desc }
  | {
      type: "change";
      object_type: object_type["type"];
      object_id: string;
      object_data: any;
    }
  | { type: "seq"; seq: action[] }
  | { type: "failed"; reason: string };

function create<T extends object_type["type"]>(
  type: T,
  id: string,
  data: (object_type & { type: T })["data"]
): action {
  return {
    type: "change",
    object_type: type,
    object_id: id,
    object_data: data,
  };
}

function update<T extends object_type["type"]>(
  type: T,
  id: string,
  data: (object_type & { type: T })["data"]
): action {
  return {
    type: "change",
    object_type: type,
    object_id: id,
    object_data: data,
  };
}

function del<T extends object_type["type"]>(type: T, id: string): action {
  return {
    type: "change",
    object_type: type,
    object_id: id,
    object_data: null,
  };
}

function seq(outs: action[]): action {
  return { type: "seq", seq: outs };
}

function fail(reason: string) {
  return { type: "failed" as const, reason };
}

type dispatch<k extends event_type["type"]> = (
  args: (event_type & { type: k })["data"]
) => action;

type event_rules = {
  [k in event_type["type"]]: <R>(inspect: inspector<k, R>) => R;
};

type inspector<T extends event_type["type"], R> = (args: {
  handler: dispatch<T>;
}) => R;

type Event<T extends event_type["type"]> = <R>(inspector: inspector<T, R>) => R;

function Event<T extends event_type["type"]>(args: { handler: dispatch<T> }) {
  return <R>(inspect: inspector<T, R>) => inspect(args);
}

const event_rules: event_rules = {
  user_registered: Event({
    handler: ({ user_id, email, salted_hash }) =>
      fetch(
        "user",
        user_id,
        () => fail("user_id already taken"),
        () =>
          fetch(
            "email",
            email,
            () => fail("email already taken"),
            () =>
              seq([
                create("user", user_id, { email, salted_hash }),
                create("email", email, { user_id }),
              ])
          )
      ),
  }),
  user_email_changed: Event({
    handler: () => fail("not implemented"),
  }),
  ping: Event({
    handler: () =>
      fetch(
        "counter",
        "ping",
        ({ count }) => update("counter", "ping", { count: count + 1 }),
        () => create("counter", "ping", { count: 1 })
      ),
  }),
};

async function finalize(action: action, trx: Transaction): Promise<void> {
  switch (action.type) {
    case "fetch": {
      const { type, id, sk, fk } = action.desc;
      const value = await trx.fetch(type, id);
      console.log({ type, id, value });
      if (value === null) {
        return finalize(fk(), trx);
      } else {
        return finalize(sk(value), trx);
      }
    }
    case "seq": {
      return Promise.all(action.seq.map((x) => finalize(x, trx))).then(
        () => {}
      );
    }
    case "change": {
      return trx.change(action);
    }
    default:
      throw new Error(`action ${action.type} not implemented`);
  }
  //switch (out.type) {
  //  case "fetch": {
  //    const { type, id, sk, fk } = out.desc;
  //    const res = await fetch_object(type, id);
  //    if (res.found) {
  //      const o = parse_object_type({ type, value: res.data });
  //      return finalize(sk(o.value));
  //    } else {
  //      return finalize(fk());
  //    }
  //  }
  //  case "succeeded":
  //  case "failed":
  //    return out;
  //  default:
  //    const invalid: never = out;
  //    throw invalid;
  //}
}

export async function process_event(
  event_t: number,
  event_i: number,
  event: {
    type: string;
    data: any;
  },
  trx: Transaction
): Promise<void> {
  const c = parse_event_type(event);
  const insp = event_rules[c.type];
  return finalize(
    insp(({ handler }) => handler(c.data as any)),
    trx
  );
}
