create table clock (
  event_t bigint not null primary key
);

create table event (
  event_t bigint not null,
  event_i int not null,
  event_type text not null,
  event_data jsonb not null,
  primary key (event_t, event_i),
  foreign key (event_t) references clock (event_t)
);

create table object_rev (
  event_t bigint not null,
  event_i int not null,
  object_type text not null,
  object_id text not null,
  object_data jsonb null,
  primary key (event_t, event_i, object_type, object_id),
  foreign key (event_t, event_i) references event (event_t, event_i)
);
