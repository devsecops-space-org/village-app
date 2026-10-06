-- Pit Control: esquema, reglas de negocio y seguridad.
-- Las tablas viven en `private`, un esquema que la Data API no expone. El navegador
-- solo puede ejecutar las funciones de `public` definidas al final, y cada una
-- verifica la sesión y el rol antes de tocar datos.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------- tablas

create table private.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9._-]{3,50}$'),
  name text not null check (char_length(name) between 1 and 100 and name !~ '[[:cntrl:]]'),
  role text not null check (role in ('admin', 'staff'))
);

create table private.participants (
  id uuid primary key default gen_random_uuid(),
  badge_hash text not null unique check (badge_hash ~ '^[a-f0-9]{64}$'),
  name text not null check (char_length(name) between 2 and 100 and name !~ '[[:cntrl:]]'),
  email text not null default '' check (
    email = '' or (char_length(email) <= 254 and email ~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+\.[^@[:space:][:cntrl:]]+$')
  ),
  company text not null default '' check (char_length(company) <= 120 and company !~ '[[:cntrl:]]'),
  job text not null default '' check (char_length(job) <= 100 and job !~ '[[:cntrl:]]'),
  consent_at timestamptz not null default now(),
  raffle_consent boolean not null,
  created_at timestamptz not null default now(),
  interest text not null default '' check (interest in ('', 'AppSec', 'Pipelines', 'Cloud', 'Capacitación', 'Comunidad')),
  note text not null default '' check (char_length(note) <= 500 and note !~ '[[:cntrl:]]'),
  feedback text not null default '' check (char_length(feedback) <= 250 and feedback !~ '[[:cntrl:]]'),
  rooketh_contact boolean not null default false
);
create index participants_created on private.participants (created_at desc);

create table private.visits (
  participant_id uuid not null references private.participants (id),
  pit text not null check (pit in ('race', 'daytona', 'knowledge', 'merch', 'photo', 'refuel')),
  staff_id uuid not null references private.profiles (id),
  created_at timestamptz not null default now(),
  primary key (participant_id, pit)
);
create index visits_created on private.visits (created_at);

create table private.redemptions (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references private.participants (id),
  day date not null,
  staff_id uuid not null references private.profiles (id),
  created_at timestamptz not null default now(),
  age_verified boolean not null check (age_verified),
  unique (participant_id, day)
);

create table private.draws (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  prize text not null check (char_length(prize) between 2 and 100 and prize !~ '[[:cntrl:]]'),
  winner_id uuid not null references private.participants (id),
  snapshot jsonb not null,
  ticket bigint not null,
  total_weight bigint not null,
  staff_id uuid not null references private.profiles (id),
  created_at timestamptz not null default now()
);
create index draws_winner on private.draws (winner_id);

create table private.audit (
  id bigint generated always as identity primary key,
  staff_id uuid references private.profiles (id),
  action text not null,
  entity_id uuid,
  created_at timestamptz not null default now()
);

-- RLS sin políticas: aunque alguien exponga el esquema o conceda permisos por
-- error, ningún rol de la API puede leer ni escribir filas directamente.
alter table private.profiles enable row level security;
alter table private.participants enable row level security;
alter table private.visits enable row level security;
alter table private.redemptions enable row level security;
alter table private.draws enable row level security;
alter table private.audit enable row level security;
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------- auxiliares

create function private.fail(p_status int, p_message text) returns void
language plpgsql set search_path = '' as $$
begin
  -- PostgREST convierte SQLSTATE PTxxx en el código HTTP xxx.
  raise exception using errcode = 'PT' || p_status::text, message = p_message;
end $$;

-- El rol sale siempre de la tabla de perfiles, nunca del JWT ni de metadatos
-- que el usuario pueda editar.
create function private.staff_id(need_admin boolean default false) returns uuid
language plpgsql stable set search_path = '' as $$
declare
  uid uuid := auth.uid();
  found_role text;
begin
  if uid is null then
    perform private.fail(401, 'Iniciá sesión para continuar');
  end if;
  select p.role into found_role from private.profiles p where p.id = uid;
  if found_role is null then
    perform private.fail(401, 'Iniciá sesión para continuar');
  end if;
  if need_admin and found_role <> 'admin' then
    perform private.fail(403, 'Esta acción requiere un administrador');
  end if;
  return uid;
end $$;

create function private.event_day() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'America/Argentina/Buenos_Aires')::date
$$;

create function private.log(p_staff uuid, p_action text, p_entity uuid default null) returns void
language sql set search_path = '' as $$
  insert into private.audit (staff_id, action, entity_id) values (p_staff, p_action, p_entity)
$$;

create function private.participant_json(pid uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'email', p.email,
    'company', p.company,
    'job', p.job,
    'createdAt', p.created_at,
    'raffleConsent', p.raffle_consent,
    'visits', coalesce((
      select jsonb_agg(jsonb_build_object('pit', v.pit, 'createdAt', v.created_at) order by v.created_at)
      from private.visits v where v.participant_id = p.id
    ), '[]'::jsonb),
    'chances', 1 + (select count(*) from private.visits v where v.participant_id = p.id and v.pit <> 'refuel'),
    'interest', p.interest,
    'note', p.note,
    'feedback', p.feedback,
    'rookethContact', p.rooketh_contact,
    'redeemedToday', exists (
      select 1 from private.redemptions r where r.participant_id = p.id and r.day = private.event_day()
    )
  )
  from private.participants p where p.id = pid
$$;

create function private.require_participant(pid uuid) returns void
language plpgsql stable set search_path = '' as $$
begin
  if pid is null or not exists (select 1 from private.participants p where p.id = pid) then
    perform private.fail(404, 'Visitante no encontrado');
  end if;
end $$;

-- Inscripción autorizada = 1 chance; cada PIT distinto sin Refuel suma 1.
create function private.candidates() returns table (id uuid, name text, weight bigint)
language sql stable set search_path = '' as $$
  select p.id, p.name,
    1 + (select count(*) from private.visits v where v.participant_id = p.id and v.pit <> 'refuel')
  from private.participants p
  where p.raffle_consent
    and not exists (select 1 from private.draws d where d.winner_id = p.id)
  order by p.id
$$;

-- Entero uniforme en [0, n) con bytes del CSPRNG; el muestreo por rechazo evita
-- el sesgo de módulo.
create function private.random_below(n bigint) returns bigint
language plpgsql volatile set search_path = '' as $$
declare
  span constant bigint := 281474976710656; -- 2^48
  cutoff bigint;
  value bigint;
begin
  if n is null or n < 1 or n >= span then
    raise exception 'Pesos inválidos';
  end if;
  cutoff := span - (span % n);
  loop
    value := ('x' || encode(extensions.gen_random_bytes(6), 'hex'))::bit(48)::bigint;
    if value < cutoff then
      return value % n;
    end if;
  end loop;
end $$;

create function private.draw_json(did uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', d.id,
    'prize', d.prize,
    'winnerId', d.winner_id,
    'winnerName', (select p.name from private.participants p where p.id = d.winner_id),
    'createdAt', d.created_at,
    'totalWeight', d.total_weight,
    'candidates', jsonb_array_length(d.snapshot),
    'ticket', d.ticket,
    'winnerWeight', (
      select (e ->> 'weight')::bigint from jsonb_array_elements(d.snapshot) e
      where e ->> 'id' = d.winner_id::text
    )
  )
  from private.draws d where d.id = did
$$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------- API (RPC)

create function public.me() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := private.staff_id();
begin
  return (select jsonb_build_object('id', p.id, 'name', p.name, 'role', p.role)
          from private.profiles p where p.id = uid);
end $$;

create function public.touch_login() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.log(private.staff_id(), 'login.success');
end $$;

create function public.lookup_badge(p_hash text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare pid uuid;
begin
  perform private.staff_id();
  if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' then
    perform private.fail(400, 'Datos inválidos');
  end if;
  select p.id into pid from private.participants p where p.badge_hash = p_hash;
  if pid is null then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('participant', private.participant_json(pid));
end $$;

create function public.get_participant(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.staff_id();
  perform private.require_participant(p_id);
  return private.participant_json(p_id);
end $$;

create function public.search_participants(p_q text default '', p_page int default 1) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  pattern text;
  total bigint;
  list jsonb;
begin
  perform private.staff_id();
  if char_length(coalesce(p_q, '')) > 100 or p_page is null or p_page < 1 or p_page > 100000 then
    perform private.fail(400, 'Datos inválidos');
  end if;
  pattern := '%' || regexp_replace(coalesce(p_q, ''), '([\\%_])', '\\\1', 'g') || '%';
  select count(*) into total from private.participants p
  where p.name ilike pattern or p.company ilike pattern or p.email ilike pattern;
  select coalesce(jsonb_agg(private.participant_json(s.id) order by s.created_at desc), '[]'::jsonb) into list
  from (
    select p.id, p.created_at from private.participants p
    where p.name ilike pattern or p.company ilike pattern or p.email ilike pattern
    order by p.created_at desc limit 40 offset (p_page - 1) * 40
  ) s;
  return jsonb_build_object('participants', list, 'total', total);
end $$;

create function public.register_participant(
  p_hash text, p_name text, p_email text, p_company text, p_job text,
  p_consent boolean, p_raffle_consent boolean
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.staff_id();
  pid uuid;
begin
  if p_consent is not true then
    perform private.fail(400, 'Necesitamos autorización para registrar la participación');
  end if;
  if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' or p_raffle_consent is null then
    perform private.fail(400, 'Datos inválidos');
  end if;
  if exists (select 1 from private.participants p where p.badge_hash = p_hash) then
    perform private.fail(409, 'Este badge ya está registrado. Buscá al visitante o volvé a escanear.');
  end if;
  begin
    insert into private.participants (badge_hash, name, email, company, job, raffle_consent)
    values (p_hash, btrim(coalesce(p_name, '')), btrim(coalesce(p_email, '')),
            btrim(coalesce(p_company, '')), btrim(coalesce(p_job, '')), p_raffle_consent)
    returning id into pid;
  exception
    when unique_violation then
      perform private.fail(409, 'Este badge ya está registrado. Buscá al visitante o volvé a escanear.');
    when check_violation then
      perform private.fail(400, 'Datos inválidos');
  end;
  perform private.log(uid, 'participant.created', pid);
  return private.participant_json(pid);
end $$;

create function public.update_notes(
  p_id uuid, p_interest text, p_note text, p_feedback text, p_rooketh_contact boolean
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := private.staff_id();
begin
  perform private.require_participant(p_id);
  if p_interest is null or p_note is null or p_feedback is null or p_rooketh_contact is null then
    perform private.fail(400, 'Datos inválidos');
  end if;
  begin
    update private.participants
    set interest = p_interest, note = btrim(p_note), feedback = btrim(p_feedback),
        rooketh_contact = p_rooketh_contact
    where id = p_id;
  exception when check_violation then
    perform private.fail(400, 'Datos inválidos');
  end;
  perform private.log(uid, 'participant.notes', p_id);
  return private.participant_json(p_id);
end $$;

create function public.add_visit(p_id uuid, p_pit text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.staff_id();
  inserted int;
begin
  if p_pit is null or p_pit not in ('race', 'daytona', 'knowledge', 'merch', 'photo', 'refuel') then
    perform private.fail(400, 'Datos inválidos');
  end if;
  if p_pit = 'refuel' then
    perform private.fail(400, 'Refuel se registra al confirmar el canje');
  end if;
  perform private.require_participant(p_id);
  insert into private.visits (participant_id, pit, staff_id) values (p_id, p_pit, uid)
  on conflict do nothing;
  get diagnostics inserted = row_count;
  if inserted > 0 then
    perform private.log(uid, 'visit.created', p_id);
  end if;
  return private.participant_json(p_id);
end $$;

create function public.redeem_refuel(p_id uuid, p_age_verified boolean, p_sticker_verified boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.staff_id();
  today date := private.event_day();
begin
  if p_age_verified is not true or p_sticker_verified is not true then
    perform private.fail(400, 'Datos inválidos');
  end if;
  perform private.require_participant(p_id);
  -- Serializa los canjes de la misma persona; la restricción UNIQUE es la garantía final.
  perform pg_advisory_xact_lock(hashtextextended('pit.refuel:' || p_id::text, 0));
  if exists (select 1 from private.redemptions r where r.participant_id = p_id and r.day = today) then
    perform private.fail(409, 'El canje de hoy ya fue registrado');
  end if;
  if not exists (select 1 from private.visits v where v.participant_id = p_id and v.pit <> 'refuel') then
    perform private.fail(400, 'Primero registrá una participación en otro PIT');
  end if;
  insert into private.redemptions (participant_id, day, staff_id, age_verified) values (p_id, today, uid, true);
  insert into private.visits (participant_id, pit, staff_id) values (p_id, 'refuel', uid)
  on conflict do nothing;
  perform private.log(uid, 'refuel.redeemed', p_id);
  return private.participant_json(p_id);
end $$;

create function public.get_summary() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.staff_id();
  return jsonb_build_object(
    'participants', (select count(*) from private.participants),
    'visits', (select count(*) from private.visits),
    'redemptions', (select count(*) from private.redemptions),
    'eligible', (select count(*) from private.candidates()),
    'pits', coalesce((
      select jsonb_agg(jsonb_build_object('pit', g.pit, 'count', g.n))
      from (select v.pit, count(*) as n from private.visits v group by v.pit) g
    ), '[]'::jsonb),
    'activity', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'action', a.action, 'createdAt', a.created_at, 'staff', a.staff) order by a.id desc)
      from (
        select au.id, au.action, au.created_at, pr.name as staff
        from private.audit au left join private.profiles pr on pr.id = au.staff_id
        order by au.id desc limit 12
      ) a
    ), '[]'::jsonb)
  );
end $$;

create function public.get_raffle() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.staff_id();
  return jsonb_build_object(
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'weight', c.weight) order by c.weight desc, c.name)
      from private.candidates() c
    ), '[]'::jsonb),
    'totalWeight', (select coalesce(sum(c.weight), 0) from private.candidates() c),
    'draws', coalesce((
      select jsonb_agg(private.draw_json(d.id) order by d.created_at desc) from private.draws d
    ), '[]'::jsonb)
  );
end $$;

create function public.draw_raffle(p_prize text, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.staff_id(true);
  v_prize text := btrim(coalesce(p_prize, ''));
  prior uuid;
  snap jsonb;
  total bigint;
  v_ticket bigint;
  winner uuid;
  did uuid;
begin
  if p_request_id is null or char_length(v_prize) < 2 or char_length(v_prize) > 100 or v_prize ~ '[[:cntrl:]]' then
    perform private.fail(400, 'Datos inválidos');
  end if;
  -- Un sorteo a la vez: padrón, ticket y ganador salen de la misma vista de datos.
  perform pg_advisory_xact_lock(hashtextextended('pit.raffle', 0));
  select d.id into prior from private.draws d where d.request_id = p_request_id;
  if prior is not null then
    return private.draw_json(prior);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'weight', c.weight) order by c.id), '[]'::jsonb),
         coalesce(sum(c.weight), 0)
  into snap, total
  from private.candidates() c;
  if total = 0 then
    perform private.fail(400, 'No hay participantes elegibles');
  end if;
  v_ticket := private.random_below(total);
  select s.id into winner
  from (select c.id, sum(c.weight) over (order by c.id) as upper from private.candidates() c) s
  where v_ticket < s.upper
  order by s.id limit 1;
  insert into private.draws (request_id, prize, winner_id, snapshot, ticket, total_weight, staff_id)
  values (p_request_id, v_prize, winner, snap, v_ticket, total, uid)
  returning id into did;
  perform private.log(uid, 'raffle.drawn', did);
  return private.draw_json(did);
end $$;

create function public.raffle_audit(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare snap jsonb;
begin
  perform private.staff_id(true);
  select d.snapshot into snap from private.draws d where d.id = p_id;
  if snap is null then
    perform private.fail(404, 'Sorteo no encontrado');
  end if;
  return private.draw_json(p_id) || jsonb_build_object(
    'snapshot', snap,
    'rule', '1 + PITs distintos sin Refuel; solo opt-in; excluye ganadores anteriores',
    'algorithm', 'pgcrypto gen_random_bytes con muestreo por rechazo sobre totalWeight; intervalos ponderados ordenados por UUID; ticket base 0'
  );
end $$;

create function public.export_participants() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := private.staff_id(true);
begin
  perform private.log(uid, 'participants.exported');
  return coalesce((
    select jsonb_agg(private.participant_json(p.id) order by p.created_at) from private.participants p
  ), '[]'::jsonb);
end $$;

-- Alta de cuentas del equipo: solo con la clave service_role, nunca desde el navegador.
create function public.provision_profile(p_id uuid, p_username text, p_name text, p_role text) returns void
language sql security definer set search_path = '' as $$
  insert into private.profiles (id, username, name, role) values (p_id, lower(p_username), p_name, p_role)
$$;

-- ---------------------------------------------------------------- permisos

do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as signature, p.proname from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in (
        'me', 'touch_login', 'lookup_badge', 'get_participant', 'search_participants',
        'register_participant', 'update_notes', 'add_visit', 'redeem_refuel', 'get_summary',
        'get_raffle', 'draw_raffle', 'raffle_audit', 'export_participants', 'provision_profile'
      )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.signature);
    if fn.proname = 'provision_profile' then
      execute format('grant execute on function %s to service_role', fn.signature);
    else
      execute format('grant execute on function %s to authenticated', fn.signature);
    end if;
  end loop;
end $$;
