-- Zone templates contain only the polygon owner's zones, never their garage or routes.
begin;
alter table public.polygons add column if not exists zone_preset jsonb not null default '[]';
alter table public.polygons add column if not exists is_archived boolean not null default false;
alter table public.workspaces add column if not exists zones_initialized boolean not null default false;
alter table public.polygons add column if not exists preset_revision bigint not null default 1;
alter table public.workspaces add column if not exists preset_revision bigint not null default 0;
alter table public.workspaces add column if not exists registration_status text not null default 'garage' check(registration_status in ('garage','zones','routes','ready'));
-- A user keeps one complete, private project for each polygon.
do $$ begin
 if exists(select 1 from pg_constraint where conrelid='public.workspaces'::regclass and contype='p' and array_length(conkey,1)=1) then
  alter table public.workspaces drop constraint workspaces_pkey;
  alter table public.workspaces add primary key(user_id,polygon_id);
 end if;
end $$;
update public.workspaces w set registration_status=case when p.registration_status='polygon' then 'garage' else p.registration_status end
 from public.profiles p where p.id=w.user_id and p.polygon_id=w.polygon_id;
update public.workspaces w set preset_revision=p.preset_revision from public.polygons p where w.polygon_id=p.id and w.preset_revision=0;

-- Keep existing personal work intact. Seed templates only from their owner's workspace.
update public.workspaces set zones_initialized=true where not zones_initialized and (zones<>'[]'::jsonb or routes<>'[]'::jsonb);
update public.polygons p set zone_preset=w.zones from public.workspaces w
 where w.user_id=p.owner_id and w.polygon_id=p.id and p.zone_preset is distinct from w.zones;

create or replace function roi_private.bump_polygon_preset() returns trigger language plpgsql set search_path='' as $$
begin
 if new.geometry is distinct from old.geometry or new.zone_preset is distinct from old.zone_preset then new.preset_revision:=old.preset_revision+1; end if;
 return new;
end $$;
drop trigger if exists polygon_preset_revision on public.polygons;
create trigger polygon_preset_revision before update on public.polygons for each row execute function roi_private.bump_polygon_preset();
create or replace function roi_private.store_project_stage() returns trigger language plpgsql set search_path='' as $$
begin
 update public.workspaces set registration_status=case when new.registration_status='polygon' then 'garage' else new.registration_status end
 where user_id=new.id and polygon_id=new.polygon_id;
 return new;
end $$;
drop trigger if exists profile_project_stage on public.profiles;
create trigger profile_project_stage after update of polygon_id,registration_status on public.profiles for each row execute function roi_private.store_project_stage();

create or replace function roi_private.load_zone_preset(p_user uuid) returns public.workspaces
language plpgsql set search_path='' as $$
declare ws public.workspaces; polygon public.polygons; result jsonb:='[]'; zone jsonb; point jsonb; points jsonb; ref uuid; mid int;
begin
 select * into ws from public.workspaces where user_id=p_user and polygon_id=(select polygon_id from public.profiles where id=p_user) for update;
 if ws.user_id is null or ws.zones_initialized then return ws; end if;
 select * into polygon from public.polygons where id=ws.polygon_id for update;
 if polygon.zone_preset='[]'::jsonb then return ws; end if;
 if polygon.owner_id=p_user then
  result:=polygon.zone_preset;
 else
  for zone in select value from jsonb_array_elements(polygon.zone_preset) loop
   points:='[]';
   for point in select value from jsonb_array_elements(zone->'points') loop
    ref:=gen_random_uuid();mid:=roi_private.allocate_marker(polygon.id,p_user,'zone',ref);
    points:=points||jsonb_build_array(jsonb_build_object('id',ref,'x',(point->>'x')::float8,'y',(point->>'y')::float8,'markerId',mid));
   end loop;
   result:=result||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'kind',zone->>'kind','name',zone->>'name','points',points));
  end loop;
 end if;
 update public.workspaces set zones=result,zones_initialized=true,preset_revision=polygon.preset_revision,revision=revision+1,updated_at=now()
  where user_id=p_user and polygon_id=ws.polygon_id returning * into ws;
 return ws;
end $$;
revoke all on function roi_private.load_zone_preset(uuid) from public,anon,authenticated;

create or replace function public.get_workspace() returns public.workspaces
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();
begin
 if uid is null then raise exception 'Войдите в аккаунт.'; end if;
 perform 1 from public.profiles where id=uid for update;
 return roi_private.load_zone_preset(uid);
end $$;
revoke all on function public.get_workspace() from public,anon;
grant execute on function public.get_workspace() to authenticated;

create or replace function public.open_polygon(p_polygon uuid,p_reload boolean default false) returns public.profiles
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); result public.profiles; target public.workspaces; polygon public.polygons; reset_zones boolean; next_revision int;
begin
 if uid is null then raise exception 'Войдите в аккаунт.'; end if;
 perform 1 from public.profiles where id=uid for update;
 select * into target from public.workspaces where user_id=uid and polygon_id=p_polygon for update;
 select * into polygon from public.polygons where id=p_polygon for update;
 if polygon.id is null or (polygon.is_archived and (target.user_id is null or p_reload)) then raise exception 'Полигон удалён из пресетов или не найден.'; end if;
 select coalesce(max(revision),0)+1 into next_revision from public.workspaces where user_id=uid;
 reset_zones:=p_reload or (target.user_id is not null and not polygon.is_archived and polygon.owner_id<>uid and target.preset_revision<>polygon.preset_revision);
 if target.user_id is null then
  insert into public.workspaces(user_id,polygon_id,depth,preset_revision,revision) values(uid,p_polygon,jsonb_build_object('version',1,'width',1000,'height',700,'cols',20,'rows',14,'unit','условные единицы','cells',to_jsonb(array_fill(0,array[280]))),polygon.preset_revision,next_revision) returning * into target;
 else
  update public.workspaces set revision=next_revision,updated_at=now() where user_id=uid and polygon_id=p_polygon returning * into target;
 end if;
 if reset_zones then
  delete from public.marker_reservations where polygon_id=p_polygon and owner_id=uid and purpose='zone';
  update public.workspaces set zones='[]',routes='[]',zones_initialized=false,preset_revision=polygon.preset_revision,registration_status='garage'
   where user_id=uid and polygon_id=p_polygon returning * into target;
 end if;
 update public.profiles set polygon_id=p_polygon,registration_status=target.registration_status where id=uid returning * into result;
 perform roi_private.load_zone_preset(uid);
 return result;
end $$;
revoke all on function public.open_polygon(uuid,boolean) from public,anon;
grant execute on function public.open_polygon(uuid,boolean) to authenticated;
create or replace function public.select_polygon(p_polygon uuid) returns public.profiles
language sql security definer set search_path='' as $$select public.open_polygon(p_polygon,false)$$;
revoke all on function public.select_polygon(uuid) from public,anon;
grant execute on function public.select_polygon(uuid) to authenticated;

create or replace function public.update_polygon(p_id uuid,p_name text,p_points jsonb,p_previous jsonb) returns public.polygons
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); polygon public.polygons; result_points jsonb:='[]'; point jsonb; refs uuid[]:=array[]::uuid[]; mid int;
begin
 if uid is null then raise exception 'Войдите в аккаунт.'; end if;
 perform 1 from public.profiles where id=uid for update;
 select * into polygon from public.polygons where id=p_id for update;
 if polygon.id is null or polygon.owner_id<>uid then raise exception 'Изменять оригинал может только владелец полигона.'; end if;
 if polygon.is_archived then raise exception 'Полигон удалён из пресетов. Создайте свою копию.'; end if;
 if polygon.geometry is distinct from p_previous then raise exception 'Граница изменена в другой вкладке. Обновите страницу.'; end if;
 if length(btrim(coalesce(p_name,''))) not between 1 and 100 then raise exception 'Введите название полигона: от 1 до 100 символов.'; end if;
 if not roi_private.shape_ok(p_points) then raise exception 'Нужен простой многоугольник без самопересечений.'; end if;
 if jsonb_array_length(p_points)>37 then raise exception 'Максимум 37 вершин границы.'; end if;
 if exists(select 1 from jsonb_array_elements(polygon.zone_preset) z where not roi_private.path_ok(z->'points',p_points,null,1000,1000,true)) then
  raise exception 'Часть сохранённых зон оказалась за новой границей. Сначала измените или удалите эти зоны и сохраните их.';
 end if;
 for point in select value from jsonb_array_elements(p_points) loop
  if (point->>'id')::uuid is null or (point->>'id')::uuid=any(refs) then raise exception 'Повторные или некорректные вершины.'; end if;
  refs:=array_append(refs,(point->>'id')::uuid);
 end loop;
 delete from public.marker_reservations where polygon_id=p_id and purpose='boundary' and not(reference_id=any(refs));
 for point in select value from jsonb_array_elements(p_points) loop
  mid:=roi_private.allocate_marker(p_id,uid,'boundary',(point->>'id')::uuid);
  result_points:=result_points||jsonb_build_array(jsonb_build_object('id',(point->>'id')::uuid,'x',(point->>'x')::float8,'y',(point->>'y')::float8,'markerId',mid));
 end loop;
 update public.polygons set name=btrim(p_name),geometry=jsonb_build_object('width',1000,'height',700,'dictionary','DICT_4X4_50','points',result_points) where id=p_id returning * into polygon;
 return polygon;
end $$;
revoke all on function public.update_polygon(uuid,text,jsonb,jsonb) from public,anon;
grant execute on function public.update_polygon(uuid,text,jsonb,jsonb) to authenticated;

create or replace function public.delete_polygon_preset(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 update public.polygons set is_archived=true where id=p_id and owner_id=auth.uid() and not is_archived;
 if not found then raise exception 'Удалять пресет может только его владелец.'; end if;
 -- Existing users keep their working copies and personal garages.
end $$;
revoke all on function public.delete_polygon_preset(uuid) from public,anon;
grant execute on function public.delete_polygon_preset(uuid) to authenticated;

create or replace function public.save_workspace(p_zones jsonb,p_routes jsonb,p_depth jsonb,p_revision int) returns public.workspaces
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); ws public.workspaces; boundary jsonb; zone jsonb; route jsonb; point jsonb; saved_zones jsonb:='[]'; points jsonb; mid int; cols int; rows int; used_refs uuid[]:=array[]::uuid[];
begin
 perform 1 from public.profiles where id=uid for update;
 select * into ws from public.workspaces where user_id=uid and polygon_id=(select polygon_id from public.profiles where id=uid) for update;
 if not found then raise exception 'Сначала выберите полигон.'; end if;
 if p_revision is null or p_revision<>ws.revision then raise exception 'Данные изменены в другой вкладке. Обновите страницу перед сохранением.'; end if;
 if jsonb_typeof(p_zones) is distinct from 'array' or jsonb_typeof(p_routes) is distinct from 'array' then raise exception 'Некорректные зоны или траектории.'; end if;
 if jsonb_array_length(p_zones)>30 or jsonb_array_length(p_routes)>30 then raise exception 'Максимум 30 зон и 30 траекторий.'; end if;
 if (select count(*) from jsonb_array_elements(p_zones) z where z->>'kind'='transport')>1 then raise exception 'В проекте полигона допускается только одна транспортная зона.'; end if;
 cols:=(p_depth->>'cols')::int; rows:=(p_depth->>'rows')::int;
 if (p_depth->>'version')::int is distinct from 1 or (p_depth->>'width')::int is distinct from 1000 or (p_depth->>'height')::int is distinct from 700 or cols is null or rows is null or cols not between 2 and 100 or rows not between 2 and 100 or jsonb_typeof(p_depth->'cells') is distinct from 'array' then raise exception 'Некорректный формат карты глубины.'; end if;
 if jsonb_array_length(p_depth->'cells')<>cols*rows or exists(select 1 from jsonb_array_elements(p_depth->'cells') v where v<>'null'::jsonb and (jsonb_typeof(v)<>'number' or not ((v::text)::numeric between 0 and 1000))) then raise exception 'Некорректные значения глубины.'; end if;
 select geometry->'points' into boundary from public.polygons where id=ws.polygon_id for update;
 for zone in select value from jsonb_array_elements(p_zones) loop
  if zone->>'kind' not in ('warehouse','charging','mining','transport') or zone->>'kind' is null or not roi_private.shape_ok(zone->'points') then raise exception 'Некорректная зона.'; end if;
  if length(btrim(coalesce(zone->>'name',''))) not between 1 and 100 or not roi_private.path_ok(zone->'points',boundary,null,1000,1000,true) then raise exception 'Зона должна находиться внутри полигона и иметь имя.'; end if;
  for point in select value from jsonb_array_elements(zone->'points') loop
   if (point->>'id')::uuid=any(used_refs) then raise exception 'Повторные вершины зон.'; end if;
   used_refs:=array_append(used_refs,(point->>'id')::uuid);
  end loop;
 end loop;
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
 update public.workspaces set zones=saved_zones,zones_initialized=true,routes=p_routes,depth=p_depth,revision=revision+1,updated_at=now() where user_id=uid and polygon_id=ws.polygon_id returning * into ws;
 -- Only the polygon owner can publish the preset; private equipment/routes/depth never enter it.
 update public.polygons set zone_preset=saved_zones where id=ws.polygon_id and owner_id=uid and not is_archived and zone_preset is distinct from saved_zones;
 if exists(select 1 from public.polygons where id=ws.polygon_id and owner_id=uid) then
  update public.workspaces set preset_revision=(select preset_revision from public.polygons where id=ws.polygon_id) where user_id=uid and polygon_id=ws.polygon_id returning * into ws;
 end if;
 update public.profiles set registration_status=case when registration_status='ready' then 'routes' else registration_status end where id=uid;
 return ws;
end $$;
revoke all on function public.save_workspace(jsonb,jsonb,jsonb,int) from public,anon;
grant execute on function public.save_workspace(jsonb,jsonb,jsonb,int) to authenticated;
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
  select * into ws from public.workspaces where user_id=profile.id and polygon_id=profile.polygon_id;
  if (select count(*) from jsonb_array_elements(ws.zones) z where z->>'kind'='transport')>1 then raise exception 'В проекте полигона допускается только одна транспортная зона.'; end if;
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
      not roi_private.within_transport(route->'points',ws.zones) or
      not roi_private.route_clearance_ok(route,boundary,ws.zones) or
      not roi_private.vehicle_route_ok(route,(select type from public.equipment where id=(route->>'equipmentId')::uuid),ws.zones) then raise exception 'Траектория недопустима: проверьте назначение техники, её базу, транспортную зону, отступы от границ и арукомаркеров, препятствия и глубины.'; end if;
   end loop;
   profile.registration_status:='ready';
  end if;
 else raise exception 'Выберите полигон кнопкой Далее.';
 end if;
 update public.profiles set registration_status=profile.registration_status where id=profile.id returning * into profile;
 return profile;
end $$;


create or replace function public.save_polygon_workspace(p_polygon uuid,p_zones jsonb,p_routes jsonb,p_depth jsonb,p_revision int) returns public.workspaces
language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.profiles where id=auth.uid() and polygon_id=p_polygon for update;
 if not found then raise exception 'Активный полигон изменён в другой вкладке. Обновите страницу перед сохранением.'; end if;
 return public.save_workspace(p_zones,p_routes,p_depth,p_revision);
end $$;
revoke all on function public.save_polygon_workspace(uuid,jsonb,jsonb,jsonb,int) from public,anon;
grant execute on function public.save_polygon_workspace(uuid,jsonb,jsonb,jsonb,int) to authenticated;
create or replace function public.create_polygon_equipment(p_polygon uuid,p_name text,p_type text,p_marker_id int default null) returns public.equipment
language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.profiles where id=auth.uid() and polygon_id=p_polygon for update;
 if not found then raise exception 'Активный полигон изменён в другой вкладке. Обновите страницу перед добавлением техники.'; end if;
 return public.create_equipment_with_id(p_name,p_type,p_marker_id);
end $$;
revoke all on function public.create_polygon_equipment(uuid,text,text,int) from public,anon;
grant execute on function public.create_polygon_equipment(uuid,text,text,int) to authenticated;
create or replace function public.delete_equipment(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare item public.equipment;
begin
 perform 1 from public.profiles where id=auth.uid() for update;
 delete from public.equipment where id=p_id and user_id=auth.uid() returning * into item;
 if item.id is null then raise exception 'Техника не найдена.'; end if;
 delete from public.marker_reservations where reference_id=item.id and owner_id=auth.uid() and purpose='equipment';
 update public.workspaces set routes=coalesce((select jsonb_agg(r) from jsonb_array_elements(routes) r where r->>'equipmentId'<>p_id::text),'[]'),revision=revision+1,registration_status='garage'
  where user_id=auth.uid() and polygon_id=item.polygon_id;
 update public.profiles set registration_status='garage' where id=auth.uid() and polygon_id=item.polygon_id;
end $$;
revoke all on function public.delete_equipment(uuid) from public,anon;
grant execute on function public.delete_equipment(uuid) to authenticated;
revoke all on function public.advance_setup() from public,anon;
grant execute on function public.advance_setup() to authenticated;
revoke all on all functions in schema roi_private from public,anon,authenticated;

commit;
