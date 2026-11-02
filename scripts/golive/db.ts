/**
 * GL1: the bridge DEV database, read and cleaned directly over Postgres.
 *
 * GL_BRIDGE_DATABASE_URL is the dev project's SESSION-mode connection string
 * (port 5432). It is never the production project: every script runs
 * `guardDatabase()` first, which refuses a database with real orders or a
 * production-sized roster (lib.ts checkDatabaseLooksDev).
 *
 * The seed writes through the deployment's own API (the CRM's onboarding
 * path). Only reading device keys/logins for the simulator, the row counts,
 * and the teardown come here - the API has no delete routes, by design.
 */
import pg from "pg";
import {
  checkDatabaseLooksDev,
  GL_DEVICE_NAME,
  GL_DEVICE_REF_PREFIX,
  GL_NAME_PREFIX,
  USERNAME_DOMAIN_SUFFIX,
  type Counts,
  type DbActivity,
} from "./lib";

export type Db = pg.Client;

export async function connect(): Promise<Db> {
  const url = process.env.GL_BRIDGE_DATABASE_URL;
  if (!url) throw new Error("GL_BRIDGE_DATABASE_URL is required (bridge DEV project, session-mode, port 5432)");
  const client = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

const LIKE_GL = GL_NAME_PREFIX.replace(/[\\%_[\]]/g, (c) => "\\" + c) + "%";

export async function activity(db: Db): Promise<DbActivity> {
  const r = await db.query(
    `select
       (select count(*) from restaurants where name not like $1)::int as real_restaurants,
       (select count(*) from orders o join restaurants r on r.id = o.restaurant_id
         where r.name not like $1 and o.source <> 'test' and o.received_at > now() - interval '7 days')::int as real_orders`,
    [LIKE_GL]
  );
  return { realRestaurants: r.rows[0].real_restaurants, realOrders7d: r.rows[0].real_orders };
}

/** Throws unless this is a dev-looking database. Run before anything else. */
export async function guardDatabase(db: Db): Promise<DbActivity> {
  const a = await activity(db);
  const refusal = checkDatabaseLooksDev(a);
  if (refusal) throw new Error(`REFUSED: ${refusal}`);
  return a;
}

export async function allRestaurantIds(db: Db): Promise<string[]> {
  return (await db.query(`select id::text from restaurants`)).rows.map((r) => r.id);
}

export async function glRestaurantIds(db: Db): Promise<string[]> {
  return (await db.query(`select id::text from restaurants where name like $1`, [LIKE_GL])).rows.map((r) => r.id);
}

export interface SimTarget {
  restaurant_id: string;
  device_ref: string | null;
  crm_restaurant_id: string | null;
  name: string;
  device_key: string | null;
  username: string | null;
  password: string | null;
}

/** What the simulator needs per synthetic restaurant: the printer's key and the tablet login. */
export async function simTargets(db: Db): Promise<SimTarget[]> {
  const r = await db.query(
    `select r.id::text as restaurant_id, r.crm_restaurant_id::text, r.name,
            (select pd.device_key from print_devices pd
              where pd.restaurant_id = r.id and pd.name = $2 and pd.is_active
              order by pd.created_at limit 1) as device_key,
            (select u.email from restaurant_users ru join auth.users u on u.id = ru.auth_user_id
              where ru.restaurant_id = r.id order by ru.created_at limit 1) as email,
            (select ru.password_current from restaurant_users ru
              where ru.restaurant_id = r.id order by ru.created_at limit 1) as password,
            (select kd.device_ref from kiosk_devices kd
              where kd.restaurant_id = r.id and kd.device_ref like $3 order by kd.device_ref limit 1) as device_ref
       from restaurants r where r.name like $1 order by r.name`,
    [LIKE_GL, GL_DEVICE_NAME, GL_DEVICE_REF_PREFIX.replace(/[\\%_]/g, (c) => "\\" + c) + "%"]
  );
  return r.rows.map((x) => ({
    restaurant_id: x.restaurant_id,
    device_ref: x.device_ref,
    crm_restaurant_id: x.crm_restaurant_id,
    name: x.name,
    device_key: x.device_key,
    username: typeof x.email === "string" && x.email.endsWith(USERNAME_DOMAIN_SUFFIX) ? x.email.slice(0, -USERNAME_DOMAIN_SUFFIX.length) : x.email,
    password: x.password,
  }));
}

/** Exact row counts of every public table and the auth tables a login touches. */
export async function tableCounts(db: Db): Promise<Counts> {
  const tables = (
    await db.query(
      `select quote_ident(schemaname) || '.' || quote_ident(relname) as t from pg_stat_user_tables
        where schemaname = 'public'
           or (schemaname = 'auth' and relname in ('users','identities','sessions','refresh_tokens','one_time_tokens','audit_log_entries','mfa_factors'))
        order by 1`
    )
  ).rows.map((r) => r.t as string);
  const out: Counts = {};
  for (const t of tables) out[t] = (await db.query(`select count(*)::int as n from ${t}`)).rows[0].n;
  return out;
}

interface Fk {
  child: string;
  childCol: string;
  parentCol: string;
}

async function fksReferencing(db: Db, table: string): Promise<Fk[]> {
  const r = await db.query(
    `select c.conrelid::regclass::text as child, a.attname as child_col, af.attname as parent_col
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       join pg_attribute af on af.attrelid = c.confrelid and af.attnum = c.confkey[1]
      where c.contype = 'f' and c.confrelid = $1::regclass and array_length(c.conkey, 1) = 1`,
    [table]
  );
  return r.rows.map((x) => ({ child: x.child, childCol: x.child_col, parentCol: x.parent_col }));
}

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Delete rows of `table` whose `col` is in `values`, children first, following
 * every foreign key down. Children are deleted explicitly rather than left to
 * ON DELETE: several tables point at restaurants with SET NULL (audit rows,
 * kiosk devices, ezCater staging), and a set-null child is a row left behind.
 */
async function deleteTree(db: Db, table: string, col: string, values: string[], tally: Counts, depth = 0): Promise<void> {
  if (!values.length) return;
  if (depth > 8) throw new Error(`foreign-key chain deeper than 8 at ${table}`);
  for (const fk of await fksReferencing(db, table)) {
    if (fk.child === table) continue; // self-reference: the rows go together
    const keys = (
      await db.query(`select distinct ${qi(fk.parentCol)}::text as k from ${table} where ${qi(col)}::text = any($1::text[]) and ${qi(fk.parentCol)} is not null`, [values])
    ).rows.map((r) => r.k);
    await deleteTree(db, fk.child, fk.childCol, keys, tally, depth + 1);
  }
  const res = await db.query(`delete from ${table} where ${qi(col)}::text = any($1::text[])`, [values]);
  tally[table] = (tally[table] ?? 0) + (res.rowCount ?? 0);
}

/**
 * Remove every synthetic row: the [GL] restaurants and everything hanging off
 * them, their tablet logins in auth, the simulated tablets' kiosk rows, and
 * the auth audit entries those logins wrote. One transaction: all or nothing.
 */
export async function teardown(db: Db): Promise<Counts> {
  const tally: Counts = {};
  await db.query("begin");
  try {
    const ids = await glRestaurantIds(db);
    const users = ids.length
      ? (await db.query(`select distinct auth_user_id::text as u from restaurant_users where restaurant_id::text = any($1::text[])`, [ids])).rows.map((r) => r.u)
      : [];

    const likeRef = GL_DEVICE_REF_PREFIX.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    for (const t of ["kiosk_bootstrap_log", "kiosk_devices"]) {
      const exists = (await db.query(`select to_regclass($1) as r`, [`public.${t}`])).rows[0].r;
      if (!exists) continue;
      const res = await db.query(`delete from public.${t} where device_ref like $1`, [likeRef]);
      tally[`public.${t}`] = (tally[`public.${t}`] ?? 0) + (res.rowCount ?? 0);
    }

    await deleteTree(db, "public.restaurants", "id", ids, tally);

    // Only logins no non-GL restaurant still uses (there should be none).
    const orphans = users.length
      ? (
          await db.query(
            `select id::text from auth.users u where id::text = any($1::text[])
               and not exists (select 1 from restaurant_users ru where ru.auth_user_id = u.id)`,
            [users]
          )
        ).rows.map((r) => r.id)
      : [];
    if (orphans.length) {
      const audit = await db.query(
        `delete from auth.audit_log_entries where payload->>'actor_id' = any($1::text[])
            or payload->'traits'->>'user_id' = any($1::text[])`,
        [orphans]
      );
      tally["auth.audit_log_entries"] = audit.rowCount ?? 0;
      await deleteTree(db, "auth.users", "id", orphans, tally);
    }
    await db.query("commit");
  } catch (err) {
    await db.query("rollback");
    throw err;
  }
  return tally;
}

/** Print jobs and orders at the synthetic restaurants since `since`, for latency. */
export async function glJobs(db: Db, since: string) {
  return (
    await db.query(
      `select o.id::text as order_id, o.order_number, o.received_at, o.accepted_at,
              j.status, j.queued_at, j.finished_at, j.delivery
         from orders o join restaurants r on r.id = o.restaurant_id
         left join print_jobs j on j.order_id = o.id
        where r.name like $1 and o.received_at >= $2
        order by o.received_at`,
      [LIKE_GL, since]
    )
  ).rows as {
    order_id: string;
    order_number: string;
    received_at: Date;
    accepted_at: Date | null;
    status: string | null;
    queued_at: Date | null;
    finished_at: Date | null;
    delivery: string | null;
  }[];
}
