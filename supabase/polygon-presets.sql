-- Zone templates contain only the polygon owner's zones, never their garage or routes.
begin;
alter table public.polygons add column if not exists zone_preset jsonb not null default '[]';
alter table public.workspaces add column if not exists zones_initialized boolean not null default false;

-- Keep existing personal work intact. Seed templates only from their owner's workspace.
update public.workspaces set zones_initialized=true where not zones_initialized and (zones<>'[]'::jsonb or routes<>'[]'::jsonb);
update public.polygons p set zone_preset=w.zones from public.workspaces w
 where w.user_id=p.owner_id and w.polygon_id=p.id and p.zone_preset is distinct from w.zones;

create or replace function roi_private.load_zone_preset(p_user uuid) returns public.workspaces
language plpgsql set search_path='' as $$
declare ws public.workspaces; polygon public.polygons; result jsonb:='[]'; zone jsonb; point jsonb; points jsonb; ref uuid; mid int;
begin
 select * into ws from public.workspaces where user_id=p_user for update;
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
 update public.workspaces set zones=result,zones_initialized=true,revision=revision+1,updated_at=now()
  where user_id=p_user returning * into ws;
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

create or replace function public.select_polygon(p_polygon uuid) returns public.profiles
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); result public.profiles; old_polygon uuid;
begin
 if uid is null then raise exception 'Войдите в аккаунт.'; end if;
 select polygon_id into old_polygon from public.profiles where id=uid for update;
 perform 1 from public.polygons where id=p_polygon;if not found then raise exception 'Полигон не найден.'; end if;
 if old_polygon is distinct from p_polygon then
  -- Printed owner-template IDs stay reserved even when the owner selects another polygon.
  delete from public.marker_reservations r where r.owner_id=uid and r.purpose='zone'
   and not exists(select 1 from public.polygons p cross join lateral jsonb_array_elements(p.zone_preset) z
    cross join lateral jsonb_array_elements(z->'points') point
    where p.id=r.polygon_id and p.owner_id=uid and point->>'id'=r.reference_id::text);
  insert into public.workspaces(user_id,polygon_id,depth) values(uid,p_polygon,jsonb_build_object('version',1,'width',1000,'height',700,'cols',20,'rows',14,'unit','условные единицы','cells',to_jsonb(array_fill(0,array[280]))))
   on conflict(user_id) do update set polygon_id=excluded.polygon_id,zones='[]',routes='[]',zones_initialized=false,depth=excluded.depth,revision=public.workspaces.revision+1,updated_at=now();
 end if;
 perform roi_private.load_zone_preset(uid);
 update public.profiles set polygon_id=p_polygon,registration_status='garage' where id=uid returning * into result;
 return result;
end $$;
revoke all on function public.select_polygon(uuid) from public,anon;
grant execute on function public.select_polygon(uuid) to authenticated;

create or replace function public.save_workspace(p_zones jsonb,p_routes jsonb,p_depth jsonb,p_revision int) returns public.workspaces
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); ws public.workspaces; boundary jsonb; zone jsonb; route jsonb; point jsonb; saved_zones jsonb:='[]'; points jsonb; mid int; cols int; rows int; used_refs uuid[]:=array[]::uuid[];
begin
 perform 1 from public.profiles where id=uid for update;
 select * into ws from public.workspaces where user_id=uid for update;
 if not found then raise exception 'Сначала выберите полигон.'; end if;
 if p_revision is null or p_revision<>ws.revision then raise exception 'Данные изменены в другой вкладке. Обновите страницу перед сохранением.'; end if;
 if jsonb_typeof(p_zones) is distinct from 'array' or jsonb_typeof(p_routes) is distinct from 'array' then raise exception 'Некорректные зоны или траектории.'; end if;
 if jsonb_array_length(p_zones)>30 or jsonb_array_length(p_routes)>30 then raise exception 'Максимум 30 зон и 30 траекторий.'; end if;
 if (select count(*) from jsonb_array_elements(p_zones) z where z->>'kind'='transport')>1 then raise exception 'В проекте полигона допускается только одна транспортная зона.'; end if;
 cols:=(p_depth->>'cols')::int; rows:=(p_depth->>'rows')::int;
 if (p_depth->>'version')::int is distinct from 1 or (p_depth->>'width')::int is distinct from 1000 or (p_depth->>'height')::int is distinct from 700 or cols is null or rows is null or cols not between 2 and 100 or rows not between 2 and 100 or jsonb_typeof(p_depth->'cells') is distinct from 'array' then raise exception 'Некорректный формат карты глубины.'; end if;
 if jsonb_array_length(p_depth->'cells')<>cols*rows or exists(select 1 from jsonb_array_elements(p_depth->'cells') v where v<>'null'::jsonb and (jsonb_typeof(v)<>'number' or not ((v::text)::numeric between 0 and 1000))) then raise exception 'Некорректные значения глубины.'; end if;
 select geometry->'points' into boundary from public.polygons where id=ws.polygon_id;
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
 update public.workspaces set zones=saved_zones,zones_initialized=true,routes=p_routes,depth=p_depth,revision=revision+1,updated_at=now() where user_id=uid returning * into ws;
 -- Only the polygon owner can publish the preset; private equipment/routes/depth never enter it.
 update public.polygons set zone_preset=saved_zones where id=ws.polygon_id and owner_id=uid and zone_preset is distinct from saved_zones;
 update public.profiles set registration_status=case when registration_status='ready' then 'routes' else registration_status end where id=uid;
 return ws;
end $$;
revoke all on function public.save_workspace(jsonb,jsonb,jsonb,int) from public,anon;
grant execute on function public.save_workspace(jsonb,jsonb,jsonb,int) to authenticated;
commit;
