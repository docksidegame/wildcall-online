// Postgres via DATABASE_URL in production; embedded PGlite (Postgres in WASM) for local dev.
let q=null;
export let DB_KIND='none';
export async function initDb(){
  if(process.env.DATABASE_URL){
    const pg=(await import('pg')).default;
    const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==='disable'?false:{rejectUnauthorized:false},max:10});
    q=(text,params)=>pool.query(text,params).then(r=>r.rows);
    DB_KIND='postgres';console.log('[db] using Postgres');
  }else{
    const {PGlite}=await import('@electric-sql/pglite');
    const dir=process.env.PGLITE_DIR||'./data/pglite';
    const db=new PGlite(dir);await db.waitReady;
    q=(text,params)=>db.query(text,params).then(r=>r.rows);
    DB_KIND='pglite';console.log('[db] using embedded PGlite at',dir,'(set DATABASE_URL for production)');
  }
  await migrate();
}
export const sql=(text,params=[])=>q(text,params);
async function migrate(){
  await sql(`create table if not exists users(
    id serial primary key, username text not null, uname text not null unique, email text not null unique,
    pass text not null, admin boolean not null default false, banned boolean not null default false,
    rating int not null default 1000, wins int not null default 0, losses int not null default 0,
    save jsonb, daily jsonb not null default '{}', settings jsonb not null default '{}',
    created_at timestamptz not null default now(), last_seen timestamptz)`);
  await sql(`create table if not exists sessions(token text primary key, user_id int not null references users(id) on delete cascade, expires timestamptz not null)`);
  await sql(`create table if not exists config(key text primary key, value jsonb not null)`);
  await sql(`create table if not exists matches(id serial primary key, p1 int, p2 int, winner int, r1_before int, r2_before int, r1_after int, r2_after int, stake int not null default 0, turns int, reason text, created_at timestamptz not null default now())`);
  await sql(`create table if not exists audit(id serial primary key, admin_id int, action text, detail jsonb, created_at timestamptz not null default now())`);
  await sql(`create index if not exists users_rating on users(rating desc)`);
  await sql(`create table if not exists match_decks(id serial primary key, source text not null, user_id int, bot boolean not null default false, won boolean not null, went_first boolean, cards jsonb not null, turns int, rival text, created_at timestamptz not null default now())`);
  await sql(`create index if not exists match_decks_time on match_decks(created_at)`);
}
