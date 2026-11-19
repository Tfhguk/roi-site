-- Run once in the SQL Editor of your Supabase project.
begin;
create schema if not exists roi_private;
revoke all on schema roi_private from public;

create or replace function roi_private.cross2(a jsonb,b jsonb,c jsonb) returns double precision
language sql immutable set search_path='' as $$
 select ((b->>'x')::float8-(a->>'x')::float8)*((c->>'y')::float8-(a->>'y')::float8)
      - ((b->>'y')::float8-(a->>'y')::float8)*((c->>'x')::float8-(a->>'x')::float8)
$$;
create or replace function roi_private.on_segment(a jsonb,b jsonb,p jsonb) returns boolean
language sql immutable set search_path='' as $$
 select abs(roi_private.cross2(a,b,p))<0.0000001
 and (p->>'x')::float8 between least((a->>'x')::float8,(b->>'x')::float8)-0.0000001 and greatest((a->>'x')::float8,(b->>'x')::float8)+0.0000001
 and (p->>'y')::float8 between least((a->>'y')::float8,(b->>'y')::float8)-0.0000001 and greatest((a->>'y')::float8,(b->>'y')::float8)+0.0000001
$$;
create or replace function roi_private.shape_ok(points jsonb, closed boolean default true) returns boolean
language plpgsql immutable set search_path='' as $$
declare n int; edges int; i int; j int; p jsonb; a jsonb; b jsonb; c jsonb; d jsonb; total float8:=0;
begin
 if jsonb_typeof(points) is distinct from 'array' then return false; end if;
 n:=jsonb_array_length(points); if n<(case when closed then 3 else 2 end) or n>200 then return false; end if;
 for i in 0..n-1 loop
  p:=points->i;
  if jsonb_typeof(p->'x') is distinct from 'number' or jsonb_typeof(p->'y') is distinct from 'number' then return false; end if;
  if not ((p->>'x')::float8 between 0 and 1000 and (p->>'y')::float8 between 0 and 700) then return false; end if;
  for j in 0..i-1 loop
   if power((p->>'x')::float8-(points->j->>'x')::float8,2)+power((p->>'y')::float8-(points->j->>'y')::float8,2)<0.01 then return false; end if;
  end loop;
  if closed then a:=points->((i+1)%n); total:=total+(p->>'x')::float8*(a->>'y')::float8-(a->>'x')::float8*(p->>'y')::float8; end if;
 end loop;
 if closed and abs(total)<=2 then return false; end if;
 edges:=case when closed then n else n-1 end;
 for i in 0..edges-1 loop
  a:=points->i; b:=points->((i+1)%n);
  for j in i+2..edges-1 loop
   if closed and i=0 and j=edges-1 then continue; end if;
   c:=points->j; d:=points->((j+1)%n);
   if (roi_private.cross2(a,b,c)*roi_private.cross2(a,b,d)<0 and roi_private.cross2(c,d,a)*roi_private.cross2(c,d,b)<0)
    or roi_private.on_segment(a,b,c) or roi_private.on_segment(a,b,d) or roi_private.on_segment(c,d,a) or roi_private.on_segment(c,d,b) then return false; end if;
  end loop;
  if closed or i<n-2 then
   c:=points->((i+2)%n);
   if abs(roi_private.cross2(a,b,c))<0.0000001 and
    (((b->>'x')::float8-(a->>'x')::float8)*((c->>'x')::float8-(b->>'x')::float8)+
     ((b->>'y')::float8-(a->>'y')::float8)*((c->>'y')::float8-(b->>'y')::float8))<=0 then return false; end if;
  end if;
 end loop;
 return true;
exception when others then return false;
end $$;

create or replace function roi_private.inside(p jsonb, points jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare a jsonb; b jsonb; yes boolean:=false; i int; n int:=jsonb_array_length(points); x float8:=(p->>'x')::float8; y float8:=(p->>'y')::float8;
begin
 for i in 0..n-1 loop
  a:=points->i; b:=points->((i+1)%n);
  if roi_private.on_segment(a,b,p) then return true; end if;
  if ((a->>'y')::float8>y)<>((b->>'y')::float8>y) then
   if x<((b->>'x')::float8-(a->>'x')::float8)*(y-(a->>'y')::float8)/((b->>'y')::float8-(a->>'y')::float8)+(a->>'x')::float8 then yes:=not yes; end if;
  end if;
 end loop;
 return yes;
end $$;

-- Exact segment cuts at polygon edges and depth grid lines.
create or replace function roi_private.path_ok(points jsonb, boundary jsonb, depth jsonb default null, max_depth float8 default 1000, max_slope float8 default 1000, closed boolean default false) returns boolean
language plpgsql immutable set search_path='' as $$
declare i int; j int; k int; a jsonb; b jsonb; c jsonb; d jsonb; ax float8; ay float8; dx float8; dy float8; den float8; t float8; u float8;
 cuts float8[]; samples float8[]; x float8; y float8; col float8; rown float8; cx int; cy int; lo int; hi int; cols int; rows int; v jsonb; current_values float8[]; previous_values float8[]; lowv float8; highv float8;
begin
 for i in 0..jsonb_array_length(points)-(case when closed then 1 else 2 end) loop
  a:=points->i; b:=points->((i+1)%jsonb_array_length(points)); ax:=(a->>'x')::float8; ay:=(a->>'y')::float8; dx:=(b->>'x')::float8-ax; dy:=(b->>'y')::float8-ay; cuts:=array[0::float8,1::float8];
  for j in 0..jsonb_array_length(boundary)-1 loop
   c:=boundary->j; d:=boundary->((j+1)%jsonb_array_length(boundary));
   den:=dx*((d->>'y')::float8-(c->>'y')::float8)-dy*((d->>'x')::float8-(c->>'x')::float8);
   if abs(den)>0.0000001 then
    t:=(((c->>'x')::float8-ax)*((d->>'y')::float8-(c->>'y')::float8)-((c->>'y')::float8-ay)*((d->>'x')::float8-(c->>'x')::float8))/den;
    u:=(((c->>'x')::float8-ax)*dy-((c->>'y')::float8-ay)*dx)/den;
    if t>0 and t<1 and u between 0 and 1 then cuts:=array_append(cuts,t); end if;
   end if;
  end loop;
  if depth is not null then
   cols:=(depth->>'cols')::int; rows:=(depth->>'rows')::int;
   if abs(dx)>0.0000001 then for j in 0..cols loop t:=(j*1000.0/cols-ax)/dx; if t>0 and t<1 then cuts:=array_append(cuts,t); end if; end loop; end if;
   if abs(dy)>0.0000001 then for j in 0..rows loop t:=(j*700.0/rows-ay)/dy; if t>0 and t<1 then cuts:=array_append(cuts,t); end if; end loop; end if;
  end if;
  select array_agg(distinct cut.value order by cut.value) into cuts from unnest(cuts) as cut(value);
  samples:=array[cuts[1]];
  for j in 2..array_length(cuts,1) loop samples:=samples||array[(cuts[j-1]+cuts[j])/2,cuts[j]]; end loop;
  previous_values:=null;
  foreach t in array samples loop
   x:=ax+dx*t; y:=ay+dy*t;
   if not roi_private.inside(jsonb_build_object('x',x,'y',y),boundary) then return false; end if;
   if depth is null then continue; end if;
   col:=x/1000*cols; rown:=y/700*rows; current_values:=array[]::float8[];
   lo:=floor(rown)::int; if abs(rown-round(rown))<0.0000001 then lo:=round(rown)::int-1; end if; hi:=floor(rown)::int;
   for cy in greatest(0,lo)..least(rows-1,hi) loop
    lo:=floor(col)::int; if abs(col-round(col))<0.0000001 then lo:=round(col)::int-1; end if;
    for cx in greatest(0,lo)..least(cols-1,floor(col)::int) loop
     v:=depth->'cells'->(cy*cols+cx);
     if v='null'::jsonb or v is null then return false; end if;
     if (v::text)::float8>max_depth then return false; end if;
     current_values:=array_append(current_values,(v::text)::float8);
    end loop;
   end loop;
   select min(cell.value),max(cell.value) into lowv,highv from unnest(current_values) as cell(value);
   if highv-lowv>max_slope then return false; end if;
   if previous_values is not null and exists(select 1 from unnest(previous_values) as cell(value) where abs(cell.value-lowv)>max_slope or abs(cell.value-highv)>max_slope) then return false; end if;
   previous_values:=current_values;
  end loop;
 end loop;
 return true;
exception when others then return false;
end $$;

create table if not exists public.polygons (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id),
 name text not null check(length(btrim(name)) between 1 and 100),
 geometry jsonb not null, created_at timestamptz not null default now()
);
create table if not exists public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 name text not null check(length(name) between 1 and 100), role text not null default 'operator' check(role in ('operator','master')),
 registration_status text not null default 'polygon' check(registration_status in ('polygon','garage','zones','routes','ready')),
 polygon_id uuid references public.polygons(id), created_at timestamptz not null default now()
);
create table if not exists public.equipment (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 polygon_id uuid not null references public.polygons(id), name text not null check(length(btrim(name)) between 1 and 100),
 type text not null check(type in ('truck','excavator','loader','robot')), marker_id int not null check(marker_id between 0 and 49),
 created_at timestamptz not null default now(), unique(polygon_id,marker_id)
);
create table if not exists public.workspaces (
 user_id uuid primary key references auth.users(id) on delete cascade, polygon_id uuid not null references public.polygons(id),
 zones jsonb not null default '[]', routes jsonb not null default '[]', depth jsonb not null,
 revision int not null default 0, updated_at timestamptz not null default now()
);
create table if not exists public.marker_reservations (
 polygon_id uuid not null references public.polygons(id) on delete cascade, marker_id int not null check(marker_id between 0 and 49),
 owner_id uuid not null references auth.users(id), purpose text not null check(purpose in ('boundary','zone','equipment')), reference_id uuid not null,
 primary key(polygon_id,marker_id), unique(polygon_id,owner_id,purpose,reference_id)
);
create index if not exists equipment_owner on public.equipment(user_id);
alter table public.polygons enable row level security;
alter table public.profiles enable row level security;
alter table public.equipment enable row level security;
alter table public.workspaces enable row level security;
alter table public.marker_reservations enable row level security;
drop policy if exists polygons_read on public.polygons;
create policy polygons_read on public.polygons for select to authenticated using(true);
drop policy if exists profiles_own on public.profiles;
create policy profiles_own on public.profiles for select to authenticated using(id=(select auth.uid()));
drop policy if exists equipment_own on public.equipment;
create policy equipment_own on public.equipment for select to authenticated using(user_id=(select auth.uid()));
drop policy if exists workspace_own on public.workspaces;
create policy workspace_own on public.workspaces for select to authenticated using(user_id=(select auth.uid()));
drop policy if exists markers_read on public.marker_reservations;
create policy markers_read on public.marker_reservations for select to authenticated using(true);
revoke all on public.polygons,public.profiles,public.equipment,public.workspaces,public.marker_reservations from anon,authenticated;
grant select on public.polygons,public.profiles,public.equipment,public.workspaces,public.marker_reservations to authenticated;

create or replace function roi_private.new_profile() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.profiles(id,name,role) values(new.id,left(coalesce(nullif(btrim(new.raw_user_meta_data->>'name'),''),'Пользователь'),100),
  case when new.raw_user_meta_data->>'role'='master' then 'master' else 'operator' end);
 return new;
end $$;
drop trigger if exists roi_new_user on auth.users;
create trigger roi_new_user after insert on auth.users for each row execute function roi_private.new_profile();
insert into public.profiles(id,name,role) select id,left(coalesce(nullif(raw_user_meta_data->>'name',''),'Пользователь'),100),
 case when raw_user_meta_data->>'role'='master' then 'master' else 'operator' end from auth.users on conflict(id) do nothing;

create or replace function roi_private.allocate_marker(p_polygon uuid,p_owner uuid,p_purpose text,p_reference uuid) returns int
language plpgsql set search_path='' as $$
declare value int;
begin
 perform 1 from public.polygons where id=p_polygon for update;
 select marker_id into value from public.marker_reservations where polygon_id=p_polygon and owner_id=p_owner and purpose=p_purpose and reference_id=p_reference;
 if found then return value; end if;
 select candidate into value from generate_series(0,49) candidate where not exists(select 1 from public.marker_reservations where polygon_id=p_polygon and marker_id=candidate) order by candidate limit 1;
 if value is null then raise exception 'Все 50 ArUCo ID на этом полигоне заняты. Удалите ненужные маркеры или выберите другой полигон.'; end if;
 insert into public.marker_reservations values(p_polygon,value,p_owner,p_purpose,p_reference); return value;
end $$;

create or replace function public.create_polygon(p_name text,p_points jsonb) returns public.polygons
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); result public.polygons; points jsonb:='[]'; p jsonb; mid int;
begin
 if uid is null then raise exception 'Войдите в аккаунт.'; end if;
 if not roi_private.shape_ok(p_points) then raise exception 'Нужен простой многоугольник без самопересечений.'; end if;
 if jsonb_array_length(p_points)>37 then raise exception 'Максимум 37 вершин границы: ещё 13 ArUCo ID нужны для техники и четырёх обязательных зон.'; end if;
 insert into public.polygons(owner_id,name,geometry) values(uid,btrim(p_name),'{}') returning * into result;
 for p in select value from jsonb_array_elements(p_points) loop
  mid:=roi_private.allocate_marker(result.id,uid,'boundary',(p->>'id')::uuid);
  points:=points||jsonb_build_array(jsonb_build_object('id',(p->>'id')::uuid,'x',(p->>'x')::float8,'y',(p->>'y')::float8,'markerId',mid));
 end loop;
 if (select count(distinct value->>'id') from jsonb_array_elements(points))<>jsonb_array_length(points) then raise exception 'Повторные вершины.'; end if;
 update public.polygons set geometry=jsonb_build_object('width',1000,'height',700,'dictionary','DICT_4X4_50','points',points) where id=result.id returning * into result;
 return result;
end $$;

create or replace function public.select_polygon(p_polygon uuid) returns public.profiles
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); result public.profiles; old_polygon uuid;
begin
 if uid is null then raise exception 'Войдите в аккаунт.'; end if;
 select polygon_id into old_polygon from public.profiles where id=uid for update;
 perform 1 from public.polygons where id=p_polygon; if not found then raise exception 'Полигон не найден.'; end if;
 if old_polygon is distinct from p_polygon then
  delete from public.marker_reservations where owner_id=uid and purpose='zone';
  insert into public.workspaces(user_id,polygon_id,depth) values(uid,p_polygon,jsonb_build_object('version',1,'width',1000,'height',700,'cols',20,'rows',14,'unit','условные единицы','cells',to_jsonb(array_fill(0,array[280]))))
   on conflict(user_id) do update set polygon_id=excluded.polygon_id,zones='[]',routes='[]',depth=excluded.depth,revision=public.workspaces.revision+1,updated_at=now();
 end if;
 update public.profiles set polygon_id=p_polygon,registration_status='garage' where id=uid returning * into result;
 return result;
end $$;

create or replace function public.create_equipment(p_name text,p_type text) returns public.equipment
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); pid uuid; eid uuid:=gen_random_uuid(); mid int; result public.equipment;
begin
 select polygon_id into pid from public.profiles where id=uid for update;
 if uid is null or pid is null then raise exception 'Сначала выберите полигон.'; end if;
 mid:=roi_private.allocate_marker(pid,uid,'equipment',eid);
 insert into public.equipment(id,user_id,polygon_id,name,type,marker_id) values(eid,uid,pid,btrim(p_name),p_type,mid) returning * into result;
 return result;
end $$;
create or replace function public.delete_equipment(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare item public.equipment;
begin
 perform 1 from public.profiles where id=auth.uid() for update;
 delete from public.equipment where id=p_id and user_id=auth.uid() returning * into item;
 if item.id is null then raise exception 'Техника не найдена.'; end if;
 delete from public.marker_reservations where reference_id=item.id and owner_id=auth.uid() and purpose='equipment';
 update public.profiles set registration_status='garage' where id=auth.uid();
end $$;

create or replace function public.save_workspace(p_zones jsonb,p_routes jsonb,p_depth jsonb,p_revision int) returns public.workspaces
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); ws public.workspaces; boundary jsonb; zone jsonb; route jsonb; point jsonb; saved_zones jsonb:='[]'; points jsonb; mid int; cols int; rows int; used_refs uuid[]:=array[]::uuid[];
begin
 perform 1 from public.profiles where id=uid for update;
 select * into ws from public.workspaces where user_id=uid for update;
 if not found then raise exception 'Сначала выберите полигон.'; end if;
 if p_revision<>ws.revision then raise exception 'Данные изменены в другой вкладке. Обновите страницу перед сохранением.'; end if;
 if jsonb_typeof(p_zones) is distinct from 'array' or jsonb_typeof(p_routes) is distinct from 'array' then raise exception 'Некорректные зоны или траектории.'; end if;
 if jsonb_array_length(p_zones)>30 or jsonb_array_length(p_routes)>30 then raise exception 'Максимум 30 зон и 30 траекторий.'; end if;
 cols:=(p_depth->>'cols')::int; rows:=(p_depth->>'rows')::int;
 if (p_depth->>'version')::int is distinct from 1 or (p_depth->>'width')::int is distinct from 1000 or (p_depth->>'height')::int is distinct from 700 or cols is null or rows is null or cols not between 2 and 100 or rows not between 2 and 100 or jsonb_typeof(p_depth->'cells') is distinct from 'array' then raise exception 'Некорректный формат карты глубины.'; end if;
 if jsonb_array_length(p_depth->'cells')<>cols*rows or exists(select 1 from jsonb_array_elements(p_depth->'cells') v where v<>'null'::jsonb and (jsonb_typeof(v)<>'number' or not ((v::text)::numeric between 0 and 1000))) then raise exception 'Некорректные значения глубины.'; end if;
 select geometry->'points' into boundary from public.polygons where id=ws.polygon_id;
 for zone in select value from jsonb_array_elements(p_zones) loop
  if zone->>'kind' not in ('warehouse','charging','mining','transport') or zone->>'kind' is null or not roi_private.shape_ok(zone->'points') then raise exception 'Некорректная зона.'; end if;
  if length(btrim(coalesce(zone->>'name',''))) not between 1 and 100 or not roi_private.path_ok(zone->'points',boundary,null,1000,1000,true) then raise exception 'Зона должна находиться внутри полигона и иметь имя.'; end if;
  points:='[]';
  for point in select value from jsonb_array_elements(zone->'points') loop
   if (point->>'id')::uuid=any(used_refs) then raise exception 'Повторные вершины зон.'; end if;
   used_refs:=array_append(used_refs,(point->>'id')::uuid);
  end loop;
 end loop;
 -- Release only deleted vertices; retained vertices keep their printed IDs.
 delete from public.marker_reservations where polygon_id=ws.polygon_id and owner_id=uid and purpose='zone' and not(reference_id=any(used_refs));
 for zone in select value from jsonb_array_elements(p_zones) loop
  points:='[]';
  for point in select value from jsonb_array_elements(zone->'points') loop
   mid:=roi_private.allocate_marker(ws.polygon_id,uid,'zone',(point->>'id')::uuid);
   points:=points||jsonb_build_array(jsonb_build_object('id',(point->>'id')::uuid,'x',(point->>'x')::float8,'y',(point->>'y')::float8,'markerId',mid));
  end loop;
  saved_zones:=saved_zones||jsonb_build_array(jsonb_build_object('id',(zone->>'id')::uuid,'kind',zone->>'kind','name',zone->>'name','points',points));
 end loop;
 for route in select value from jsonb_array_elements(p_routes) loop
  if not roi_private.shape_ok(route->'points',false) or length(btrim(coalesce(route->>'name',''))) not between 1 and 100 then raise exception 'Некорректная траектория.'; end if;
  if not exists(select 1 from public.equipment where id=(route->>'equipmentId')::uuid and user_id=uid and polygon_id=ws.polygon_id) then raise exception 'Выберите свою технику для каждой траектории.'; end if;
  if (route->>'maxDepth')::numeric is null or (route->>'maxSlope')::numeric is null or (route->>'maxDepth')::numeric not between 0 and 1000 or (route->>'maxSlope')::numeric not between 0 and 1000 then raise exception 'Некорректные ограничения глубины.'; end if;
 end loop;
 update public.workspaces set zones=saved_zones,routes=p_routes,depth=p_depth,revision=revision+1,updated_at=now() where user_id=uid returning * into ws;
 -- Saving edited geometry requires rechecking routes before marking ready.
 update public.profiles set registration_status=case when registration_status='ready' then 'routes' else registration_status end where id=uid;
 return ws;
end $$;

-- Check complete segments against the union of all permitted driving areas.
create or replace function roi_private.within_transport(points jsonb,zones jsonb,closed boolean default false) returns boolean
language plpgsql immutable set search_path='' as $$
declare a jsonb; b jsonb; c jsonb; d jsonb; area jsonb; i int; j int; ax float8; ay float8; dx float8; dy float8; den float8; t float8; u float8; cuts float8[]; samples float8[]; sample jsonb;
begin
 if not exists(select 1 from jsonb_array_elements(zones) z where z->>'kind'='transport') then return false; end if;
 for i in 0..jsonb_array_length(points)-(case when closed then 1 else 2 end) loop
  a:=points->i; b:=points->((i+1)%jsonb_array_length(points)); ax:=(a->>'x')::float8; ay:=(a->>'y')::float8; dx:=(b->>'x')::float8-ax; dy:=(b->>'y')::float8-ay; cuts:=array[0::float8,1::float8];
  for area in select z->'points' from jsonb_array_elements(zones) z where z->>'kind'='transport' loop
   for j in 0..jsonb_array_length(area)-1 loop
    c:=area->j; d:=area->((j+1)%jsonb_array_length(area));
    den:=dx*((d->>'y')::float8-(c->>'y')::float8)-dy*((d->>'x')::float8-(c->>'x')::float8);
    if abs(den)>0.0000001 then
     t:=(((c->>'x')::float8-ax)*((d->>'y')::float8-(c->>'y')::float8)-((c->>'y')::float8-ay)*((d->>'x')::float8-(c->>'x')::float8))/den;
     u:=(((c->>'x')::float8-ax)*dy-((c->>'y')::float8-ay)*dx)/den;
     if t>0 and t<1 and u between 0 and 1 then cuts:=array_append(cuts,t); end if;
    end if;
   end loop;
  end loop;
  select array_agg(distinct cut.value order by cut.value) into cuts from unnest(cuts) as cut(value);
  samples:=cuts; for j in 2..array_length(cuts,1) loop samples:=array_append(samples,(cuts[j-1]+cuts[j])/2); end loop;
  foreach t in array samples loop
   sample:=jsonb_build_object('x',ax+dx*t,'y',ay+dy*t);
   if not exists(select 1 from jsonb_array_elements(zones) z where z->>'kind'='transport' and roi_private.inside(sample,z->'points')) then return false; end if;
  end loop;
 end loop;
 return true;
exception when others then return false;
end $$;

create or replace function public.advance_setup() returns public.profiles
language plpgsql security definer set search_path='' as $$
declare profile public.profiles; ws public.workspaces; boundary jsonb; route jsonb; kind text; zone jsonb;
begin
 select * into profile from public.profiles where id=auth.uid() for update;
 if not found then raise exception 'Войдите в аккаунт.'; end if;
 if profile.polygon_id is null then raise exception 'Сначала создайте или выберите полигон.'; end if;
 if not exists(select 1 from public.equipment where user_id=profile.id and polygon_id=profile.polygon_id) then raise exception 'Добавьте хотя бы одну единицу техники.'; end if;
 if profile.registration_status='garage' then profile.registration_status:='zones';
 elsif profile.registration_status in ('zones','routes','ready') then
  select * into ws from public.workspaces where user_id=profile.id;
  foreach kind in array array['warehouse','charging','mining','transport'] loop
   if not exists(select 1 from jsonb_array_elements(ws.zones) z where z->>'kind'=kind) then raise exception 'Создайте все четыре типа зон.'; end if;
  end loop;
  for zone in select value from jsonb_array_elements(ws.zones) where value->>'kind'<>'transport' loop
   if not roi_private.within_transport(zone->'points',ws.zones,true) then raise exception 'Склад, зарядная станция и добыча должны находиться внутри транспортной зоны.'; end if;
  end loop;
  if profile.registration_status='zones' then profile.registration_status:='routes';
  else
   if jsonb_array_length(ws.routes)=0 then raise exception 'Создайте хотя бы одну траекторию.'; end if;
   select geometry->'points' into boundary from public.polygons where id=profile.polygon_id;
   for route in select value from jsonb_array_elements(ws.routes) loop
    if not exists(select 1 from public.equipment where id=(route->>'equipmentId')::uuid and user_id=profile.id and polygon_id=profile.polygon_id) or
      not roi_private.path_ok(route->'points',boundary,ws.depth,(route->>'maxDepth')::float8,(route->>'maxSlope')::float8) or
      not roi_private.within_transport(route->'points',ws.zones) then raise exception 'Траектория недопустима: проверьте технику, транспортную зону, препятствия и глубины.'; end if;
   end loop;
   profile.registration_status:='ready';
  end if;
 else raise exception 'Выберите полигон кнопкой Далее.';
 end if;
 update public.profiles set registration_status=profile.registration_status where id=profile.id returning * into profile;
 return profile;
end $$;

revoke all on all functions in schema roi_private from public,anon,authenticated;
revoke all on function public.create_polygon(text,jsonb),public.select_polygon(uuid),public.create_equipment(text,text),public.delete_equipment(uuid),public.save_workspace(jsonb,jsonb,jsonb,int),public.advance_setup() from public,anon;
grant execute on function public.create_polygon(text,jsonb),public.select_polygon(uuid),public.create_equipment(text,text),public.delete_equipment(uuid),public.save_workspace(jsonb,jsonb,jsonb,int),public.advance_setup() to authenticated;
commit;
