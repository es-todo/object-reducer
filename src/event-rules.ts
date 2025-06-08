import {
  parse_event_type,
  type event_type,
} from "schemata/generated/event_type";
import { type object_type } from "schemata/generated/object_type";
import { Transaction } from "./transaction.ts";
import { difference } from "./set-functions.ts";

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
      fk: fk ?? (() => ({ type: "failed", reason: `${type}:${id} not found` })),
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

function link_user(user_id: string) {
  return fetch(
    "users_ll",
    "root",
    ({ next }) =>
      seq([
        create("users_ll", user_id, { next }),
        update("users_ll", "root", { next: user_id }),
      ]),
    () =>
      seq([
        create("users_ll", user_id, { next: null }),
        create("users_ll", "root", { next: user_id }),
      ])
  );
}

function enqueue_seq(message_id: string) {
  function do_link(prev: string) {
    return seq([
      create("email_message_queue_entry", message_id, { prev, next: "*" }),
      fetch("email_message_queue_entry", prev, (data) =>
        update("email_message_queue_entry", prev, { ...data, next: message_id })
      ),
      fetch("email_message_queue_entry", "*", (data) =>
        update("email_message_queue_entry", "*", { ...data, prev: message_id })
      ),
    ]);
  }
  return fetch(
    "email_message_queue_entry",
    "*",
    ({ prev }) => do_link(prev),
    () =>
      seq([
        create("email_message_queue_entry", "*", { prev: "*", next: "*" }),
        do_link("*"),
      ])
  );
}
function dequeue_seq(message_id: string) {
  return fetch("email_message_queue_entry", message_id, ({ prev, next }) =>
    seq([
      fetch("email_message_queue_entry", prev, (data) =>
        update("email_message_queue_entry", prev, { ...data, next })
      ),
      fetch("email_message_queue_entry", next, (data) =>
        update("email_message_queue_entry", next, { ...data, prev })
      ),
      del("email_message_queue_entry", message_id),
    ])
  );
}

const event_rules: event_rules = {
  user_registered: Event({
    handler: ({ user_id, username, realname, email, password }) =>
      fetch(
        "user",
        user_id,
        () => fail("user_id already taken"),
        () =>
          seq([
            create("user", user_id, { email, username, realname }),
            create("username", username, { user_id }),
            create("email", email, { user_id, confirmed: false }),
            create("credentials", user_id, { password }),
            link_user(user_id),
          ])
      ),
  }),
  email_confirmation_code_generated: Event({
    handler: ({ user_id, email, code }) =>
      create("email_confirmation_code", code, {
        user_id,
        email,
        received: false,
      }),
  }),
  email_confirmation_code_received: Event({
    handler: ({ code }) =>
      fetch("email_confirmation_code", code, (conf) =>
        seq([
          fetch("email", conf.email, (email_data) =>
            update("email", conf.email, { ...email_data, confirmed: true })
          ),
          update("email_confirmation_code", code, { ...conf, received: true }),
        ])
      ),
  }),
  password_reset_code_generated: Event({
    handler: () => fail("not implemented"),
  }),
  user_roles_changed: Event({
    handler: ({ user_id, roles: new_roles }) => {
      function add_user(role: string): action {
        return fetch(
          "role_users",
          role,
          ({ user_ids }) =>
            update("role_users", role, { user_ids: [...user_ids, user_id] }),
          () => create("role_users", role, { user_ids: [user_id] })
        );
      }
      function remove_user(role: string): action {
        return fetch("role_users", role, ({ user_ids }) =>
          update("role_users", role, {
            user_ids: user_ids.filter((x) => x !== user_id),
          })
        );
      }
      function update_roles(old_roles: string[]): action {
        const removed_roles = difference(old_roles, new_roles);
        const added_roles = difference(new_roles, old_roles);
        return seq([
          ...removed_roles.map(remove_user),
          ...added_roles.map(add_user),
          update("user_roles", user_id, { roles: new_roles }),
        ]);
      }
      return fetch(
        "user_roles",
        user_id,
        ({ roles }) => update_roles(roles),
        () => update_roles([])
      );
    },
  }),
  email_message_enqueued: Event({
    handler: ({ message_id, user_id, email, content }) =>
      seq([
        create("email_message", message_id, {
          user_id,
          email,
          content,
          status: { type: "queued" },
        }),
        enqueue_seq(message_id),
      ]),
  }),
  email_message_dequeued: Event({
    handler: ({ message_id, status }) =>
      seq([
        fetch("email_message", message_id, (data) =>
          update("email_message", message_id, {
            ...data,
            status: status.success
              ? { type: "sent" }
              : { type: "failed", reason: status.reason },
          })
        ),
        dequeue_seq(message_id),
      ]),
  }),
  user_realname_changed: Event({
    handler: () => fail("not implemented"),
  }),
  user_username_changed: Event({
    handler: () => fail("not implemented"),
  }),
  //user_name_changed: Event({
  //  handler: ({ user_id, new_name }) =>
  //    fetch("user", user_id, (user) =>
  //      update("user", user_id, { ...user, name: new_name })
  //    ),
  //}),
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
  board_created: Event({
    handler: ({ user_id, board_id, board_name }) =>
      seq([
        create("board", board_id, { name: board_name, user_id }),
        fetch(
          "user_boards",
          user_id,
          ({ list }) =>
            update("user_boards", user_id, { list: [...list, board_id] }),
          () => update("user_boards", user_id, { list: [board_id] })
        ),
      ]),
  }),
  board_renamed: Event({
    handler: ({ board_id, board_name }) =>
      fetch("board", board_id, (data) =>
        update("board", board_id, { ...data, name: board_name })
      ),
  }),
};

async function finalize(
  event_type: string,
  action: action,
  trx: Transaction
): Promise<void> {
  switch (action.type) {
    case "fetch": {
      const { type, id, sk, fk } = action.desc;
      const value = await trx.fetch(type, id);
      console.log({ type, id, value });
      if (value === null) {
        return finalize(event_type, fk(), trx);
      } else {
        return finalize(event_type, sk(value), trx);
      }
    }
    case "seq": {
      for (const x of action.seq) {
        await finalize(event_type, x, trx);
      }
      return;
    }
    case "change": {
      return trx.change(action);
    }
    case "failed": {
      throw new Error(`${event_type} failed: ${action.reason}`);
    }
    default:
      const invalid: never = action;
      throw invalid;
  }
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
    event.type,
    insp(({ handler }) => handler(c.data as any)),
    trx
  );
}
